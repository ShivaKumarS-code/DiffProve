/**
 * Completes the DiffProve check run as `neutral` when a PR changes no tests.
 *
 * Short-circuit (docs/architecture.md, "End-to-End Verification Pipeline"): if
 * no test files were added or modified there is nothing to verify, so the check
 * run created in Phase 1 is completed as `completed`/`neutral` instead of
 * running the differential pipeline. The queued run is located through
 * `GET /repos/{owner}/{repo}/commits/{ref}/check-runs` filtered by name; when
 * it is missing, a completed/neutral run is POSTed instead. Both requests carry
 * structured `output.title` / `output.summary` ("API & Interface Contracts").
 */

import type { Octokit } from '@octokit/core';

import type { CheckRunReporter, NoTestChangesReport } from '../diff/types.js';
import { CHECK_RUN_NAME } from './checks.js';
import type { InstallationTokenSource } from './octokit.js';

const LIST_CHECK_RUNS_ROUTE = 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs';
const PATCH_CHECK_RUN_ROUTE = 'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}';
const CREATE_CHECK_RUN_ROUTE = 'POST /repos/{owner}/{repo}/check-runs';

/** Extracts the HTTP status from an Octokit `RequestError`-shaped value. */
function httpStatusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const candidate = error as { status?: unknown; response?: { status?: unknown } };
  const status = candidate.status ?? candidate.response?.status;

  return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
}

/**
 * Finds the DiffProve check run posted for a commit, by name.
 *
 * Shared by both completion paths — `reportNoTestChanges` below and the
 * differential `reportVerdict` in `src/github/verdict-report.ts` — so they
 * locate the queued Phase 1 run identically. Resolves null when no run on the
 * commit carries `CHECK_RUN_NAME`.
 *
 * Request failures are deliberately not wrapped here: each caller owns the
 * token-free error message for its own operation, and letting the error escape
 * keeps a single wrapping layer (no duplicated HTTP-status suffixes).
 */
export async function findDiffProveCheckRun(
  octokit: Octokit,
  input: { owner: string; repo: string; ref: string; headers: Record<string, string> },
): Promise<{ id: number } | null> {
  const listed = await octokit.request(LIST_CHECK_RUNS_ROUTE, {
    owner: input.owner,
    repo: input.repo,
    ref: input.ref,
    headers: input.headers,
  });

  // First match wins: Phase 1 posts at most one run under this name per head
  // commit, so duplicates would only come from outside the App.
  const queued = listed.data.check_runs.find((checkRun) => checkRun.name === CHECK_RUN_NAME);

  return queued ? { id: Number(queued.id) } : null;
}

/**
 * Builds the `CheckRunReporter`.
 *
 * The transport is auth-less (see `src/github/octokit.ts`), so the installation
 * token is attached per request here. Guardrail #2: the token is never logged
 * and never attached to a thrown error.
 */
export function createCheckRunReporter(
  octokit: Octokit,
  authenticator: InstallationTokenSource,
): CheckRunReporter {
  return {
    async reportNoTestChanges(report: NoTestChangesReport): Promise<void> {
      const [owner, repo] = report.repoFullName.split('/');
      if (!owner || !repo) {
        throw new Error(`invalid repoFullName: ${report.repoFullName}`);
      }

      const { token } = await authenticator.installation(report.installationId);
      const headers = { authorization: `token ${token}` };
      const output = { title: report.title, summary: report.summary };

      try {
        const queued = await findDiffProveCheckRun(octokit, {
          owner,
          repo,
          ref: report.headSha,
          headers,
        });

        if (queued) {
          await octokit.request(PATCH_CHECK_RUN_ROUTE, {
            owner,
            repo,
            check_run_id: queued.id,
            status: 'completed',
            conclusion: 'neutral',
            output,
            headers,
          });
          return;
        }

        await octokit.request(CREATE_CHECK_RUN_ROUTE, {
          owner,
          repo,
          name: CHECK_RUN_NAME,
          head_sha: report.headSha,
          status: 'completed',
          conclusion: 'neutral',
          output,
          headers,
        });
      } catch (error) {
        const status = httpStatusOf(error);
        const statusSuffix = status === undefined ? '' : ` with HTTP ${status}`;
        const message =
          `failed to complete DiffProve check run as neutral for ${owner}/${repo}` +
          ` at ${report.headSha}${statusSuffix}: GitHub check-runs request failed`;

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
