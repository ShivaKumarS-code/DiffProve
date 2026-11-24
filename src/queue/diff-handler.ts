/**
 * Diff-splitting verification handler (Phase 2, pipeline step 2).
 *
 * docs/architecture.md, "End-to-End Verification Pipeline": the worker pulls the
 * unified PR diff and splits it into the Test-Only Patch and the Full PR Patch
 * using test globs. *Short-Circuit:* "If no test files were added or modified,
 * the Check Run completes immediately with a `neutral` status (*\"No test
 * changes detected to verify\"*)."
 *
 * This handler is the composition point: the GitHub clients (`PrDiffClient`,
 * `CheckRunReporter`) are injected as ports, so the queue layer stays free of
 * Octokit and the handler is unit-testable with canned diffs.
 *
 * Phase 3 is not built yet. When the PR *does* change tests, the handler logs
 * and returns, leaving the check run `queued` from Phase 1 — it never claims a
 * verdict it did not compute. Repo-configured globs (`PATCH /api/repos/:id/config`)
 * arrive in Phase 4, so the splitter runs with the default globs here.
 */

import type { Logger, VerificationJob, VerificationJobHandler } from '../domain.js';
import { splitDiff } from '../diff/split.js';
import { DEFAULT_TEST_GLOBS } from '../diff/types.js';
import type {
  CheckRunReporter,
  NoTestChangesReport,
  PrDiffClient,
  SplitResult,
} from '../diff/types.js';

export interface DiffHandlerDeps {
  prDiff: PrDiffClient;
  checkRuns: CheckRunReporter;
  logger: Logger;
}

/** Check-run output title for the pure-refactor short-circuit. */
export const NO_TEST_CHANGES_TITLE = 'No test changes detected to verify';

/**
 * Message-only rendering of an unknown thrown value. Logs carry the message
 * string only: whole error objects can hold request payloads, headers, and
 * tokens.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Check-run summary explaining why differential verification was skipped. */
function buildSummary(split: SplitResult): string {
  return (
    `${split.files.length} changed file(s), none matching the test file globs ` +
    `(${DEFAULT_TEST_GLOBS.join(', ')}). Differential verification skipped: ` +
    `no new or modified tests to verify.`
  );
}

/**
 * Builds the Phase-2 `VerificationJobHandler`: fetch the PR diff, split it,
 * and either report `neutral` (no test changes) or defer to the Phase 3
 * sandbox runner.
 */
export function createDiffSplittingHandler(deps: DiffHandlerDeps): VerificationJobHandler {
  const { prDiff, checkRuns, logger } = deps;

  return async (job: VerificationJob): Promise<void> => {
    const { repoFullName, prNumber, baseSha, headSha } = job;

    // Defence in depth: the webhook layer never enqueues a job without an
    // installation, and without an installation token no diff fetch is
    // possible — so stop before touching any port rather than failing later.
    if (job.installationId === null) {
      logger.warn(
        `verification job for repo=${repoFullName} pr=${prNumber} has no installation id; skipping diff fetch and check-run reporting`,
      );
      return;
    }

    const installationId = job.installationId;

    logger.info(
      `verification job received: repo=${repoFullName} pr=${prNumber} head=${headSha} (diff splitter)`,
    );

    let diff: string;
    try {
      diff = await prDiff({ repoFullName, baseSha, headSha, installationId });
    } catch (error) {
      logger.error(
        `failed to fetch PR diff for ${repoFullName}#${prNumber} (${baseSha}...${headSha}): ${errorMessage(error)}`,
      );
      // Rethrowing fails the BullMQ job, which is retried per the queue's
      // attempts/backoff policy — transient GitHub errors self-heal without
      // losing the job.
      throw error;
    }

    const split = splitDiff(diff);

    logger.info(
      `split: ${split.files.length} file(s) changed, ` +
        `${split.changedTestFiles.length} test file(s), ` +
        `${split.runnableTestFiles.length} runnable: ` +
        `${split.changedTestFiles.join(', ') || '(none)'}`,
    );

    // Pure-refactor short-circuit: nothing to verify, complete as `neutral`.
    if (!split.hasTestChanges) {
      const report: NoTestChangesReport = {
        repoFullName,
        headSha,
        installationId,
        title: NO_TEST_CHANGES_TITLE,
        summary: buildSummary(split),
      };

      try {
        await checkRuns.reportNoTestChanges(report);
      } catch (error) {
        logger.error(
          `failed to report neutral check run for ${repoFullName}#${prNumber}: ${errorMessage(error)}`,
        );
        // Rethrowing lets BullMQ retry. Reporting twice is idempotent: PATCHing
        // an already-completed/neutral check run is a no-op.
        throw error;
      }

      logger.info(`reported neutral check run (no test changes) for ${repoFullName}#${prNumber}`);
      return;
    }

    // Phase 3 owns the sandbox runs; the check run stays `queued` from Phase 1
    // until that pipeline can report a real verdict.
    logger.info(
      `differential verification deferred to Phase 3 sandbox runner (test files: ${split.changedTestFiles.join(', ')})`,
    );
  };
}
