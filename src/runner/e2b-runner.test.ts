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

const EXTRACT =
  'mkdir -p /workspace && tar -xzf /tmp/diffprove/base.tar.gz -C /workspace --strip-components=1';

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
      'run pip install -e . -r requirements.txt (cwd=/workspace, timeout=240000)',
      'run cp -a /workspace /run-a (cwd=-, timeout=-)',
      'run cp -a /workspace /run-b (cwd=-, timeout=-)',
      'run git apply --whitespace=nowarn /tmp/diffprove/test-only.patch (cwd=/run-a, timeout=30000)',
      'run git apply --whitespace=nowarn /tmp/diffprove/full.patch (cwd=/run-b, timeout=30000)',
      'network denyAll=true',
      'run pytest "tests/test_a.py" (cwd=/run-a, timeout=120000)',
      'run pytest "tests/test_a.py" (cwd=/run-b, timeout=120000)',
      'snapshot diffprove-lock-abc123',
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
      'run cp -a /workspace/node_modules /tmp/diffprove/node_modules || true (cwd=-, timeout=-)',
      `run rm -rf /workspace && ${EXTRACT} (cwd=-, timeout=-)`,
      'run mv /tmp/diffprove/node_modules /workspace/node_modules || true (cwd=-, timeout=-)',
      'run cp -a /workspace /run-a (cwd=-, timeout=-)',
      'run cp -a /workspace /run-b (cwd=-, timeout=-)',
      'run git apply --whitespace=nowarn /tmp/diffprove/test-only.patch (cwd=/run-a, timeout=30000)',
      'run git apply --whitespace=nowarn /tmp/diffprove/full.patch (cwd=/run-b, timeout=30000)',
      'network denyAll=true',
      'run npx vitest run tests/a.test.ts (cwd=/run-a, timeout=120000)',
      'run npx vitest run tests/a.test.ts (cwd=/run-b, timeout=120000)',
      'close',
    ]);

    // A HIT already owns a valid environment: no install, no re-snapshot.
    expect(runCalls(calls).map((call) => call.command)).not.toContain('npm ci');
    expect(calls.some((call) => call.kind === 'snapshot')).toBe(false);
    expect(set).not.toHaveBeenCalled();
  });

  it('resets only the tree for a pytest snapshot HIT (deps live in site-packages)', async () => {
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
      `run rm -rf /workspace && ${EXTRACT} (cwd=-, timeout=-)`,
      'run cp -a /workspace /run-a (cwd=-, timeout=-)',
      'run cp -a /workspace /run-b (cwd=-, timeout=-)',
      'run git apply --whitespace=nowarn /tmp/diffprove/test-only.patch (cwd=/run-a, timeout=30000)',
      'run git apply --whitespace=nowarn /tmp/diffprove/full.patch (cwd=/run-b, timeout=30000)',
      'network denyAll=true',
      'run pytest "tests/test_a.py" (cwd=/run-a, timeout=120000)',
      'run pytest "tests/test_a.py" (cwd=/run-b, timeout=120000)',
      'close',
    ]);
    expect(
      runCalls(calls).filter((call) => call.command.includes('node_modules')),
    ).toHaveLength(0);
    expect(runCalls(calls).map((call) => call.command)).not.toContain(
      'pip install -e . -r requirements.txt',
    );
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
    expect(commands).not.toContain('cp -a /workspace /run-a');
    expect(commands).not.toContain('cp -a /workspace /run-b');
    expect(commands).not.toContain(request.testCommand);
    expect(calls.some((call) => call.kind === 'snapshot')).toBe(false);
    expect(set).not.toHaveBeenCalled();
    expect(calls.filter((call) => call.kind === 'close')).toHaveLength(1);
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
    const tests = runCalls(calls).filter((call) => call.command === request.testCommand);
    expect(tests.map((call) => call.opts?.cwd)).toEqual(['/run-b']);
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
    const tests = runCalls(calls).filter((call) => call.command === request.testCommand);
    expect(tests.map((call) => call.opts?.cwd)).toEqual(['/run-a']);
  });

  it('runs the head install inside /run-b before the egress lockdown', async () => {
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
      { cwd: '/run-b', timeoutMs: 240_000 },
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
    expect(tests.map((call) => call.opts?.cwd)).toEqual(['/run-a']);
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
    expect(runCalls(calls).map((call) => call.command)).not.toContain(request.testCommand);
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
      onRun: (command) => (command === 'pytest "tests/test_a.py"' ? timedOutRaw : ok()),
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
});
