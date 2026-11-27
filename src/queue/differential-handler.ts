/**
 * Differential verification handler (Phase 3, pipeline steps 2-6).
 *
 * docs/architecture.md, "End-to-End Verification Pipeline" steps 2-6: the
 * worker fetches and splits the pinned PR diff, runs Run A (merge base +
 * Test-Only Patch) and Run B (exact PR head) in separate sandboxes, maps the outcome
 * through the verdict matrix, completes the Check Run with the rich Markdown
 * report, and records the run for the dashboard.
 *
 * Phase 4 adds the two database-backed behaviors (architecture, "Core Data
 * Model" and "API & Interface Contracts"):
 *  - the repo's configuration is consulted *before* the diff is fetched, so a
 *    repo whose `enabled` flag is off is skipped with a neutral check, and its
 *    `test_file_globs` / `test_command` overrides (`PATCH
 *    /api/repos/:id/config`) replace the auto-detected defaults;
 *  - after GitHub accepted the verdict, the run is persisted
 *    (`VerificationRunStore`), because the architecture's step 6 says the worker
 *    "saves the record to PostgreSQL" once the check run is updated.
 *
 * This handler is the composition point: every collaborator is injected as a
 * port (`PrDiffClient`, `CheckRunReporter`, `RepoContentClient`,
 * `RepoTarballClient`, `DifferentialRunner`, `VerdictReporter`,
 * `RepoConfigStore`, `VerificationRunStore`), so the queue layer stays free of
 * Octokit, E2B, and Postgres, and the whole pipeline is unit-testable with
 * canned diffs and fake sandbox results.
 *
 * Port failures propagate so BullMQ retries them; nothing is ever reported as
 * a verdict that was not computed.
 *
 * No GitHub token ever crosses into the sandbox: the tarball is downloaded on
 * the trusted side and handed to the runner as bytes (guardrail #2).
 */

import { createHash } from 'node:crypto';

import type { RepoConfigStore, VerificationRunStore } from '../db/types.js';
import type { Logger, VerificationJob, VerificationJobHandler } from '../domain.js';
import { splitDiff } from '../diff/split.js';
import { DEFAULT_TEST_GLOBS, NO_TEST_CHANGES_TITLE } from '../diff/types.js';
import type {
  CheckRunReporter,
  NoTestChangesReport,
  PrDiffClient,
  SplitResult,
} from '../diff/types.js';
import { summarizeCaseEvidence } from '../runner/case-evidence.js';
import { classifyRun } from '../runner/classify.js';
import {
  buildInstallCommand,
  buildTestCommand,
  findLockfile,
  formatCustomTestCommand,
} from '../runner/commands.js';
import { detectRunner } from '../runner/detect.js';
import { conclusionForVerdict, verdictFrom } from '../runner/matrix.js';
import { buildVerdictReport } from '../runner/report.js';
import type {
  DifferentialRawResult,
  DifferentialRunner,
  RepoContentClient,
  RepoTarballClient,
  RunnerKind,
  VerdictReporter,
} from '../runner/types.js';

export interface DifferentialHandlerDeps {
  prDiff: PrDiffClient;
  checkRuns: CheckRunReporter;
  repoContent: RepoContentClient;
  repoTarball: RepoTarballClient;
  /** The E2B differential runner; null when E2B_API_KEY is unset. */
  runner: DifferentialRunner | null;
  verdicts: VerdictReporter;
  /**
   * Worker-facing repository config (architecture pipeline step 2: "repo-configured
   * test globs"). Null when PostgreSQL is not configured: the diff is then split
   * with the default globs and the repo is treated as enabled.
   */
  repoConfig: RepoConfigStore | null;
  /** Run-history persistence; null when PostgreSQL is not configured (runs are then not recorded). */
  runs: VerificationRunStore | null;
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

/**
 * Check-run summary explaining why differential verification was skipped.
 *
 * `testGlobs` is the resolved list that was actually applied — a repo-configured
 * override, or the defaults — so the explanation never names globs the split was
 * not performed with.
 */
function buildNoTestChangesSummary(split: SplitResult, testGlobs: readonly string[]): string {
  if (split.hasTestChanges) {
    return (
      `${split.files.length} changed file(s); only deleted or binary test file(s) ` +
      `(${split.changedTestFiles.join(', ')}) matched the test file globs ` +
      `(${testGlobs.join(', ')}). Differential verification skipped: ` +
      `no runnable tests exist to verify.`
    );
  }
  return (
    `${split.files.length} changed file(s), none matching the test file globs ` +
    `(${testGlobs.join(', ')}). Differential verification skipped: ` +
    `no new or modified tests to verify.`
  );
}

/**
 * Infers a `RunnerKind` when a repository configures a custom `testCommand`
 * and manifest auto-detection found no supported runner.
 */
function inferRunnerForCustomCommand(
  testCommand: string,
  pyprojectToml: string | null,
): RunnerKind {
  const normalized = testCommand.toLowerCase();
  if (normalized.includes('pytest') || normalized.includes('python')) {
    return 'pytest';
  }
  if (normalized.includes('jest')) {
    return 'jest';
  }
  if (normalized.includes('vitest')) {
    return 'vitest';
  }
  return pyprojectToml !== null ? 'pytest' : 'vitest';
}

/**
 * Lockfile hash used to key the sandbox snapshot (guardrail #4). Hex sha256 of
 * the lockfile's text; `'none'` stands in when the repo has no lockfile.
 */
function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Builds the `VerificationJobHandler` for the differential pipeline: honor the
 * repo's config (enabled flag, test globs, test command), fetch and split the PR
 * diff, short-circuit PRs without test changes to `neutral`, run the base and
 * head differential in the sandbox, report the mapped verdict, and persist the
 * run for the dashboard.
 */
export function createDifferentialHandler(
  deps: DifferentialHandlerDeps,
): VerificationJobHandler {
  const { prDiff, checkRuns, repoContent, repoTarball, runner, verdicts, runs, logger } = deps;

  return async (job: VerificationJob): Promise<void> => {
    const { repoFullName, prNumber, baseSha, headSha, checkRunId } = job;

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
    const check = {
      repoFullName,
      headSha,
      installationId,
      ...(checkRunId === undefined ? {} : { checkRunId }),
    };

    async function reportSkipped(title: string, summary: string): Promise<void> {
      const report: NoTestChangesReport = { ...check, title, summary };
      try {
        await checkRuns.reportNoTestChanges(report);
      } catch (error) {
        logger.error(
          `failed to report neutral check run for ${repoFullName}#${prNumber}: ${errorMessage(error)}`,
        );
        // Retrying completes the same check run; never claim a skip was reported here.
        throw error;
      }
      logger.info(`reported neutral check run for ${repoFullName}#${prNumber}: ${title}`);
    }

    logger.info(
      `verification job received: repo=${repoFullName} pr=${prNumber} head=${headSha} (differential pipeline)`,
    );

    // Phase 4: the repository's own configuration replaces the hard-coded
    // defaults (architecture pipeline step 2, "repo-configured test globs"). It
    // is read before the diff so a disabled repo can skip fetching it.
    const repoConfig = deps.repoConfig
      ? await deps.repoConfig.lookupConfig(repoFullName)
      : null;

    if (repoConfig !== null && !repoConfig.enabled) {
      logger.warn(
        `verification is disabled for repo=${repoFullName} (repositories.enabled = false)`,
      );
      await reportSkipped(
        'Differential verification is disabled',
        'Differential verification was skipped because this repository has disabled it in DiffProve settings.',
      );
      return;
    }

    let comparison: Awaited<ReturnType<PrDiffClient>>;
    try {
      comparison = await prDiff({ repoFullName, baseSha, headSha, installationId });
    } catch (error) {
      logger.error(
        `failed to fetch PR diff for ${repoFullName}#${prNumber} (${baseSha}...${headSha}): ${errorMessage(error)}`,
      );
      // Rethrowing fails the BullMQ job, which is retried per the queue's
      // attempts/backoff policy — transient GitHub errors self-heal without
      // losing the job.
      throw error;
    }
    const { diff, mergeBaseSha } = comparison;

    // Repo-configured globs replace the defaults entirely; undefined keeps them
    // (src/diff/split.ts documents the replacement semantics).
    const globs = repoConfig?.testFileGlobs ?? undefined;
    const split = splitDiff(diff, globs);
    // The skip summary must name exactly the globs this split used.
    const appliedGlobs = globs ?? DEFAULT_TEST_GLOBS;

    logger.info(
      `split: ${split.files.length} file(s) changed, ` +
        `${split.changedTestFiles.length} test file(s), ` +
        `${split.runnableTestFiles.length} runnable: ` +
        `${split.changedTestFiles.join(', ') || '(none)'}`,
    );

    const customTestCommand = repoConfig?.testCommand ?? null;

    // Pure-refactor / non-runnable-test short-circuit (Phase 2, retained): when
    // no test files changed, or when only deleted/binary test files matched
    // and no custom testCommand is configured, complete as `neutral` instead of
    // booting a sandbox (which would otherwise run the whole suite).
    if (!split.hasTestChanges || (split.runnableTestFiles.length === 0 && !customTestCommand)) {
      await reportSkipped(NO_TEST_CHANGES_TITLE, buildNoTestChangesSummary(split, appliedGlobs));
      return;
    }

    // Without E2B nothing downstream can run; record the skip, not a verdict.
    if (runner === null) {
      logger.warn(
        `E2B is not configured (E2B_API_KEY is unset); skipping verification for ` +
          `${repoFullName}#${prNumber} (test files: ${split.changedTestFiles.join(', ')})`,
      );
      await reportSkipped(
        'Differential verification sandbox is unavailable',
        'Differential verification was skipped because E2B is not configured (E2B_API_KEY is unset).',
      );
      return;
    }

    // The three-dot patch applies to the merge base, not the branch tip.
    // What the PR adds must not decide how its own tests are executed.
    const packageJson = await repoContent.fetchTextFile({
      repoFullName,
      path: 'package.json',
      ref: mergeBaseSha,
      installationId,
    });
    const pyprojectToml = await repoContent.fetchTextFile({
      repoFullName,
      path: 'pyproject.toml',
      ref: mergeBaseSha,
      installationId,
    });

    const detected = detectRunner({ packageJson, pyprojectToml });
    let runnerKind: RunnerKind;
    if (detected !== null) {
      runnerKind = detected.kind;
    } else if (customTestCommand !== null) {
      runnerKind = inferRunnerForCustomCommand(customTestCommand, pyprojectToml);
    } else {
      logger.warn(
        `no supported test runner detected for ${repoFullName}#${prNumber} at ${mergeBaseSha} ` +
          `(looked for vitest/jest in package.json and pytest in pyproject.toml)`,
      );
      await reportSkipped(
        'No supported test runner detected',
        `No pytest, Vitest, or Jest configuration was detected at the pinned merge base ` +
          `\`${mergeBaseSha}\`, and no custom test command is configured.`,
      );
      return;
    }

    const baseFiles = await repoContent.listPaths({
      repoFullName,
      ref: mergeBaseSha,
      installationId,
    });
    const headFiles = await repoContent.listPaths({
      repoFullName,
      ref: headSha,
      installationId,
    });

    // Dependency setup follows each VM's own tree, even with matching locks.
    // Both runs use the same targeted test command (pipeline steps 4-5).
    const installCommand = buildInstallCommand(baseFiles, runnerKind);
    const headInstallCommand = buildInstallCommand(headFiles, runnerKind);
    // Architecture "API & Interface Contracts": PATCH /api/repos/:id/config
    // overrides the auto-detected `test_command`, so a repo-configured command
    // wins over the one built from the runner kind and changed test files.
    const testCommand =
      customTestCommand !== null
        ? formatCustomTestCommand(customTestCommand, split.runnableTestFiles)
        : buildTestCommand(runnerKind, split.runnableTestFiles);

    // Hash each side's lockfile separately so the runner can check provenance
    // before using any base dependency cache to seed the head.
    const baseLock = findLockfile(baseFiles);
    const baseLockContent =
      baseLock === null
        ? null
        : await repoContent.fetchTextFile({
            repoFullName,
            path: baseLock.path,
            ref: mergeBaseSha,
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
    const headLockfileKey = headLockContent === null ? 'none' : sha256Hex(headLockContent);

    // Fetch the exact pinned archives on the trusted side; only bytes enter
    // the sandbox, never the token (guardrail #2).
    const [tarball, headTarball] = await Promise.all([
      repoTarball({ repoFullName, ref: mergeBaseSha, installationId }),
      repoTarball({ repoFullName, ref: headSha, installationId }),
    ]);

    const collectCaseResults = customTestCommand === null;
    let raw: DifferentialRawResult;
    try {
      raw = await runner({
        repoFullName,
        baseSha: mergeBaseSha,
        headSha,
        tarball,
        headTarball,
        testOnlyDiff: split.testOnlyDiff,
        testCommand,
        installCommand,
        headInstallCommand,
        runnerKind,
        lockfileKey,
        headLockfileKey,
        collectCaseResults,
      });
    } catch (error) {
      logger.error(
        `differential runner failed for ${repoFullName}#${prNumber} (${mergeBaseSha}...${headSha}): ${errorMessage(error)}`,
      );
      // The runner throws only for infrastructure failures (sandbox creation,
      // snapshot/egress problems) — exactly the transient class BullMQ retries.
      throw error;
    }

    // Classification and verdict mapping are pure policy (src/runner/), so the
    // sandbox is never trusted to decide what a result means.
    const outcomeA = classifyRun(raw.runA, runnerKind);
    const outcomeB = classifyRun(raw.runB, runnerKind);

    const comparable =
      (outcomeA.status === 'pass' || outcomeA.status === 'fail') &&
      (outcomeB.status === 'pass' || outcomeB.status === 'fail');
    const evidence =
      collectCaseResults && comparable
        ? summarizeCaseEvidence(raw.runA.caseResults, raw.runB.caseResults)
        : undefined;
    const verdict = verdictFrom(outcomeA, outcomeB, evidence);
    const conclusion = conclusionForVerdict(verdict);
    const totalMs = raw.runA.durationMs + raw.runB.durationMs;
    const { title, summary } = buildVerdictReport(verdict, outcomeA, outcomeB, {
      repoFullName,
      prNumber,
      durationMs: totalMs,
      ...(evidence === undefined ? {} : { caseEvidence: evidence }),
    });

    logger.info(
      `verdict: ${verdict} (runA=${outcomeA.status}, runB=${outcomeB.status}, ${totalMs}ms)`,
    );

    try {
      await verdicts.reportVerdict({
        ...check,
        prNumber,
        verdict,
        conclusion,
        title,
        summary: `${summary}\n\nTested merge base (Run A): \`${mergeBaseSha}\`.`,
        runA: outcomeA,
        runB: outcomeB,
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

    // Architecture pipeline step 6: the worker "saves the record to PostgreSQL"
    // after it updated the check run. Persisting only a reported verdict keeps
    // history free of runs GitHub was never told about.
    //
    // Accepted edge: `insertRun` has no natural key in v1, so when persistence
    // fails *after* the (idempotent) GitHub report succeeded, the BullMQ retry
    // re-runs the pipeline and may insert a duplicate run row.
    if (runs !== null) {
      try {
        await runs.insertRun({
          repoFullName,
          installationId,
          language: runnerKind === 'pytest' ? 'python' : 'node',
          prNumber,
          baseSha: mergeBaseSha,
          headSha,
          changedTestFiles: split.changedTestFiles,
          runAStatus: outcomeA.status,
          runBStatus: outcomeB.status,
          verdict,
          durationMs: totalMs,
          runALog: outcomeA.logExcerpt,
          runBLog: outcomeB.logExcerpt,
          ...(evidence === undefined ? {} : { caseEvidence: evidence }),
        });
      } catch (error) {
        logger.error(
          `failed to persist verification run for ${repoFullName}#${prNumber}: ${errorMessage(error)}`,
        );
        // Rethrowing fails the job so BullMQ retries; re-reporting the same
        // verdict to GitHub is idempotent, so only the row can be duplicated.
        throw error;
      }
    }

    logger.info(`reported verdict ${verdict} for ${repoFullName}#${prNumber}`);
  };
}
