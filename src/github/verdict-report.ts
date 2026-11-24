/**
 * Completes the DiffProve check run with the Run A / Run B verdict.
 *
 * Contract (docs/architecture.md, "End-to-End Verification Pipeline" step 6 and
 * "API & Interface Contracts"): the worker finds the check run it posted for the
 * head commit and completes it through
 * `PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}`, or — when the queued
 * run is missing — posts a finished run through
 * `POST /repos/{owner}/{repo}/check-runs`.
 *
 * This is the BASIC Phase 3 completion: status/conclusion plus a plain
 * `output.title` / `output.summary` pair. The rich Markdown summary with clipped
 * Run A / Run B log excerpts is Phase 4; `durationMs` and `verdict` are carried
 * on the input so that renderer can use them without changing this port.
 */

import type { Octokit } from '@octokit/core';

import type { VerdictReportInput, VerdictReporter } from '../runner/types.js';
import { CHECK_RUN_NAME } from './checks.js';
import { findDiffProveCheckRun } from './check-runs.js';
import type { InstallationTokenSource } from './octokit.js';

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
 * Builds the `VerdictReporter`.
 *
 * The transport is auth-less (see `src/github/octokit.ts`), so the installation
 * token is attached per request here. Guardrail #2: the token is never logged
 * and never attached to a thrown error.
 */
export function createVerdictReporter(
  octokit: Octokit,
  authenticator: InstallationTokenSource,
): VerdictReporter {
  return {
    async reportVerdict(report: VerdictReportInput): Promise<void> {
      const [owner, repo] = report.repoFullName.split('/');
      if (!owner || !repo) {
        throw new Error(`invalid repoFullName: ${report.repoFullName}`);
      }

      const { token } = await authenticator.installation(report.installationId);
      const headers = { authorization: `token ${token}` };
      const output = { title: report.title, summary: report.summary };

      try {
        const existing = await findDiffProveCheckRun(octokit, {
          owner,
          repo,
          ref: report.headSha,
          headers,
        });

        if (existing) {
          await octokit.request(PATCH_CHECK_RUN_ROUTE, {
            owner,
            repo,
            check_run_id: existing.id,
            status: 'completed',
            conclusion: report.conclusion,
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
          conclusion: report.conclusion,
          output,
          headers,
        });
      } catch (error) {
        const status = httpStatusOf(error);
        const statusSuffix = status === undefined ? '' : ` with HTTP ${status}`;
        const message =
          `failed to report ${report.verdict} verdict for ${owner}/${repo}` +
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
