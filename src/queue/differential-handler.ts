/**
 * Differential verification handler (Phase 3, pipeline steps 2-6).
 *
 * docs/architecture.md, "End-to-End Verification Pipeline" steps 2-6: the
 * worker fetches and splits the PR diff, provisions the sandbox, runs Run A
 * (base + Test-Only Patch) and Run B (base + Full PR Patch), maps the outcome
 * through the verdict matrix, and completes the Check Run. Phase 3 reporting is
 * deliberately basic (conclusion + plain title/summary); the rich Markdown
 * reports are Phase 4.
 *
 * This handler is the composition point: every collaborator is injected as a
 * port (`PrDiffClient`, `CheckRunReporter`, `RepoContentClient`,
 * `RepoTarballClient`, `DifferentialRunner`, `VerdictReporter`), so the queue
 * layer stays free of Octokit and E2B, and the whole pipeline is unit-testable
 * with canned diffs and fake sandbox results.
 *
 * Failure policy (Phase 2's, kept): a port failure is logged and rethrown so
 * BullMQ retries it; nothing is ever reported as a verdict that was not
 * computed. A job that cannot complete leaves its check run `queued` from
 * Phase 1 — it never claims a result it did not observe.
 *
 * No GitHub token ever crosses into the sandbox: the tarball is downloaded on
 * the trusted side and handed to the runner as bytes (guardrail #2).
 */

import { createHash } from 'node:crypto';

import type { Logger, VerificationJob, VerificationJobHandler } from '../domain.js';
import { splitDiff } from '../diff/split.js';
import { DEFAULT_TEST_GLOBS, NO_TEST_CHANGES_TITLE } from '../diff/types.js';
import type {
  CheckRunReporter,
  NoTestChangesReport,
  PrDiffClient,
  SplitResult,
} from '../diff/types.js';
import { classifyRun } from '../runner/classify.js';
import { buildInstallCommand, buildTestCommand, findLockfile } from '../runner/commands.js';
import { detectRunner } from '../runner/detect.js';
import { conclusionForVerdict, describeVerdict, verdictFrom } from '../runner/matrix.js';
import type {
  DifferentialRawResult,
  DifferentialRunner,
  RepoContentClient,
  RepoTarballClient,
  VerdictReporter,
} from '../runner/types.js';

export interface DifferentialHandlerDeps {
  prDiff: PrDiffClient;
  checkRuns: CheckRunReporter;
  repoContent: RepoContentClient;
  repoTarball: RepoTarballClient;
  /** The E2B differential runner; null when E2B is not configured (E2B_API_KEY unset) — jobs are then left queued. */
  runner: DifferentialRunner | null;
  verdicts: VerdictReporter;
  logger: Logger;
}

/**
 * Message-only rendering of an unknown thrown value. Logs carry the message
 * string only: whole error objects can hold request payloads, headers, and
 * tokens.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Check-run summary explaining why differential verification was skipped. */
function buildNoTestChangesSummary(split: SplitResult): string {
  return (
    `${split.files.length} changed file(s), none matching the test file globs ` +
    `(${DEFAULT_TEST_GLOBS.join(', ')}). Differential verification skipped: ` +
    `no new or modified tests to verify.`
  );
}

/**
 * Lockfile hash used to key the sandbox snapshot (guardrail #4). Hex sha256 of
 * the lockfile's text; `'none'` stands in when the repo has no lockfile.
 */
function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Builds the Phase-3 `VerificationJobHandler`: fetch and split the PR diff,
 * short-circuit PRs without test changes to `neutral`, then run the base and
 * head differential in the sandbox and report the mapped verdict.
 */
export function createDifferentialHandler(
  deps: DifferentialHandlerDeps,
): VerificationJobHandler {
  const { prDiff, checkRuns, repoContent, repoTarball, runner, verdicts, logger } = deps;

  return async (job: VerificationJob): Promise<void> => {
    const { repoFullName, prNumber, baseSha, headSha } = job;

    // Defence in depth: the webhook layer never enqueues a job without an
    // installation, and without an installation token no GitHub call is
    // possible — so stop before touching any port rather than failing later.
    if (job.installationId === null) {
      logger.warn(
        `verification job for repo=${repoFullName} pr=${prNumber} has no installation id; skipping differential verification`,
      );
      return;
    }

    const installationId = job.installationId;

    logger.info(
      `verification job received: repo=${repoFullName} pr=${prNumber} head=${headSha} (differential pipeline)`,
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

    // Pure-refactor short-circuit (Phase 2, retained): nothing to verify, so
    // complete as `neutral` instead of booting a sandbox.
    if (!split.hasTestChanges) {
      const report: NoTestChangesReport = {
        repoFullName,
        headSha,
        installationId,
        title: NO_TEST_CHANGES_TITLE,
        summary: buildNoTestChangesSummary(split),
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

    // Without E2B there is no sandbox, so there is no way to compute a verdict.
    // Leave the check run `queued` (Phase 1 state) instead of guessing, and do
    // not download a tarball or read the repo — nothing downstream can run.
    if (runner === null) {
      logger.warn(
        `E2B is not configured (E2B_API_KEY is unset); leaving the check run queued for ` +
          `${repoFullName}#${prNumber} (test files: ${split.changedTestFiles.join(', ')})`,
      );
      return;
    }

    // Detection reads the BASE commit: what the PR *adds* must not decide how
    // its own tests are executed.
    const packageJson = await repoContent.fetchTextFile({
      repoFullName,
      path: 'package.json',
      ref: baseSha,
      installationId,
    });
    const pyprojectToml = await repoContent.fetchTextFile({
      repoFullName,
      path: 'pyproject.toml',
      ref: baseSha,
      installationId,
    });

    const detected = detectRunner({ packageJson, pyprojectToml });
    if (detected === null) {
      logger.error(
        `no supported test runner detected for ${repoFullName}#${prNumber} at ${baseSha} ` +
          `(looked for vitest/jest in package.json and pytest in pyproject.toml)`,
      );
      // Guardrail #1: v1 supports only pytest / vitest / jest. Guessing would
      // risk a false verdict, so fail the job (BullMQ retries; the check run
      // stays queued).
      throw new Error('no supported test runner detected (expected pytest, vitest, or jest)');
    }

    const baseFiles = await repoContent.listPaths({
      repoFullName,
      ref: baseSha,
      installationId,
    });
    const headFiles = await repoContent.listPaths({
      repoFullName,
      ref: headSha,
      installationId,
    });

    // The install command describes the BASE state; the test command is the
    // same targeted invocation for Run A and Run B (pipeline steps 4-5).
    const installCommand = buildInstallCommand(baseFiles, detected.kind);
    const testCommand = buildTestCommand(detected.kind, split.runnableTestFiles);

    // Snapshot key from the base lockfile, and a second key for head: Run B
    // must reinstall only when the PR changes dependencies (guardrail #4).
    const baseLock = findLockfile(baseFiles);
    const baseLockContent =
      baseLock === null
        ? null
        : await repoContent.fetchTextFile({
            repoFullName,
            path: baseLock.path,
            ref: baseSha,
            installationId,
          });
    const lockfileKey = baseLockContent === null ? 'none' : sha256Hex(baseLockContent);

    const headLock = findLockfile(headFiles);
    const headLockContent =
      headLock === null
        ? null
        : await repoContent.fetchTextFile({
            repoFullName,
            path: headLock.path,
            ref: headSha,
            installationId,
          });
    const headLockKey = headLockContent === null ? 'none' : sha256Hex(headLockContent);

    const headInstallCommand =
      headLockKey === lockfileKey ? null : buildInstallCommand(headFiles, detected.kind);

    // Fetched on the trusted side and passed as bytes: the token never enters
    // the sandbox (guardrail #2).
    const tarball = await repoTarball({ repoFullName, ref: baseSha, installationId });

    let raw: DifferentialRawResult;
    try {
      raw = await runner({
        repoFullName,
        baseSha,
        headSha,
        tarball,
        testOnlyDiff: split.testOnlyDiff,
        fullDiff: split.fullDiff,
        testCommand,
        installCommand,
        headInstallCommand,
        runnerKind: detected.kind,
        lockfileKey,
      });
    } catch (error) {
      logger.error(
        `differential runner failed for ${repoFullName}#${prNumber} (${baseSha}...${headSha}): ${errorMessage(error)}`,
      );
      // The runner throws only for infrastructure failures (sandbox creation,
      // snapshot/egress problems) — exactly the transient class BullMQ retries.
      throw error;
    }

    // Classification and verdict mapping are pure policy (src/runner/), so the
    // sandbox is never trusted to decide what a result means.
    const outcomeA = classifyRun(raw.runA, detected.kind);
    const outcomeB = classifyRun(raw.runB, detected.kind);

    const verdict = verdictFrom(outcomeA, outcomeB);
    const conclusion = conclusionForVerdict(verdict);
    const totalMs = raw.runA.durationMs + raw.runB.durationMs;
    const { title, summary } = describeVerdict(verdict, outcomeA, outcomeB, totalMs);

    logger.info(
      `verdict: ${verdict} (runA=${outcomeA.status}, runB=${outcomeB.status}, ${totalMs}ms)`,
    );

    try {
      await verdicts.reportVerdict({
        repoFullName,
        headSha,
        installationId,
        verdict,
        conclusion,
        title,
        summary,
        durationMs: totalMs,
      });
    } catch (error) {
      logger.error(
        `failed to report verdict ${verdict} for ${repoFullName}#${prNumber}: ${errorMessage(error)}`,
      );
      // Rethrowing lets BullMQ retry. Re-completing a check run with the same
      // conclusion/title/summary is idempotent.
      throw error;
    }

    logger.info(`reported verdict ${verdict} for ${repoFullName}#${prNumber}`);
  };
}
