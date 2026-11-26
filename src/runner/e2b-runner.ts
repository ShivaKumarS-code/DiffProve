/**
 * Differential runner backed by an (E2B) sandbox.
 *
 * Implements the architecture's "Sandbox Provisioning" step plus the two
 * differential runs (docs/architecture.md, steps 3-5):
 *  1. boot from a lockfile-keyed environment snapshot when one exists,
 *  2. materialize the base tree and install dependencies (still networked),
 *  3. clone the tree into Run A / Run B and apply the Test-Only / Full patch,
 *  4. lock down outbound egress (guardrail #2), only then
 *  5. run the same targeted test command in both trees and return RAW results.
 *
 * Policy (classification, verdicts) lives in the pure core; this module only
 * produces comparables. It is written against the `SandboxFactory` port, so the
 * whole choreography is unit-tested with a fake and the E2B SDK never loads.
 */

import type { Logger } from '../domain.js';
import type {
  DifferentialRawResult,
  DifferentialRunRequest,
  DifferentialRunner,
  EnvSnapshotCache,
  SandboxFactory,
  SandboxRawResult,
} from './types.js';

const STAGING = '/tmp/diffprove';
const WORKSPACE = '/tmp/diffprove/workspace';
const RUN_A = '/tmp/diffprove/run-a';
const RUN_B = '/tmp/diffprove/run-b';

/** Untars the base tree into an empty workspace; `--strip-components=1` drops the repo-<sha> root. */
const EXTRACT = `mkdir -p ${WORKSPACE} && tar -xzf ${STAGING}/base.tar.gz -C ${WORKSPACE} --strip-components=1`;

const DEFAULT_INSTALL_TIMEOUT_MS = 240_000;
const DEFAULT_TEST_TIMEOUT_MS = 120_000;
/** Patch application is a local `git apply`; it should never take longer. */
const PATCH_TIMEOUT_MS = 30_000;

export interface E2bRunnerDeps {
  sandboxFactory: SandboxFactory;
  apiKey?: string;
  defaultTemplateId?: string;
  snapshotCache?: EnvSnapshotCache;
  logger: Logger;
  installTimeoutMs?: number;
  testTimeoutMs?: number;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A prep step counts as failed on a non-zero exit, and also when it never
 * completed (timeout / sandbox-level error -> `exitCode: null`). Continuing
 * after a timed-out install would test against a half-built tree and could
 * turn infrastructure flakiness into a wrong verdict.
 */
function isFailedStep(result: SandboxRawResult): boolean {
  return result.timedOut || result.exitCode !== 0;
}

/** One run's raw result for a prep step that failed before any test ran. */
function failedPrepResult(label: string, step: SandboxRawResult): SandboxRawResult {
  return {
    exitCode: null,
    stdout: step.stdout,
    stderr: `${label} failed:\n${step.stderr}`,
    timedOut: step.timedOut,
    durationMs: step.durationMs,
  };
}

/** Both runs share the same error shape; they are separate objects so no step can alias them. */
function failedPrepPair(label: string, step: SandboxRawResult): DifferentialRawResult {
  return {
    runA: failedPrepResult(label, step),
    runB: failedPrepResult(label, step),
  };
}

function lockdownFailurePair(error: unknown): DifferentialRawResult {
  const raw: SandboxRawResult = {
    exitCode: null,
    stdout: '',
    stderr: `network egress lockdown failed: ${describeError(error)}`,
    timedOut: false,
    durationMs: 0,
  };
  return { runA: { ...raw }, runB: { ...raw } };
}

/** Prepends the project's local `.venv/bin` to `PATH` when running `pytest`. */
function testCommandForRun(request: DifferentialRunRequest): string {
  return request.runnerKind === 'pytest'
    ? `export PATH="$PWD/.venv/bin:$PATH"; ${request.testCommand}`
    : request.testCommand;
}

/**
 * Rewrites hardcoded workspace paths inside a copied `.venv` so editable
 * installs (`.pth` / `__editable__*.py`) and `.venv/bin/*` scripts resolve
 * against `runDir` instead of the shared base workspace.
 */
function relocateVenvCommand(runDir: string): string {
  const script = [
    'from pathlib import Path',
    `venv = Path("${runDir}/.venv")`,
    'targets = (',
    '    list(venv.glob("lib/*/site-packages/*.pth"))',
    '    + list(venv.glob("lib/*/site-packages/__editable__*.py"))',
    '    + list(venv.glob("bin/*"))',
    ')',
    'for p in targets:',
    '    if not p.is_file() or p.is_symlink():',
    '        continue',
    '    try:',
    '        text = p.read_text(encoding="utf-8")',
    '    except (UnicodeDecodeError, OSError):',
    '        continue',
    `    if "${WORKSPACE}" in text:`,
    `        p.write_text(text.replace("${WORKSPACE}", "${runDir}"), encoding="utf-8")`,
  ].join('\n');
  return `if [ -d ${runDir}/.venv ]; then python3 -c '${script}'; fi`;
}

export function createE2bDifferentialRunner(deps: E2bRunnerDeps): DifferentialRunner {
  const installTimeoutMs = deps.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
  const testTimeoutMs = deps.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;

  return async (request: DifferentialRunRequest) => {
    // Snapshot cache failures degrade to a miss: a cold, slower run beats a
    // failed verification.
    const cached = deps.snapshotCache
      ? await deps.snapshotCache.get(request.repoFullName, request.lockfileKey).catch((error: unknown) => {
          deps.logger.warn(
            `environment snapshot lookup failed for ${request.repoFullName} (${request.lockfileKey}): ${describeError(error)}; falling back to a cold install`,
          );
          return null;
        })
      : null;

    // Creation failures deliberately propagate: the BullMQ worker retries the
    // whole job, so there is no sandbox to leak and nothing to report.
    const sandbox = await deps.sandboxFactory.create({
      templateId: cached ?? deps.defaultTemplateId,
      apiKey: deps.apiKey,
      timeoutMs: (installTimeoutMs + testTimeoutMs) * 2 + 60_000,
    });

    try {
      await sandbox.writeFile(`${STAGING}/base.tar.gz`, request.tarball);
      await sandbox.writeFile(`${STAGING}/test-only.patch`, request.testOnlyDiff);
      await sandbox.writeFile(`${STAGING}/full.patch`, request.fullDiff);

      if (cached !== null) {
        // Snapshot HIT: workspace holds the tree of the PR that produced the
        // snapshot (stale) but its dependency environment matches this lockfile
        // hash (valid). Rescue workspace deps with mv across the workspace
        // reset so thousands of files aren't copied before rm -rf.
        const depsDir = request.runnerKind === 'pytest' ? '.venv' : 'node_modules';
        await sandbox.run(`mv ${WORKSPACE}/${depsDir} ${STAGING}/${depsDir} 2>/dev/null || true`);
        const reset = await sandbox.run(`rm -rf ${WORKSPACE} && ${EXTRACT}`);
        if (isFailedStep(reset)) {
          return failedPrepPair('workspace extraction', reset);
        }
        await sandbox.run(`mv ${STAGING}/${depsDir} ${WORKSPACE}/${depsDir} 2>/dev/null || true`);
      } else {
        const extract = await sandbox.run(EXTRACT);
        if (isFailedStep(extract)) {
          return failedPrepPair('workspace extraction', extract);
        }

        if (request.installCommand !== null) {
          const install = await sandbox.run(request.installCommand, {
            cwd: WORKSPACE,
            timeoutMs: installTimeoutMs,
          });
          if (isFailedStep(install)) {
            // No tests may run against an unprovisioned environment.
            return failedPrepPair('dependency installation', install);
          }
        }
      }

      // Only a cold run produced a complete, reusable environment from scratch.
      // A HIT boots from an existing snapshot and would just re-snapshot the
      // same deps, so it is skipped. Snapshotting before cloning, patching, and
      // running tests keeps untrusted PR code and run-a / run-b trees out of it.
      if (cached === null && deps.snapshotCache) {
        const ref = await sandbox.createSnapshot(`diffprove-${request.lockfileKey}`);
        if (ref !== null) {
          try {
            await deps.snapshotCache.set(request.repoFullName, request.lockfileKey, ref);
          } catch (error) {
            deps.logger.warn(
              `failed to record environment snapshot for ${request.repoFullName} (${request.lockfileKey}): ${describeError(error)}`,
            );
          }
        }
      }

      // Two independent trees: Run A gets base + Test-Only Patch, Run B gets
      // base + Full PR Patch. Both start from the same provisioned base.
      for (const [label, runDir] of [
        ['run-a workspace copy', RUN_A],
        ['run-b workspace copy', RUN_B],
      ] as const) {
        const copy = await sandbox.run(`cp -a ${WORKSPACE} ${runDir}`);
        if (isFailedStep(copy)) {
          return failedPrepPair(label, copy);
        }
      }

      if (request.runnerKind === 'pytest') {
        for (const [label, runDir] of [
          ['run-a .venv relocation', RUN_A],
          ['run-b .venv relocation', RUN_B],
        ] as const) {
          const relocate = await sandbox.run(relocateVenvCommand(runDir));
          if (isFailedStep(relocate)) {
            return failedPrepPair(label, relocate);
          }
        }
      }

      const testOnlyApply = await sandbox.run(
        `git apply --whitespace=nowarn ${STAGING}/test-only.patch`,
        { cwd: RUN_A, timeoutMs: PATCH_TIMEOUT_MS },
      );
      const fullApply = await sandbox.run(`git apply --whitespace=nowarn ${STAGING}/full.patch`, {
        cwd: RUN_B,
        timeoutMs: PATCH_TIMEOUT_MS,
      });

      let headInstall: SandboxRawResult | null = null;
      if (request.headInstallCommand !== null) {
        // The head install needs the network, so it must finish before lockdown.
        headInstall = await sandbox.run(request.headInstallCommand, {
          cwd: RUN_B,
          timeoutMs: installTimeoutMs,
        });
      }

      try {
        await sandbox.updateNetworkEgress(true);
      } catch (error) {
        // Guardrail #2: untrusted repo code must never execute with egress open,
        // so a rejected lockdown aborts BOTH runs as an environment failure.
        deps.logger.warn(
          `network egress lockdown failed for ${request.repoFullName}; aborting differential runs: ${describeError(error)}`,
        );
        return lockdownFailurePair(error);
      }

      const testCommand = testCommandForRun(request);

      const runA = isFailedStep(testOnlyApply)
        ? failedPrepResult('test-only patch application', testOnlyApply)
        : await sandbox.run(testCommand, { cwd: RUN_A, timeoutMs: testTimeoutMs });

      const runB = isFailedStep(fullApply)
        ? failedPrepResult('full patch application', fullApply)
        : headInstall !== null && isFailedStep(headInstall)
          ? failedPrepResult('head dependency installation', headInstall)
          : await sandbox.run(testCommand, { cwd: RUN_B, timeoutMs: testTimeoutMs });

      return { runA, runB };
    } finally {
      // Always release the microVM; a close failure must not mask the result.
      try {
        await sandbox.close();
      } catch (error) {
        deps.logger.warn(`failed to close E2B sandbox: ${describeError(error)}`);
      }
    }
  };
}
