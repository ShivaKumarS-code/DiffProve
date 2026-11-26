import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '../domain.js';
import { createE2bDifferentialRunner } from './e2b-runner.js';
import type {
  DifferentialRunRequest,
  EnvSnapshotCache,
  SandboxFactory,
  SandboxHandle,
  SandboxRawResult,
} from './types.js';

const STAGING = '/tmp/diffprove';
const WORKSPACE = `${STAGING}/workspace`;
const RUN_A = `${STAGING}/run-a`;
const RUN_B = `${STAGING}/run-b`;

const EXTRACT = `mkdir -p ${WORKSPACE} && tar -xzf ${STAGING}/base.tar.gz -C ${WORKSPACE} --strip-components=1`;

function relocateVenv(runDir: string): string {
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

const RELOCATE_RUN_A = relocateVenv(RUN_A);
const RELOCATE_RUN_B = relocateVenv(RUN_B);

const PYTEST_TEST_COMMAND = 'export PATH="$PWD/.venv/bin:$PATH"; pytest "tests/test_a.py"';

const TARBALL = Uint8Array.from([31, 139, 8, 0, 1, 2, 3]);

const ok = (): SandboxRawResult => ({
  exitCode: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
  durationMs: 1,
});

type RunOpts = { cwd?: string; timeoutMs?: number };

type Call =
  | { kind: 'run'; command: string; opts?: RunOpts }
  | { kind: 'writeFile'; path: string; content: string | Uint8Array }
  | { kind: 'network'; denyAll: boolean }
  | { kind: 'snapshot'; name: string }
  | { kind: 'close' };

interface FakeFactoryOptions {
  onRun?: (command: string, opts?: RunOpts) => SandboxRawResult | Promise<SandboxRawResult>;
  onNetwork?: (denyAll: boolean) => void;
  onSnapshot?: (name: string) => string | null;
  createError?: Error;
  closeError?: Error;
}

/** Fake `SandboxFactory` that records every handle call in order. */
function createFakeFactory(options: FakeFactoryOptions = {}) {
  const calls: Call[] = [];
  const createCalls: { templateId?: string; apiKey?: string; timeoutMs?: number }[] = [];

  const factory: SandboxFactory = {
    async create(opts) {
      createCalls.push(opts);
      if (options.createError) {
        throw options.createError;
      }
      const handle: SandboxHandle = {
        async run(command, runOpts) {
          calls.push({ kind: 'run', command, opts: runOpts });
          return options.onRun ? await options.onRun(command, runOpts) : ok();
        },
        async writeFile(path, content) {
          calls.push({ kind: 'writeFile', path, content });
        },
        async updateNetworkEgress(denyAll) {
          calls.push({ kind: 'network', denyAll });
          options.onNetwork?.(denyAll);
        },
        async createSnapshot(name) {
          calls.push({ kind: 'snapshot', name });
          return options.onSnapshot ? options.onSnapshot(name) : 'snap-ref-1';
        },
        async close() {
          calls.push({ kind: 'close' });
          if (options.closeError) {
            throw options.closeError;
          }
        },
      };
      return handle;
    },
  };

  return { factory, calls, createCalls };
}

function createLogger() {
  const info = vi.fn<(message: string) => void>();
  const warn = vi.fn<(message: string) => void>();
  const error = vi.fn<(message: string) => void>();
  const logger: Logger = { info, warn, error };
  return { logger, info, warn, error };
}

function createFakeCache(options: { value?: string | null; getError?: Error; setError?: Error } = {}) {
  const get = vi.fn<(repoFullName: string, lockfileKey: string) => Promise<string | null>>();
  const set = vi.fn<
    (repoFullName: string, lockfileKey: string, templateRef: string) => Promise<void>
  >();
  get.mockResolvedValue(options.value ?? null);
  if (options.getError) {
    get.mockRejectedValue(options.getError);
  }
  set.mockResolvedValue();
  if (options.setError) {
    set.mockRejectedValue(options.setError);
  }
  const cache: EnvSnapshotCache = { get, set };
  return { cache, get, set };
}

function runCalls(calls: readonly Call[]): Extract<Call, { kind: 'run' }>[] {
  return calls.filter((call): call is Extract<Call, { kind: 'run' }> => call.kind === 'run');
}

/** Human-readable, order-preserving view of every handle call. */
function timeline(calls: readonly Call[]): string[] {
  return calls.map((call) => {
    switch (call.kind) {
      case 'run':
        return `run ${call.command} (cwd=${call.opts?.cwd ?? '-'}, timeout=${call.opts?.timeoutMs ?? '-'})`;
      case 'writeFile':
        return `write ${call.path}`;
      case 'network':
        return `network denyAll=${call.denyAll}`;
      case 'snapshot':
        return `snapshot ${call.name}`;
      case 'close':
        return 'close';
    }
  });
}

function createRequest(overrides: Partial<DifferentialRunRequest> = {}): DifferentialRunRequest {
  return {
    repoFullName: 'octocat/hello-world',
    baseSha: 'base-sha',
    headSha: 'head-sha',
    tarball: TARBALL,
    testOnlyDiff: 'test-only-patch-body',
    fullDiff: 'full-patch-body',
    testCommand: 'pytest "tests/test_a.py"',
    installCommand: 'pip install -e . -r requirements.txt',
    headInstallCommand: null,
    runnerKind: 'pytest',
    lockfileKey: 'lock-abc123',
    ...overrides,
  };
}

describe('createE2bDifferentialRunner', () => {
  it('runs the cold (cache MISS) sequence in order and records a snapshot', async () => {
    const { factory, calls, createCalls } = createFakeFactory();
    const { cache, get, set } = createFakeCache();
    const { logger } = createLogger();
    const request = createRequest();
    const runner = createE2bDifferentialRunner({
      sandboxFactory: factory,
      snapshotCache: cache,
      logger,
    });

    const result = await runner(request);

    expect(timeline(calls)).toEqual([
      'write /tmp/diffprove/base.tar.gz',
      'write /tmp/diffprove/test-only.patch',
      'write /tmp/diffprove/full.patch',
      `run ${EXTRACT} (cwd=-, timeout=-)`,
      `run pip install -e . -r requirements.txt (cwd=${WORKSPACE}, timeout=240000)`,
      'snapshot diffprove-lock-abc123',
      `run cp -a ${WORKSPACE} ${RUN_A} (cwd=-, timeout=-)`,
      `run cp -a ${WORKSPACE} ${RUN_B} (cwd=-, timeout=-)`,
      `run ${RELOCATE_RUN_A} (cwd=-, timeout=-)`,
      `run ${RELOCATE_RUN_B} (cwd=-, timeout=-)`,
      `run git apply --whitespace=nowarn /tmp/diffprove/test-only.patch (cwd=${RUN_A}, timeout=30000)`,
      `run git apply --whitespace=nowarn /tmp/diffprove/full.patch (cwd=${RUN_B}, timeout=30000)`,
      'network denyAll=true',
      `run ${PYTEST_TEST_COMMAND} (cwd=${RUN_A}, timeout=120000)`,
      `run ${PYTEST_TEST_COMMAND} (cwd=${RUN_B}, timeout=120000)`,
      'close',
    ]);

    // Defaults: 240s install + 120s test per run, doubled, plus 60s slack.
    expect(createCalls).toEqual([
      { templateId: undefined, apiKey: undefined, timeoutMs: 780_000 },
    ]);
    expect(get.mock.calls).toEqual([['octocat/hello-world', 'lock-abc123']]);
    expect(set.mock.calls).toEqual([['octocat/hello-world', 'lock-abc123', 'snap-ref-1']]);
    expect(result.runA).toEqual(ok());
    expect(result.runB).toEqual(ok());

    const writes = calls.filter(
      (call): call is Extract<Call, { kind: 'writeFile' }> => call.kind === 'writeFile',
    );
    expect(writes.map((write) => write.path)).toEqual([
      '/tmp/diffprove/base.tar.gz',
      '/tmp/diffprove/test-only.patch',
      '/tmp/diffprove/full.patch',
    ]);
    // The tarball is binary: it must arrive as bytes, not as a decoded string.
    expect(writes[0]?.content).toBeInstanceOf(Uint8Array);
    expect(Array.from(writes[0]?.content as Uint8Array)).toEqual(Array.from(TARBALL));
    expect(writes[1]?.content).toBe('test-only-patch-body');
    expect(writes[2]?.content).toBe('full-patch-body');
  });

  it('boots from the cached snapshot and rescues node_modules for node projects', async () => {
    const { factory, calls, createCalls } = createFakeFactory();
    const { cache, set } = createFakeCache({ value: 'snap-tpl' });
    const { logger } = createLogger();
    const request = createRequest({
      runnerKind: 'vitest',
      installCommand: 'npm ci',
      testCommand: 'npx vitest run tests/a.test.ts',
      lockfileKey: 'lock-node',
    });
    const runner = createE2bDifferentialRunner({
      sandboxFactory: factory,
      snapshotCache: cache,
      logger,
    });

    await runner(request);

    expect(createCalls[0]?.templateId).toBe('snap-tpl');
    expect(timeline(calls)).toEqual([
      'write /tmp/diffprove/base.tar.gz',
      'write /tmp/diffprove/test-only.patch',
      'write /tmp/diffprove/full.patch',
      `run mv ${WORKSPACE}/node_modules /tmp/diffprove/node_modules 2>/dev/null || true (cwd=-, timeout=-)`,
      `run rm -rf ${WORKSPACE} && ${EXTRACT} (cwd=-, timeout=-)`,
      `run mv /tmp/diffprove/node_modules ${WORKSPACE}/node_modules 2>/dev/null || true (cwd=-, timeout=-)`,
      `run cp -a ${WORKSPACE} ${RUN_A} (cwd=-, timeout=-)`,
      `run cp -a ${WORKSPACE} ${RUN_B} (cwd=-, timeout=-)`,
      `run git apply --whitespace=nowarn /tmp/diffprove/test-only.patch (cwd=${RUN_A}, timeout=30000)`,
      `run git apply --whitespace=nowarn /tmp/diffprove/full.patch (cwd=${RUN_B}, timeout=30000)`,
      'network denyAll=true',
      `run npx vitest run tests/a.test.ts (cwd=${RUN_A}, timeout=120000)`,
      `run npx vitest run tests/a.test.ts (cwd=${RUN_B}, timeout=120000)`,
      'close',
    ]);

    // A HIT already owns a valid environment: no install, no re-snapshot, no .venv relocation.
    expect(runCalls(calls).map((call) => call.command)).not.toContain('npm ci');
    expect(runCalls(calls).some((call) => call.command.includes('.venv'))).toBe(false);
    expect(calls.some((call) => call.kind === 'snapshot')).toBe(false);
    expect(set).not.toHaveBeenCalled();
  });

  it('boots from the cached snapshot and rescues .venv for pytest projects', async () => {
    const { factory, calls, createCalls } = createFakeFactory();
    const { cache, set } = createFakeCache({ value: 'snap-tpl' });
    const { logger } = createLogger();
    const request = createRequest({ lockfileKey: 'lock-py' });
    const runner = createE2bDifferentialRunner({
      sandboxFactory: factory,
      snapshotCache: cache,
      logger,
    });

    await runner(request);

    expect(createCalls[0]?.templateId).toBe('snap-tpl');
    expect(timeline(calls)).toEqual([
      'write /tmp/diffprove/base.tar.gz',
      'write /tmp/diffprove/test-only.patch',
      'write /tmp/diffprove/full.patch',
      `run mv ${WORKSPACE}/.venv /tmp/diffprove/.venv 2>/dev/null || true (cwd=-, timeout=-)`,
      `run rm -rf ${WORKSPACE} && ${EXTRACT} (cwd=-, timeout=-)`,
      `run mv /tmp/diffprove/.venv ${WORKSPACE}/.venv 2>/dev/null || true (cwd=-, timeout=-)`,
      `run cp -a ${WORKSPACE} ${RUN_A} (cwd=-, timeout=-)`,
      `run cp -a ${WORKSPACE} ${RUN_B} (cwd=-, timeout=-)`,
      `run ${RELOCATE_RUN_A} (cwd=-, timeout=-)`,
      `run ${RELOCATE_RUN_B} (cwd=-, timeout=-)`,
      `run git apply --whitespace=nowarn /tmp/diffprove/test-only.patch (cwd=${RUN_A}, timeout=30000)`,
      `run git apply --whitespace=nowarn /tmp/diffprove/full.patch (cwd=${RUN_B}, timeout=30000)`,
      'network denyAll=true',
      `run ${PYTEST_TEST_COMMAND} (cwd=${RUN_A}, timeout=120000)`,
      `run ${PYTEST_TEST_COMMAND} (cwd=${RUN_B}, timeout=120000)`,
      'close',
    ]);
    expect(
      runCalls(calls).filter((call) => call.command.includes('node_modules')),
    ).toHaveLength(0);
    expect(runCalls(calls).map((call) => call.command)).not.toContain(
      'pip install -e . -r requirements.txt',
    );
    expect(calls.some((call) => call.kind === 'snapshot')).toBe(false);
    expect(set).not.toHaveBeenCalled();
  });

  it('aborts both runs when the base dependency install fails', async () => {
    const installFailure: SandboxRawResult = {
      exitCode: 2,
      stdout: 'partial install output',
      stderr: 'pip: no matching distribution',
      timedOut: false,
      durationMs: 4_321,
    };
    const { factory, calls } = createFakeFactory({
      onRun: (command) => (command === 'pip install -e . -r requirements.txt' ? installFailure : ok()),
    });
    const { cache, set } = createFakeCache();
    const { logger } = createLogger();
    const request = createRequest();
    const runner = createE2bDifferentialRunner({
      sandboxFactory: factory,
      snapshotCache: cache,
      logger,
    });

    const result = await runner(request);

    const expected: SandboxRawResult = {
      exitCode: null,
      stdout: 'partial install output',
      stderr: 'dependency installation failed:\npip: no matching distribution',
      timedOut: false,
      durationMs: 4_321,
    };
    expect(result.runA).toEqual(expected);
    expect(result.runB).toEqual(expected);
    expect(result.runA).not.toBe(result.runB);

    const commands = runCalls(calls).map((call) => call.command);
    expect(commands).not.toContain(`cp -a ${WORKSPACE} ${RUN_A}`);
    expect(commands).not.toContain(`cp -a ${WORKSPACE} ${RUN_B}`);
    expect(commands.some((command) => command.includes(request.testCommand))).toBe(false);
    expect(calls.some((call) => call.kind === 'snapshot')).toBe(false);
    expect(set).not.toHaveBeenCalled();
    expect(calls.filter((call) => call.kind === 'close')).toHaveLength(1);
  });

  it('aborts both runs when base workspace extraction fails', async () => {
    const extractFailure: SandboxRawResult = {
      exitCode: 1,
      stdout: '',
      stderr: 'tar: Cannot open: Permission denied',
      timedOut: false,
      durationMs: 15,
    };
    const { factory, calls } = createFakeFactory({
      onRun: (command) => (command === EXTRACT ? extractFailure : ok()),
    });
    const { cache, set } = createFakeCache();
    const { logger } = createLogger();
    const request = createRequest();
    const runner = createE2bDifferentialRunner({
      sandboxFactory: factory,
      snapshotCache: cache,
      logger,
    });

    const result = await runner(request);

    const expected: SandboxRawResult = {
      exitCode: null,
      stdout: '',
      stderr: 'workspace extraction failed:\ntar: Cannot open: Permission denied',
      timedOut: false,
      durationMs: 15,
    };
    expect(result.runA).toEqual(expected);
    expect(result.runB).toEqual(expected);
    expect(runCalls(calls).map((call) => call.command)).toEqual([EXTRACT]);
    expect(calls.some((call) => call.kind === 'snapshot')).toBe(false);
    expect(set).not.toHaveBeenCalled();
    expect(calls.filter((call) => call.kind === 'close')).toHaveLength(1);
  });

  it('aborts both runs when workspace copy fails', async () => {
    const copyFailure: SandboxRawResult = {
      exitCode: 1,
      stdout: '',
      stderr: 'cp: cannot create directory',
      timedOut: false,
      durationMs: 22,
    };
    const { factory, calls } = createFakeFactory({
      onRun: (command) => (command === `cp -a ${WORKSPACE} ${RUN_A}` ? copyFailure : ok()),
    });
    const { cache } = createFakeCache();
    const { logger } = createLogger();
    const request = createRequest();
    const runner = createE2bDifferentialRunner({
      sandboxFactory: factory,
      snapshotCache: cache,
      logger,
    });

    const result = await runner(request);

    const expected: SandboxRawResult = {
      exitCode: null,
      stdout: '',
      stderr: 'run-a workspace copy failed:\ncp: cannot create directory',
      timedOut: false,
      durationMs: 22,
    };
    expect(result.runA).toEqual(expected);
    expect(result.runB).toEqual(expected);
    const commands = runCalls(calls).map((call) => call.command);
    expect(commands).not.toContain(`cp -a ${WORKSPACE} ${RUN_B}`);
    expect(commands.some((command) => command.includes('git apply'))).toBe(false);
    expect(commands.some((command) => command.includes(request.testCommand))).toBe(false);
    expect(calls.filter((call) => call.kind === 'close')).toHaveLength(1);
  });

  it('treats exitCode: null on a prep step as a failed step instead of continuing', async () => {
    const sdkError: SandboxRawResult = {
      exitCode: null,
      stdout: '',
      stderr: '[invalid_argument] cwd does not exist',
      timedOut: false,
      durationMs: 5,
    };
    const { factory, calls } = createFakeFactory({
      onRun: (command) => (command === 'pip install -e . -r requirements.txt' ? sdkError : ok()),
    });
    const { cache } = createFakeCache();
    const { logger } = createLogger();
    const request = createRequest();
    const runner = createE2bDifferentialRunner({
      sandboxFactory: factory,
      snapshotCache: cache,
      logger,
    });

    const result = await runner(request);

    const expected: SandboxRawResult = {
      exitCode: null,
      stdout: '',
      stderr: 'dependency installation failed:\n[invalid_argument] cwd does not exist',
      timedOut: false,
      durationMs: 5,
    };
    expect(result.runA).toEqual(expected);
    expect(result.runB).toEqual(expected);
    const commands = runCalls(calls).map((call) => call.command);
    expect(commands).not.toContain(`cp -a ${WORKSPACE} ${RUN_A}`);
    expect(commands.some((command) => command.includes(request.testCommand))).toBe(false);
  });

  it('aborts both runs if pytest .venv relocation fails', async () => {
    const relocateFailure: SandboxRawResult = {
      exitCode: 1,
      stdout: '',
      stderr: 'python3: Permission denied',
      timedOut: false,
      durationMs: 11,
    };
    const { factory, calls } = createFakeFactory({
      onRun: (command) => (command === RELOCATE_RUN_B ? relocateFailure : ok()),
    });
    const { cache } = createFakeCache();
    const { logger } = createLogger();
    const request = createRequest();
    const runner = createE2bDifferentialRunner({
      sandboxFactory: factory,
      snapshotCache: cache,
      logger,
    });

    const result = await runner(request);

    const expected: SandboxRawResult = {
      exitCode: null,
      stdout: '',
      stderr: 'run-b .venv relocation failed:\npython3: Permission denied',
      timedOut: false,
      durationMs: 11,
    };
    expect(result.runA).toEqual(expected);
    expect(result.runB).toEqual(expected);
    const commands = runCalls(calls).map((call) => call.command);
    expect(commands.some((command) => command.includes('git apply'))).toBe(false);
    expect(commands.some((command) => command.includes(request.testCommand))).toBe(false);
  });

  it('reports a test-only patch failure for Run A only, still testing Run B', async () => {
    const patchFailure: SandboxRawResult = {
      exitCode: 1,
      stdout: 'checking patch',
      stderr: 'error: patch does not apply',
      timedOut: false,
      durationMs: 12,
    };
    const { factory, calls } = createFakeFactory({
      onRun: (command) => (command.includes('test-only.patch') ? patchFailure : ok()),
    });
    const { cache } = createFakeCache();
    const { logger } = createLogger();
    const request = createRequest();
    const runner = createE2bDifferentialRunner({
      sandboxFactory: factory,
      snapshotCache: cache,
      logger,
    });

    const result = await runner(request);

    expect(result.runA).toEqual({
      exitCode: null,
      stdout: 'checking patch',
      stderr: 'test-only patch application failed:\nerror: patch does not apply',
      timedOut: false,
      durationMs: 12,
    });
    expect(result.runB).toEqual(ok());
    const tests = runCalls(calls).filter((call) => call.command === PYTEST_TEST_COMMAND);
    expect(tests.map((call) => call.opts?.cwd)).toEqual([RUN_B]);
  });

  it('reports a full patch failure for Run B only, still testing Run A', async () => {
    const patchFailure: SandboxRawResult = {
      exitCode: 1,
      stdout: '',
      stderr: 'error: corrupt patch at line 4',
      timedOut: false,
      durationMs: 9,
    };
    const { factory, calls } = createFakeFactory({
      onRun: (command) => (command.includes('full.patch') ? patchFailure : ok()),
    });
    const { cache } = createFakeCache();
    const { logger } = createLogger();
    const request = createRequest();
    const runner = createE2bDifferentialRunner({
      sandboxFactory: factory,
      snapshotCache: cache,
      logger,
    });

    const result = await runner(request);

    expect(result.runB).toEqual({
      exitCode: null,
      stdout: '',
      stderr: 'full patch application failed:\nerror: corrupt patch at line 4',
      timedOut: false,
      durationMs: 9,
    });
    expect(result.runA).toEqual(ok());
    const tests = runCalls(calls).filter((call) => call.command === PYTEST_TEST_COMMAND);
    expect(tests.map((call) => call.opts?.cwd)).toEqual([RUN_A]);
  });

  it('runs the head install inside run-b before the egress lockdown', async () => {
    const { factory, calls } = createFakeFactory();
    const { cache } = createFakeCache();
    const { logger } = createLogger();
    const request = createRequest({
      runnerKind: 'vitest',
      installCommand: 'npm ci',
      headInstallCommand: 'npm install --include=dev',
      testCommand: 'npx vitest run tests/a.test.ts',
    });
    const runner = createE2bDifferentialRunner({
      sandboxFactory: factory,
      snapshotCache: cache,
      logger,
    });

    await runner(request);

    const headInstallIndex = calls.findIndex(
      (call) => call.kind === 'run' && call.command === 'npm install --include=dev',
    );
    const lockdownIndex = calls.findIndex((call) => call.kind === 'network');
    expect(headInstallIndex).toBeGreaterThan(-1);
    expect(lockdownIndex).toBeGreaterThan(headInstallIndex);
    expect(runCalls(calls).find((call) => call.command === 'npm install --include=dev')?.opts).toEqual(
      { cwd: RUN_B, timeoutMs: 240_000 },
    );
    // The network is still open for that install.
    expect(calls[lockdownIndex]).toEqual({ kind: 'network', denyAll: true });
  });

  it('reports a head install failure for Run B only', async () => {
    const headFailure: SandboxRawResult = {
      exitCode: 1,
      stdout: 'head install output',
      stderr: 'ERESOLVE unable to resolve dependency tree',
      timedOut: false,
      durationMs: 77,
    };
    const { factory, calls } = createFakeFactory({
      onRun: (command) =>
        command === 'npm install --include=dev' ? headFailure : ok(),
    });
    const { cache } = createFakeCache();
    const { logger } = createLogger();
    const request = createRequest({
      runnerKind: 'vitest',
      installCommand: 'npm ci',
      headInstallCommand: 'npm install --include=dev',
      testCommand: 'npx vitest run tests/a.test.ts',
    });
    const runner = createE2bDifferentialRunner({
      sandboxFactory: factory,
      snapshotCache: cache,
      logger,
    });

    const result = await runner(request);

    expect(result.runB).toEqual({
      exitCode: null,
      stdout: 'head install output',
      stderr: 'head dependency installation failed:\nERESOLVE unable to resolve dependency tree',
      timedOut: false,
      durationMs: 77,
    });
    expect(result.runA).toEqual(ok());
    const tests = runCalls(calls).filter((call) => call.command === request.testCommand);
    expect(tests.map((call) => call.opts?.cwd)).toEqual([RUN_A]);
  });

  it('aborts both runs when egress lockdown is rejected', async () => {
    const { factory, calls } = createFakeFactory({
      onNetwork: (denyAll) => {
        if (denyAll) {
          throw new Error('egress api unavailable');
        }
      },
    });
    const { cache } = createFakeCache();
    const { logger } = createLogger();
    const request = createRequest();
    const runner = createE2bDifferentialRunner({
      sandboxFactory: factory,
      snapshotCache: cache,
      logger,
    });

    const result = await runner(request);

    const expected: SandboxRawResult = {
      exitCode: null,
      stdout: '',
      stderr: 'network egress lockdown failed: egress api unavailable',
      timedOut: false,
      durationMs: 0,
    };
    expect(result.runA).toEqual(expected);
    expect(result.runB).toEqual(expected);
    expect(runCalls(calls).some((call) => call.command.includes(request.testCommand))).toBe(false);
    expect(calls.filter((call) => call.kind === 'close')).toHaveLength(1);
  });

  it('propagates sandbox creation failures and closes nothing', async () => {
    const boom = new Error('sandbox create failed');
    const { factory, calls } = createFakeFactory({ createError: boom });
    const { cache } = createFakeCache();
    const { logger } = createLogger();
    const runner = createE2bDifferentialRunner({
      sandboxFactory: factory,
      snapshotCache: cache,
      logger,
    });

    await expect(runner(createRequest())).rejects.toBe(boom);
    expect(calls).toEqual([]);
  });

  it('degrades a failing snapshot lookup to a cold run', async () => {
    const { factory, calls, createCalls } = createFakeFactory();
    const { cache, set } = createFakeCache({ getError: new Error('redis down') });
    const { logger, warn } = createLogger();
    const request = createRequest();
    const runner = createE2bDifferentialRunner({
      sandboxFactory: factory,
      snapshotCache: cache,
      logger,
    });

    const result = await runner(request);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('snapshot lookup failed');
    expect(createCalls[0]?.templateId).toBeUndefined();
    expect(runCalls(calls).map((call) => call.command)).toContain(
      'pip install -e . -r requirements.txt',
    );
    expect(set.mock.calls).toEqual([['octocat/hello-world', 'lock-abc123', 'snap-ref-1']]);
    expect(result.runA).toEqual(ok());
  });

  it('passes a timed-out test result through unchanged', async () => {
    const timedOutRaw: SandboxRawResult = {
      exitCode: null,
      stdout: 'partial test output',
      stderr: 'test timed out after 120000ms',
      timedOut: true,
      durationMs: 120_000,
    };
    const { factory } = createFakeFactory({
      onRun: (command) => (command === PYTEST_TEST_COMMAND ? timedOutRaw : ok()),
    });
    const { cache } = createFakeCache();
    const { logger } = createLogger();
    const runner = createE2bDifferentialRunner({
      sandboxFactory: factory,
      snapshotCache: cache,
      logger,
    });

    const result = await runner(createRequest());

    expect(result.runA).toEqual(timedOutRaw);
    expect(result.runB).toEqual(timedOutRaw);
  });

  it('skips the cache write when snapshotting yields no reference', async () => {
    const { factory, calls } = createFakeFactory({ onSnapshot: () => null });
    const { cache, set } = createFakeCache();
    const { logger } = createLogger();
    const runner = createE2bDifferentialRunner({
      sandboxFactory: factory,
      snapshotCache: cache,
      logger,
    });

    const result = await runner(createRequest());

    expect(calls.some((call) => call.kind === 'snapshot')).toBe(true);
    expect(set).not.toHaveBeenCalled();
    expect(result.runA).toEqual(ok());
  });

  it('still resolves when closing the sandbox fails', async () => {
    const { factory } = createFakeFactory({ closeError: new Error('kill failed') });
    const { cache } = createFakeCache();
    const { logger, warn } = createLogger();
    const runner = createE2bDifferentialRunner({
      sandboxFactory: factory,
      snapshotCache: cache,
      logger,
    });

    await expect(runner(createRequest())).resolves.toEqual({ runA: ok(), runB: ok() });
    expect(warn.mock.calls.map(([message]) => message)).toContain(
      'failed to close E2B sandbox: kill failed',
    );
  });

  it('runs jest testCommand directly without .venv PATH wrapping or .venv relocation', async () => {
    const { factory, calls } = createFakeFactory();
    const { cache } = createFakeCache();
    const { logger } = createLogger();
    const runner = createE2bDifferentialRunner({
      sandboxFactory: factory,
      snapshotCache: cache,
      logger,
    });

    await runner(
      createRequest({
        runnerKind: 'jest',
        installCommand: 'npm ci',
        testCommand: 'npx jest tests/a.test.js',
      }),
    );

    const tests = runCalls(calls).filter((call) => call.command === 'npx jest tests/a.test.js');
    expect(tests.map((call) => call.opts?.cwd)).toEqual([RUN_A, RUN_B]);
    expect(runCalls(calls).some((call) => call.command.includes('.venv'))).toBe(false);
  });

  it('aborts both runs when cached workspace reset extraction fails', async () => {
    const resetFailure: SandboxRawResult = {
      exitCode: 1,
      stdout: '',
      stderr: 'tar: unexpected EOF',
      timedOut: false,
      durationMs: 14,
    };
    const { factory, calls } = createFakeFactory({
      onRun: (command) => (command === `rm -rf ${WORKSPACE} && ${EXTRACT}` ? resetFailure : ok()),
    });
    const { cache } = createFakeCache({ value: 'snap-tpl' });
    const { logger } = createLogger();
    const runner = createE2bDifferentialRunner({
      sandboxFactory: factory,
      snapshotCache: cache,
      logger,
    });

    const result = await runner(createRequest());

    const expected: SandboxRawResult = {
      exitCode: null,
      stdout: '',
      stderr: 'workspace extraction failed:\ntar: unexpected EOF',
      timedOut: false,
      durationMs: 14,
    };
    expect(result.runA).toEqual(expected);
    expect(result.runB).toEqual(expected);
    const commands = runCalls(calls).map((call) => call.command);
    expect(commands).not.toContain(`cp -a ${WORKSPACE} ${RUN_A}`);
    expect(commands.some((command) => command.includes(PYTEST_TEST_COMMAND))).toBe(false);
  });
});
