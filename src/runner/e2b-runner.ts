/**
 * Runs the pinned merge base plus the test-only patch and the exact PR head in
 * independent microVMs. Only cold merge-base dependency setup has any egress.
 */
import { createHash } from 'node:crypto';

import type { Logger } from '../domain.js';
import { caseReportOptions, parseTestCases } from './case-evidence.js';
import type {
  DifferentialRunRequest,
  DifferentialRunner,
  EnvSnapshotCache,
  RunnerKind,
  SandboxFactory,
  SandboxHandle,
  SandboxRawResult,
} from './types.js';

const STAGING = '/tmp/diffprove';
const WORKSPACE = `${STAGING}/workspace`;
// Keep package downloads outside the repo and out of directories normally
// cleaned during filesystem snapshot boot. Installed environments stay in the repo.
const PACKAGE_CACHE = '/var/tmp/diffprove-packages';
const WHEELHOUSE = `${PACKAGE_CACHE}/wheels`;
const PYTHON_TOOLS = `${PACKAGE_CACHE}/python-tools`;
const SNAPSHOT_MARKER = `${PACKAGE_CACHE}/base-snapshot`;
const SNAPSHOT_VERSION = 'locked-base-packages-v3';

const DEFAULT_INSTALL_TIMEOUT_MS = 240_000;
const DEFAULT_TEST_TIMEOUT_MS = 120_000;
const PREP_TIMEOUT_MS = 30_000;
const REPORT_TIMEOUT_MS = 5_000;

const REGISTRY_HOSTS = {
  python: ['pypi.org', 'files.pythonhosted.org'],
  node: ['registry.npmjs.org', 'registry.yarnpkg.com'],
} as const;

type NetworkPolicy = Parameters<SandboxFactory['create']>[0]['network'];
const OFFLINE = { mode: 'offline' } as const;

export interface E2bRunnerDeps {
  sandboxFactory: SandboxFactory;
  apiKey?: string;
  defaultTemplateId?: string;
  snapshotCache?: EnvSnapshotCache;
  logger: Logger;
  installTimeoutMs?: number;
  testTimeoutMs?: number;
}

type BasePreparation =
  | { sandbox: SandboxHandle; snapshotRef: string | null }
  | { failure: SandboxRawResult };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFailedStep(result: SandboxRawResult): boolean {
  return result.timedOut || result.exitCode !== 0;
}

/** Prep failures are not test failures, even when their command exits nonzero. */
function failedPrepResult(label: string, step: SandboxRawResult): SandboxRawResult {
  return {
    exitCode: null,
    stdout: step.stdout,
    stderr: `${label} failed:\n${step.stderr}`,
    timedOut: step.timedOut,
    durationMs: step.durationMs,
  };
}

function baseSnapshotKey(request: DifferentialRunRequest, templateId?: string): string {
  const identity = [
    request.repoFullName,
    request.baseSha,
    request.lockfileKey,
    request.runnerKind,
    request.installCommand,
    templateId ?? null,
  ];
  return `${SNAPSHOT_VERSION}:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}

function installCommand(kind: RunnerKind, command: string, offline: boolean): string {
  if (kind !== 'pytest') {
    const env = [
      `npm_config_cache=${PACKAGE_CACHE}/npm`,
      'npm_config_audit=false',
      `YARN_CACHE_FOLDER=${PACKAGE_CACHE}/yarn`,
    ];
    if (offline) env.push('npm_config_offline=true', 'YARN_ENABLE_NETWORK=0');
    const pnpmFlags = command === 'npx --yes pnpm install --frozen-lockfile'
      ? ` --store-dir ${PACKAGE_CACHE}/pnpm${offline ? ' --offline' : ''}`
      : '';
    return `export ${env.join(' ')} && ${command}${pnpmFlags}`;
  }

  const env = [
    `PIP_CACHE_DIR=${PACKAGE_CACHE}/pip`,
    `UV_CACHE_DIR=${PACKAGE_CACHE}/uv`,
    `POETRY_CACHE_DIR=${PACKAGE_CACHE}/poetry`,
    'PIP_DISABLE_PIP_VERSION_CHECK=1',
  ];
  if (offline) env.push('PIP_NO_INDEX=1', `PIP_FIND_LINKS=${WHEELHOUSE}`, 'UV_OFFLINE=1');

  if (command.startsWith('pip install ')) {
    return `export ${env.join(' ')} && python3 -m venv .venv && export PATH="$PWD/.venv/bin:$PATH" && ${command}`;
  }

  // Preserve bootstrapped uv/Poetry executables at a fixed path across trusted
  // filesystem snapshots. This venv is for tooling only: don't activate it or
  // restore the project's .venv, which lives under the freshly extracted repo.
  return `export ${env.join(' ')} && ([ -x ${PYTHON_TOOLS}/bin/python ] || python3 -m venv ${PYTHON_TOOLS}) && export PATH="${PYTHON_TOOLS}/bin:$PATH" && (${command})`;
}

export function createE2bDifferentialRunner(deps: E2bRunnerDeps): DifferentialRunner {
  const installTimeoutMs = deps.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
  const testTimeoutMs = deps.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
  const sandboxTimeoutMs = 2 * installTimeoutMs + testTimeoutMs + 120_000;

  function createSandbox(templateId: string | undefined, network: NetworkPolicy) {
    // Failures from fresh sandbox creation are infrastructure errors for the queue to retry.
    return deps.sandboxFactory.create({
      templateId,
      apiKey: deps.apiKey,
      timeoutMs: sandboxTimeoutMs,
      network,
    });
  }

  async function close(sandbox: SandboxHandle): Promise<void> {
    try {
      await sandbox.close();
    } catch (error) {
      deps.logger.warn(`failed to close E2B sandbox: ${describeError(error)}`);
    }
  }

  async function lockdown(sandbox: SandboxHandle): Promise<SandboxRawResult | null> {
    try {
      await sandbox.denyNetworkEgress();
      return null;
    } catch (error) {
      const stderr = `network egress lockdown failed: ${describeError(error)}`;
      deps.logger.warn(stderr);
      return { exitCode: null, stdout: '', stderr, timedOut: false, durationMs: 0 };
    }
  }

  async function restoreSnapshot(ref: string, key: string): Promise<SandboxHandle | null> {
    let sandbox: SandboxHandle | undefined;
    try {
      sandbox = await createSandbox(ref, OFFLINE);
      // Snapshot or template defaults must never reopen access; reinforce the
      // creation policy before even inspecting the restored filesystem.
      if (await lockdown(sandbox)) throw new Error('could not lock down restored snapshot');
      const marker = await sandbox.run(`head -c ${key.length + 1} ${SNAPSHOT_MARKER}`, {
        timeoutMs: PREP_TIMEOUT_MS,
      });
      if (isFailedStep(marker) || marker.stdout !== key) {
        throw new Error('missing or mismatched baseline marker');
      }
      return sandbox;
    } catch (error) {
      if (sandbox) await close(sandbox);
      deps.logger.warn(`baseline snapshot rejected (${key}): ${describeError(error)}; using a cold sandbox`);
      return null;
    }
  }

  async function extract(
    sandbox: SandboxHandle,
    tree: 'base' | 'head',
    bytes: Uint8Array,
  ): Promise<SandboxRawResult | null> {
    const archive = `${STAGING}/${tree}.tar.gz`;
    await sandbox.writeFile(archive, bytes);
    // Do not rescue node_modules, .venv, or any other files from a restored
    // workspace. The archive is unpacked into a new directory at the same path.
    const step = await sandbox.run(
      `rm -rf -- ${WORKSPACE} && mkdir -- ${WORKSPACE} && tar -xzf ${archive} -C ${WORKSPACE} --strip-components=1 --no-same-owner --no-same-permissions && rm -f -- ${archive}`,
      { timeoutMs: PREP_TIMEOUT_MS },
    );
    return isFailedStep(step) ? failedPrepResult(`${tree} workspace extraction`, step) : null;
  }

  async function install(
    sandbox: SandboxHandle,
    kind: RunnerKind,
    command: string | null,
    offline: boolean,
    tree: 'base' | 'head',
  ): Promise<SandboxRawResult | null> {
    if (command === null) return null;
    const step = await sandbox.run(installCommand(kind, command, offline), {
      cwd: WORKSPACE,
      timeoutMs: installTimeoutMs,
    });
    return isFailedStep(step) ? failedPrepResult(`${tree} dependency installation`, step) : null;
  }

  async function saveSnapshot(
    sandbox: SandboxHandle,
    request: DifferentialRunRequest,
    key: string,
  ): Promise<string | null> {
    let ref: string | null = null;
    try {
      await sandbox.writeFile(SNAPSHOT_MARKER, key);
      ref = await sandbox.createSnapshot();
      if (ref !== null) await deps.snapshotCache?.set(request.repoFullName, key, ref);
    } catch (error) {
      deps.logger.warn(`could not record baseline snapshot (${key}): ${describeError(error)}`);
    }
    // Even if Redis is down, the current Run B can use the snapshot.
    return ref;
  }

  async function prepareBase(
    request: DifferentialRunRequest,
    key: string,
  ): Promise<BasePreparation> {
    const needsSeed = request.installCommand !== null &&
      (deps.snapshotCache !== undefined || request.headInstallCommand !== null);
    const cachedRef = needsSeed
      ? await deps.snapshotCache?.get(request.repoFullName, key).catch((error: unknown) => {
        deps.logger.warn(`baseline snapshot lookup failed (${key}): ${describeError(error)}`);
        return null;
      })
      : null;

    if (cachedRef) {
      const cachedSandbox = await restoreSnapshot(cachedRef, key);
      if (cachedSandbox) {
        let prepared = false;
        try {
          const failure = await extract(cachedSandbox, 'base', request.tarball) ??
            await install(cachedSandbox, request.runnerKind, request.installCommand, true, 'base');
          if (!failure) {
            prepared = true;
            return { sandbox: cachedSandbox, snapshotRef: cachedRef };
          }
          deps.logger.warn(`baseline snapshot could not provision the base (${key}): ${failure.stderr}; using a cold sandbox`);
        } finally {
          if (!prepared) await close(cachedSandbox);
        }
      }
    }

    const network: NetworkPolicy = request.installCommand === null
      ? OFFLINE
      : {
        mode: 'registries',
        allowOut: request.runnerKind === 'pytest' ? REGISTRY_HOSTS.python : REGISTRY_HOSTS.node,
      };
    const sandbox = await createSandbox(deps.defaultTemplateId, network);
    let prepared = false;
    try {
      const failure = await extract(sandbox, 'base', request.tarball) ??
        await install(sandbox, request.runnerKind, request.installCommand, false, 'base');
      if (failure) return { failure };

      // pip's HTTP cache is not an offline index. Best effort: build/download
      // wheels for standard requirements in the untouched base, before lockdown.
      const requirementsPrefix = 'pip install -r ';
      if (needsSeed && request.runnerKind === 'pytest' &&
        request.installCommand?.startsWith(requirementsPrefix)) {
        const requirements = request.installCommand.slice(requirementsPrefix.length);
        const wheels = await sandbox.run(
          `PIP_CACHE_DIR=${PACKAGE_CACHE}/pip .venv/bin/python -m pip wheel --disable-pip-version-check --wheel-dir ${WHEELHOUSE} -r ${requirements}`,
          { cwd: WORKSPACE, timeoutMs: installTimeoutMs },
        );
        if (isFailedStep(wheels)) deps.logger.warn('could not warm the baseline Python wheel cache');
      }

      const networkFailure = await lockdown(sandbox);
      if (networkFailure) return { failure: networkFailure };

      // A snapshot may seed head downloads only if it contains no PR patch,
      // no test results, and was created with network access already denied.
      const snapshotRef = needsSeed ? await saveSnapshot(sandbox, request, key) : null;
      prepared = true;
      return { sandbox, snapshotRef };
    } finally {
      if (!prepared) await close(sandbox);
    }
  }

  async function test(sandbox: SandboxHandle, request: DifferentialRunRequest): Promise<SandboxRawResult> {
    const report = request.collectCaseResults ? caseReportOptions(request.runnerKind) : null;
    const command = report ? `${request.testCommand} ${report.args}` : request.testCommand;
    const testCommand = request.runnerKind === 'pytest'
      ? `export PATH="$PWD/.venv/bin:$PATH"; ${command}`
      : command;
    const raw = await sandbox.run(testCommand, { cwd: WORKSPACE, timeoutMs: testTimeoutMs });
    if (!report || raw.timedOut || raw.exitCode === null) return raw;

    try {
      const read = await sandbox.run(report.readCommand, { cwd: WORKSPACE, timeoutMs: REPORT_TIMEOUT_MS });
      if (!isFailedStep(read)) {
        const caseResults = parseTestCases(request.runnerKind, read.stdout, WORKSPACE);
        if (caseResults !== undefined) return { ...raw, caseResults };
      }
    } catch (error) {
      deps.logger.warn(`could not collect ${request.runnerKind} case evidence: ${describeError(error)}`);
    }
    return raw;
  }

  async function runBase(sandbox: SandboxHandle, request: DifferentialRunRequest) {
    try {
      const patchFile = `${STAGING}/test-only.patch`;
      await sandbox.writeFile(patchFile, request.testOnlyDiff);
      const patch = await sandbox.run(`git apply --whitespace=nowarn ${patchFile}`, {
        cwd: WORKSPACE,
        timeoutMs: PREP_TIMEOUT_MS,
      });
      return isFailedStep(patch)
        ? failedPrepResult('test-only patch application', patch)
        : await test(sandbox, request);
    } finally {
      await close(sandbox);
    }
  }

  async function runHead(request: DifferentialRunRequest, key: string, snapshotRef: string | null) {
    const restored = snapshotRef !== null && request.headInstallCommand !== null
      ? await restoreSnapshot(snapshotRef, key)
      : null;
    const sandbox = restored ?? await createSandbox(deps.defaultTemplateId, OFFLINE);
    try {
      const failure = (restored ? null : await lockdown(sandbox)) ??
        await extract(sandbox, 'head', request.headTarball) ??
        await install(sandbox, request.runnerKind, request.headInstallCommand, true, 'head');
      return failure ?? await test(sandbox, request);
    } finally {
      await close(sandbox);
    }
  }

  return async (request) => {
    const key = baseSnapshotKey(request, deps.defaultTemplateId);
    const base = await prepareBase(request, key);
    // Run B can still provide evidence when Run A cannot prepare or apply its
    // patch. If either has an infrastructure exception, await both cleanups
    // before handing it back to the queue for retry.
    const [runA, runB] = await Promise.allSettled([
      'failure' in base ? base.failure : runBase(base.sandbox, request),
      runHead(request, key, 'failure' in base ? null : base.snapshotRef),
    ]);
    if (runA.status === 'rejected') throw runA.reason;
    if (runB.status === 'rejected') throw runB.reason;
    return { runA: runA.value, runB: runB.value };
  };
}
