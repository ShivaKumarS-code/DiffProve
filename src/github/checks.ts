/** Worker-owned GitHub Checks lifecycle. */
import type { Octokit } from '@octokit/core';

import { type VerificationChecks, type VerificationJob, verificationKey } from '../domain.js';
import type { InstallationTokenSource } from './octokit.js';

export const CHECK_RUN_NAME = 'DiffProve: Differential Verification';
const PATCH_CHECK_RUN_ROUTE = 'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}';
const LIST_CHECK_RUNS_ROUTE = 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs';
const GET_CHECK_RUN_ROUTE = 'GET /repos/{owner}/{repo}/check-runs/{check_run_id}';
const CREATE_CHECK_RUN_ROUTE = 'POST /repos/{owner}/{repo}/check-runs';

interface CheckScope {
  owner: string;
  repo: string;
  headers: { authorization: string };
}

interface CheckCompletion {
  conclusion: 'success' | 'failure' | 'neutral';
  output: { title: string; summary: string };
}

const EXHAUSTED_CHECK = {
  conclusion: 'neutral',
  output: {
    title: 'Differential verification could not complete',
    summary: 'DiffProve could not finish verification after retries. No test verdict is available.',
  },
} satisfies CheckCompletion;

/** Preserve a completed outcome after an ambiguous PATCH or a later history-write failure. */
export async function completeCheckRun(
  octokit: Octokit,
  scope: CheckScope,
  checkRunId: number,
  completion: CheckCompletion,
): Promise<void> {
  const target = { ...scope, check_run_id: checkRunId };
  const { data } = await octokit.request(GET_CHECK_RUN_ROUTE, target);
  if (data.status === 'completed') {
    return;
  }
  // GitHub offers no conditional PATCH: this protects sequential retries but
  // cannot exclude another writer racing between the read and the update.
  await octokit.request(PATCH_CHECK_RUN_ROUTE, { ...target, status: 'completed', ...completion });
}

function toCheckId(value: number | bigint): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error('GitHub returned an invalid check run ID');
  }
  return id;
}

/** Strip Octokit and installation-auth errors, which can retain credentials. */
export async function withCheckRequest<T>(
  input: Pick<VerificationJob, 'repoFullName' | 'headSha' | 'installationId'>,
  authenticator: InstallationTokenSource,
  operation: string,
  request: (scope: CheckScope) => Promise<T>,
): Promise<T> {
  if (input.installationId === null) {
    throw new Error('check run requested without installation context');
  }
  const [owner, repo, rest] = input.repoFullName.split('/');
  if (!owner || !repo || rest !== undefined) {
    throw new Error(`invalid repoFullName: ${input.repoFullName}`);
  }

  try {
    const { token } = await authenticator.installation(input.installationId);
    return await request({ owner, repo, headers: { authorization: `token ${token}` } });
  } catch (error) {
    const candidate = error as { status?: unknown; response?: { status?: unknown } } | null;
    const status = candidate?.status ?? candidate?.response?.status;
    const suffix = typeof status === 'number' && Number.isFinite(status) ? ` with HTTP ${status}` : '';
    // eslint-disable-next-line preserve-caught-error -- a cause could retain credentials
    throw new Error(`failed to ${operation} for ${owner}/${repo} at ${input.headSha}${suffix}`);
  }
}

/**
 * BullMQ dedupes enqueueing a retained job. Retries can recover a lost POST
 * response or job-data write by external_id, but GitHub does not enforce its
 * uniqueness. A lost worker lock, independent queues, or a legacy job with the
 * old queue ID can race the list/POST. Checks with no external_id cannot safely
 * be adopted by name. Redis and GitHub do not share an atomic transaction.
 */
export function createVerificationChecks(
  octokit: Octokit,
  authenticator: InstallationTokenSource,
  appId: number,
): VerificationChecks {
  async function findCheckId(
    scope: CheckScope,
    headSha: string,
    externalId: string,
  ): Promise<number | undefined> {
    for (let page = 1; ; page += 1) {
      const { data, headers } = await octokit.request(LIST_CHECK_RUNS_ROUTE, {
        ...scope,
        ref: headSha,
        app_id: appId,
        filter: 'all',
        per_page: 100,
        page,
      });
      const match = data.check_runs.find(
        (check) => Number(check.app?.id) === appId && check.external_id === externalId,
      );
      if (match !== undefined) {
        return toCheckId(match.id);
      }
      if (!/;\s*rel="next"/.test(headers?.link ?? '')) {
        return undefined;
      }
    }
  }

  return {
    async ensureQueuedCheckRun(job) {
      return withCheckRequest(job, authenticator, 'ensure queued check run', async (scope) => {
        const externalId = verificationKey(job);
        const existing = await findCheckId(scope, job.headSha, externalId);
        if (existing !== undefined) {
          return existing;
        }
        const { data } = await octokit.request(CREATE_CHECK_RUN_ROUTE, {
          ...scope,
          name: CHECK_RUN_NAME,
          head_sha: job.headSha,
          external_id: externalId,
          status: 'queued',
        });
        return toCheckId(data.id);
      });
    },

    async reportExhaustedFailure(job) {
      return withCheckRequest(job, authenticator, 'report exhausted verification', async (scope) => {
        const externalId = verificationKey(job);
        const id = job.checkRunId ?? await findCheckId(scope, job.headSha, externalId);
        if (id === undefined) {
          // If every attempt failed before creating a check, publish a completed
          // result directly rather than risk leaving a second queued check.
          await octokit.request(CREATE_CHECK_RUN_ROUTE, {
            ...scope,
            name: CHECK_RUN_NAME,
            head_sha: job.headSha,
            external_id: externalId,
            status: 'completed',
            ...EXHAUSTED_CHECK,
          });
          return;
        }

        await completeCheckRun(octokit, scope, id, EXHAUSTED_CHECK);
      });
    },
  };
}
