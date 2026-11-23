/**
 * Posts the `queued` GitHub Check Run that gives a PR immediate feedback while
 * the verification job is still sitting in the queue.
 *
 * Contract: `POST /repos/{owner}/{repo}/check-runs` with `status: 'queued'` on
 * the PR head sha (docs/architecture.md, "API & Interface Contracts").
 */

import type { Octokit } from '@octokit/core';

import type { CheckRunInput, CheckRunPoster } from '../domain.js';
import type { InstallationTokenSource } from './octokit.js';

/** Check run name surfaced in the PR checks UI. */
export const CHECK_RUN_NAME = 'DiffProve: Differential Verification';

const CHECK_RUNS_ROUTE = 'POST /repos/{owner}/{repo}/check-runs';

/** Extracts the HTTP status from an Octokit `RequestError`-shaped value. */
function httpStatusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const candidate = error as { status?: unknown; response?: { status?: unknown } };
  const status = candidate.status ?? candidate.response?.status;

  return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
}

/** Posts a `queued` check run for a single repo/commit. */
export function createCheckRunPoster(
  octokit: Octokit,
  authenticator: InstallationTokenSource,
): CheckRunPoster {
  return {
    async postQueuedCheckRun(input: CheckRunInput): Promise<void> {
      if (input.installationId === null) {
        throw new Error('check run requested without installation context');
      }

      const [owner, repo] = input.repoFullName.split('/');
      if (!owner || !repo) {
        throw new Error(`invalid repoFullName: ${input.repoFullName}`);
      }

      const { token } = await authenticator.installation(input.installationId);

      try {
        await octokit.request(CHECK_RUNS_ROUTE, {
          owner,
          repo,
          name: CHECK_RUN_NAME,
          head_sha: input.headSha,
          status: 'queued',
          headers: { authorization: `token ${token}` },
        });
      } catch (error) {
        const status = httpStatusOf(error);
        const statusSuffix = status === undefined ? '' : ` with HTTP ${status}`;
        const message =
          `failed to post queued check run for ${owner}/${repo} at ${input.headSha}` +
          `${statusSuffix}: GitHub check-runs request failed`;

        // Deliberately no `cause`: Octokit's RequestError keeps the outgoing
        // request (including the Authorization header) on the error object, so
        // re-exposing it would leak the installation token into logs
        // (architecture guardrail #2).
        // eslint-disable-next-line preserve-caught-error -- a `cause` here would carry the token
        throw new Error(message);
      }
    },
  };
}
