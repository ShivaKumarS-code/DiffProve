import { describe, expect, it, vi } from 'vitest';

import { caseReportOptions } from './case-evidence.js';
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
const BASE = Uint8Array.from([31, 139, 8, 0, 1]);
const HEAD = Uint8Array.from([31, 139, 8, 0, 2]);

const ok: SandboxRawResult = { exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 };
const failed = (stderr: string): SandboxRawResult => ({ ...ok, exitCode: 1, stderr });
const timeout: SandboxRawResult = { ...ok, exitCode: null, stderr: 'timed out', timedOut: true };

const request: DifferentialRunRequest = {
  repoFullName: 'octocat/hello-world',
  baseSha: 'pinned-merge-base',
  headSha: 'exact-pr-head',
  tarball: BASE,
  headTarball: HEAD,
  testOnlyDiff: 'test-only-patch',
  testCommand: "npx jest 'tests/a.test.js'",
  installCommand: 'npm ci',
  headInstallCommand: 'npm ci',
  runnerKind: 'jest',
  lockfileKey: 'base-lock',
  headLockfileKey: 'base-lock',
};

type CreateOpts = Parameters<SandboxFactory['create']>[0];
type RunOpts = Parameters<SandboxHandle['run']>[1];
type Event = (
  | { kind: 'create'; opts: CreateOpts }
  | { kind: 'run'; command: string; opts: RunOpts }
  | { kind: 'write'; path: string; bytes: string | Uint8Array }
  | { kind: 'deny' | 'snapshot' | 'close' }
) & { vm: number };

function harness(opts: {
  onCreate?: (vm: number, options: CreateOpts) => void;
  onRun?: (vm: number, command: string) => SandboxRawResult | undefined;
  onWrite?: (vm: number, path: string) => void;
  onDeny?: (vm: number) => void;
  onClose?: () => void;
  snapshots?: Map<string, string>;
  snapshotAvailable?: boolean;
  withCache?: boolean;
} = {}) {
  const events: Event[] = [];
  const snapshots = opts.snapshots ?? new Map<string, string>();
  let nextVm = 0;
  const factory: SandboxFactory = {
    async create(options) {
      const vm = nextVm++;
      events.push({ vm, kind: 'create', opts: options });
      opts.onCreate?.(vm, options);
      let marker = snapshots.get(options.templateId ?? '');
      return {
        async run(command, commandOpts) {
          events.push({ vm, kind: 'run', command, opts: commandOpts });
          return opts.onRun?.(vm, command) ?? (
            command.includes('/base-snapshot') ? { ...ok, stdout: marker ?? '' } : ok
          );
        },
        async writeFile(path, bytes) {
          events.push({ vm, kind: 'write', path, bytes });
          opts.onWrite?.(vm, path);
          if (path.endsWith('/base-snapshot') && typeof bytes === 'string') marker = bytes;
        },
        async denyNetworkEgress() {
          events.push({ vm, kind: 'deny' });
          opts.onDeny?.(vm);
        },
        async createSnapshot() {
          events.push({ vm, kind: 'snapshot' });
          if (opts.snapshotAvailable === false) return null;
          const ref = `snap-${vm}`;
          if (marker) snapshots.set(ref, marker);
          return ref;
        },
        async close() {
          events.push({ vm, kind: 'close' });
          opts.onClose?.();
        },
      };
    },
  };
  const refs = new Map<string, string>();
  const cache = {
    get: vi.fn<EnvSnapshotCache['get']>(async (_, key) => refs.get(key) ?? null),
    set: vi.fn<EnvSnapshotCache['set']>(async (_, key, ref) => { refs.set(key, ref); }),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const run = createE2bDifferentialRunner({
    sandboxFactory: factory,
    defaultTemplateId: 'default-template',
    apiKey: 'control-plane-key',
    snapshotCache: opts.withCache ? cache : undefined,
    logger,
  });
  const forVm = (vm: number) => events.filter((event) => event.vm === vm);
  const commands = (vm: number) => forVm(vm).filter((event) => event.kind === 'run');
  const creates = () => events.filter((event) => event.kind === 'create').map((event) => event.opts);
  const writes = (vm: number) => forVm(vm).filter((event) => event.kind === 'write');
  const closed = () => events.filter((event) => event.kind === 'close').map((event) => event.vm).sort();
  return { run, cache, logger, events, forVm, commands, creates, writes, closed };
}

describe('E2B differential runner', () => {
  it('uses separate VMs with exact archive bytes and a clean, identical workspace path', async () => {
    const fake = harness({ withCache: true });
    await expect(fake.run(request)).resolves.toEqual({ runA: ok, runB: ok });

    expect(fake.creates()).toEqual([
      {
        templateId: 'default-template',
        apiKey: 'control-plane-key',
        timeoutMs: 720_000,
        network: { mode: 'registries', allowOut: ['registry.npmjs.org', 'registry.yarnpkg.com'] },
      },
      {
        templateId: 'snap-0',
        apiKey: 'control-plane-key',
        timeoutMs: 720_000,
        network: { mode: 'offline' },
      },
    ]);
    const [base, marker, patch] = fake.writes(0);
    expect(base).toEqual({ vm: 0, kind: 'write', path: `${STAGING}/base.tar.gz`, bytes: BASE });
    expect(marker).toMatchObject({ path: expect.stringMatching(/\/base-snapshot$/) });
    expect(patch).toEqual({
      vm: 0, kind: 'write', path: `${STAGING}/test-only.patch`, bytes: request.testOnlyDiff,
    });
    expect(fake.writes(1)).toEqual([
      { vm: 1, kind: 'write', path: `${STAGING}/head.tar.gz`, bytes: HEAD },
    ]);

    const a = fake.forVm(0);
    expect(a.map((event) => event.kind)).toEqual([
      'create', 'write', 'run', 'run', 'deny', 'write', 'snapshot', 'write', 'run', 'run', 'close',
    ]);
    expect(fake.commands(0).map(({ command }) => command)).toEqual([
      expect.stringContaining(`tar -xzf ${STAGING}/base.tar.gz -C ${WORKSPACE}`),
      expect.stringMatching(/npm_config_cache=\/var\/tmp\/diffprove-packages\/npm .*&& npm ci$/),
      `git apply --whitespace=nowarn ${STAGING}/test-only.patch`,
      request.testCommand,
    ]);
    expect(fake.commands(0)[1]?.command).not.toContain('npm_config_offline');

    const b = fake.forVm(1);
    expect(b.map((event) => event.kind)).toEqual([
      'create', 'deny', 'run', 'write', 'run', 'run', 'run', 'close',
    ]);
    expect(fake.commands(1).map(({ command }) => command)).toEqual([
      expect.stringMatching(/^head -c \d+ .*\/base-snapshot$/),
      expect.stringContaining(`rm -rf -- ${WORKSPACE} && mkdir -- ${WORKSPACE} && tar -xzf ${STAGING}/head.tar.gz -C ${WORKSPACE}`),
      expect.stringMatching(/npm_config_cache=\/var\/tmp\/diffprove-packages\/npm .*npm_config_offline=true .*&& npm ci$/),
      request.testCommand,
    ]);
    for (const vm of [0, 1]) {
      expect(fake.commands(vm).at(-1)?.opts).toEqual({ cwd: WORKSPACE, timeoutMs: 120_000 });
    }
    expect(fake.closed()).toEqual([0, 1]);
  });

  it('does not restore cached trees even with an unchanged lock; cache identity is merge base + lock', async () => {
    const fake = harness({ withCache: true });
    await fake.run(request);
    await fake.run({ ...request, headSha: 'another-head', headLockfileKey: 'new-head-lock' });
    await fake.run({ ...request, baseSha: 'another-base' });
    await fake.run({ ...request, lockfileKey: 'another-base-lock' });

    expect(fake.creates().map(({ templateId }) => templateId)).toEqual([
      'default-template', 'snap-0', 'snap-0', 'snap-0',
      'default-template', 'snap-4', 'default-template', 'snap-6',
    ]);
    const keys = fake.cache.get.mock.calls.map(([repo, key]) => {
      expect(repo).toBe(request.repoFullName);
      expect(key).toMatch(/^locked-base-packages-v3:[a-f0-9]{64}$/);
      return key;
    });
    expect(keys[0]).toBe(keys[1]);
    expect(new Set(keys).size).toBe(3);
    expect(fake.cache.set.mock.calls.map(([, key]) => key)).toEqual([keys[0], keys[2], keys[3]]);
    expect(fake.commands(2).map(({ command }) => command)).toContainEqual(
      expect.stringContaining(`rm -rf -- ${WORKSPACE} && mkdir -- ${WORKSPACE} && tar -xzf ${STAGING}/base.tar.gz`),
    );
    expect(fake.commands(2).map(({ command }) => command)).toContainEqual(
      expect.stringContaining('npm_config_offline=true'),
    );
    expect(fake.events.filter((event) => event.kind === 'snapshot').map(({ vm }) => vm)).toEqual([0, 4, 6]);
  });

  it.each(['unbootable snapshot', 'mismatched marker', 'unusable package cache'])(
    'closes and cold-falls back on an %s',
    async (reason) => {
      const snapshots = new Map<string, string>();
      const fake = harness({
        withCache: true,
        snapshots,
        onCreate: (vm) => { if (vm === 0 && reason === 'unbootable snapshot') throw new Error(reason); },
        onRun: (vm, command) => {
          if (vm === 0 && reason === 'unusable package cache' && command.includes('&& npm ci')) {
            return failed('ENOTCACHED');
          }
        },
      });
      fake.cache.get.mockImplementationOnce(async (_, key) => {
        // The marker matches but the package payload cannot provision the base.
        snapshots.set('bad-snap', reason === 'unusable package cache' ? key : 'other-base');
        return 'bad-snap';
      });
      await expect(fake.run(request)).resolves.toEqual({ runA: ok, runB: ok });

      expect(fake.creates().map(({ templateId, network }) => [templateId, network.mode])).toEqual([
        ['bad-snap', 'offline'], ['default-template', 'registries'], ['snap-1', 'offline'],
      ]);
      expect(fake.closed()).toEqual(reason === 'unbootable snapshot' ? [1, 2] : [0, 1, 2]);
      expect(fake.writes(0).some(({ path }) => path.endsWith('.patch'))).toBe(false);
      expect(fake.cache.set).toHaveBeenCalledOnce();
    },
  );

  it('cold-falls back for a head seed that fails to boot without ever opening head egress', async () => {
    const fake = harness({ onCreate: (vm) => { if (vm === 1) throw new Error('snapshot gone'); } });
    await expect(fake.run(request)).resolves.toEqual({ runA: ok, runB: ok });
    expect(fake.creates().map(({ templateId, network }) => [templateId, network.mode])).toEqual([
      ['default-template', 'registries'], ['snap-0', 'offline'], ['default-template', 'offline'],
    ]);
    expect(fake.writes(1)).toEqual([]);
    expect(fake.closed()).toEqual([0, 2]);
  });

  it('uses an in-job seed even if Redis reads and writes fail', async () => {
    const fake = harness({ withCache: true });
    fake.cache.get.mockRejectedValueOnce(new Error('Redis lookup rejected'));
    fake.cache.set.mockRejectedValueOnce(new Error('Redis write rejected'));
    await expect(fake.run(request)).resolves.toEqual({ runA: ok, runB: ok });
    expect(fake.creates()[1]?.templateId).toBe('snap-0');
    expect(fake.logger.warn).toHaveBeenCalledTimes(2);
  });

  it('refuses to upload a patch, snapshot or test when base lockdown fails, while still running head', async () => {
    const fake = harness({
      withCache: true,
      onDeny: (vm) => { if (vm === 0) throw new Error('denied by platform'); },
    });
    await expect(fake.run(request)).resolves.toEqual({
      runA: { ...ok, exitCode: null, stderr: 'network egress lockdown failed: denied by platform', durationMs: 0 },
      runB: ok,
    });
    expect(fake.forVm(0).map(({ kind }) => kind)).toEqual(['create', 'write', 'run', 'run', 'deny', 'close']);
    expect(fake.cache.set).not.toHaveBeenCalled();
    expect(fake.creates()[1]?.network).toEqual({ mode: 'offline' });
    expect(fake.closed()).toEqual([0, 1]);
  });

  it('refuses to upload or run any head content if head lockdown cannot be reinforced', async () => {
    const fake = harness({
      snapshotAvailable: false,
      onDeny: (vm) => { if (vm === 1) throw new Error('denied by platform'); },
    });
    const result = await fake.run(request);
    expect(result.runA).toEqual(ok);
    expect(result.runB.stderr).toContain('network egress lockdown failed');
    expect(fake.creates()[1]?.network).toEqual({ mode: 'offline' });
    expect(fake.forVm(1).map(({ kind }) => kind)).toEqual(['create', 'deny', 'close']);
  });

  it.each([
    ['base workspace extraction', 'tar -xzf', failed('bad archive')],
    ['base dependency installation', '&& npm ci', timeout],
    ['test-only patch application', 'git apply', failed('patch does not apply')],
  ] as const)('preserves independently retrievable head evidence after %s fails', async (label, command, result) => {
    const fake = harness({
      onRun: (vm, text) => vm === 0 && text.includes(command) ? result : undefined,
    });
    const raw = await fake.run({ ...request, headInstallCommand: null });
    expect(raw).toEqual({
      runA: { ...result, exitCode: null, stderr: `${label} failed:\n${result.stderr}` },
      runB: ok,
    });
    expect(fake.commands(0).some(({ command }) => command === request.testCommand)).toBe(false);
    expect(fake.commands(1).at(-1)?.command).toBe(request.testCommand);
    expect(fake.closed()).toEqual([0, 1]);
  });

  it('returns an environment failure for uncached head dependencies and never retries online', async () => {
    const fake = harness({
      snapshotAvailable: false,
      onRun: (vm, command) => vm === 1 && command.includes('npm install') ? failed('ENOTCACHED') : undefined,
    });
    await expect(fake.run({ ...request, headInstallCommand: 'npm install', headLockfileKey: 'changed' }))
      .resolves.toEqual({
        runA: ok,
        runB: { ...ok, exitCode: null, stderr: 'head dependency installation failed:\nENOTCACHED' },
      });
    expect(fake.creates().map(({ network }) => network.mode)).toEqual(['registries', 'offline']);
    expect(fake.forVm(1).map(({ kind }) => kind)).toEqual(['create', 'deny', 'write', 'run', 'run', 'close']);
    expect(fake.commands(1).at(-1)?.command).toContain('npm_config_offline=true');
  });

  it('warms standard pip wheels before base lockdown but creates a new head venv offline', async () => {
    const fake = harness();
    const testCommand = "pytest 'tests/test_a.py'";
    await fake.run({
      ...request,
      runnerKind: 'pytest',
      testCommand,
      installCommand: "pip install -r 'requirements.txt'",
      headInstallCommand: "pip install -r 'requirements.txt'",
    });
    expect(fake.creates()[0]?.network).toEqual({
      mode: 'registries', allowOut: ['pypi.org', 'files.pythonhosted.org'],
    });
    const base = fake.forVm(0);
    const wheel = base.findIndex((event) => event.kind === 'run' && event.command.includes('pip wheel'));
    expect(wheel).toBeGreaterThan(0);
    expect(wheel).toBeLessThan(base.findIndex((event) => event.kind === 'deny'));
    const headInstall = fake.commands(1).find(({ command }) => command.includes('pip install'));
    expect(headInstall?.command).toContain('PIP_NO_INDEX=1 PIP_FIND_LINKS=/var/tmp/diffprove-packages/wheels');
    expect(headInstall?.command).toContain('python3 -m venv .venv');
    for (const vm of [0, 1]) {
      expect(fake.commands(vm).at(-1)?.command).toBe(`export PATH="$PWD/.venv/bin:$PATH"; ${testCommand}`);
    }
  });

  describe.each([
    {
      tool: 'uv',
      command: '(command -v uv >/dev/null 2>&1 || pip install -q uv) && uv sync',
    },
    {
      tool: 'poetry',
      command: '(command -v poetry >/dev/null 2>&1 || pip install -q poetry) && POETRY_VIRTUALENVS_IN_PROJECT=true poetry install',
    },
  ])('$tool installer', ({ tool, command }) => {
    const toolVenv = '/var/tmp/diffprove-packages/python-tools';
    const installSuffix = ` && (${command})`;
    const pythonRequest: DifferentialRunRequest = {
      ...request,
      runnerKind: 'pytest',
      installCommand: command,
      headInstallCommand: command,
      testCommand: "pytest 'tests/test_a.py'",
    };

    it('retains bootstrap tooling for the seeded head and the next cached base, but not the project venv', async () => {
      const fake = harness({ withCache: true });
      await expect(fake.run(pythonRequest)).resolves.toEqual({ runA: ok, runB: ok });
      await expect(fake.run(pythonRequest)).resolves.toEqual({ runA: ok, runB: ok });
      expect(fake.creates().map(({ templateId, network }) => [templateId, network.mode])).toEqual([
        ['default-template', 'registries'], ['snap-0', 'offline'], ['snap-0', 'offline'], ['snap-0', 'offline'],
      ]);

      for (const vm of [0, 1, 2, 3]) {
        const events = fake.forVm(vm);
        const install = fake.commands(vm).find(({ command: cmd }) => cmd.endsWith(installSuffix));
        expect(install?.opts).toEqual({ cwd: WORKSPACE, timeoutMs: 240_000 });
        expect(install?.command).toContain(
          `([ -x ${toolVenv}/bin/python ] || python3 -m venv ${toolVenv}) && export PATH="${toolVenv}/bin:$PATH"`,
        );
        expect(install?.command).not.toContain('VIRTUAL_ENV=');
        const installIdx = events.findIndex((event) => event === install);
        const denyIdx = events.findIndex(({ kind }) => kind === 'deny');
        if (vm === 0) {
          expect(install?.command).not.toContain('PIP_NO_INDEX');
          expect(installIdx).toBeLessThan(denyIdx);
          expect(denyIdx).toBeLessThan(events.findIndex(({ kind }) => kind === 'snapshot'));
        } else {
          const tree = vm === 2 ? 'base' : 'head';
          const extraction = fake.commands(vm).find(({ command }) => command.includes('tar -xzf'));
          expect(extraction?.command).toContain(
            `rm -rf -- ${WORKSPACE} && mkdir -- ${WORKSPACE} && tar -xzf ${STAGING}/${tree}.tar.gz`,
          );
          expect(install?.command).toContain('PIP_NO_INDEX=1 PIP_FIND_LINKS=/var/tmp/diffprove-packages/wheels UV_OFFLINE=1');
          expect(denyIdx).toBeLessThan(events.findIndex((event) => event === extraction));
          expect(events.findIndex((event) => event === extraction)).toBeLessThan(installIdx);
        }
        expect(fake.commands(vm).at(-1)?.command).toBe(
          `export PATH="$PWD/.venv/bin:$PATH"; ${pythonRequest.testCommand}`,
        );
      }
    });

    it('boots a fresh offline head if the seed is rejected, even if the tool cannot be bootstrapped', async () => {
      const pipError = `pip: no local distribution for ${tool}`;
      const fake = harness({
        onCreate: (vm) => { if (vm === 1) throw new Error('snapshot failed to boot'); },
        onRun: (vm, command) => vm === 2 && command.endsWith(installSuffix) ? failed(pipError) : undefined,
      });
      await expect(fake.run(pythonRequest)).resolves.toEqual({
        runA: ok,
        runB: { ...ok, exitCode: null, stderr: `head dependency installation failed:\n${pipError}` },
      });
      expect(fake.creates().map(({ templateId, network }) => [templateId, network.mode])).toEqual([
        ['default-template', 'registries'], ['snap-0', 'offline'], ['default-template', 'offline'],
      ]);
      expect(fake.forVm(2).map(({ kind }) => kind)).toEqual(['create', 'deny', 'write', 'run', 'run', 'close']);
      const install = fake.commands(2).at(-1)?.command;
      expect(install).toContain('PIP_NO_INDEX=1 PIP_FIND_LINKS=/var/tmp/diffprove-packages/wheels UV_OFFLINE=1');
      expect(install).toContain(`pip install -q ${tool}`);
    });
  });

  it('does not ask for registry access or a snapshot when no install is needed', async () => {
    const fake = harness({ withCache: true });
    await fake.run({ ...request, installCommand: null, headInstallCommand: null });
    expect(fake.creates().map(({ network }) => network.mode)).toEqual(['offline', 'offline']);
    expect(fake.cache.get).not.toHaveBeenCalled();
    expect(fake.events.some(({ kind }) => kind === 'snapshot')).toBe(false);
  });

  it('collects native evidence in the same VM after each standard command, including a failing test', async () => {
    const report = caseReportOptions('jest');
    const testCommand = `${request.testCommand} ${report.args}`;
    const fake = harness({
      onRun: (vm, command) => {
        if (command === testCommand && vm === 0) return failed('assertion failed');
        if (command === report.readCommand) return {
          ...ok,
          stdout: JSON.stringify({
            testResults: [{
              name: `${WORKSPACE}/tests/a.test.js`,
              assertionResults: [{
                ancestorTitles: ['suite'], fullName: 'suite target', title: 'target',
                status: vm === 0 ? 'failed' : 'passed',
              }],
            }],
          }),
        };
      },
    });
    const result = await fake.run({
      ...request, installCommand: null, headInstallCommand: null, collectCaseResults: true,
    });
    expect(result.runA).toMatchObject({
      ...failed('assertion failed'),
      caseResults: [{ status: 'fail', id: expect.stringContaining('tests/a.test.js') }],
    });
    expect(result.runB.caseResults).toEqual([{ id: result.runA.caseResults?.[0]?.id, status: 'pass' }]);
    for (const vm of [0, 1]) {
      expect(fake.commands(vm).slice(-2)).toEqual([
        { vm, kind: 'run', command: testCommand, opts: { cwd: WORKSPACE, timeoutMs: 120_000 } },
        { vm, kind: 'run', command: report.readCommand, opts: { cwd: WORKSPACE, timeoutMs: 5_000 } },
      ]);
    }
  });

  it.each([
    ['missing report', failed('not found')],
    ['malformed report', { ...ok, stdout: 'not JSON' }],
    ['timed-out report reader', timeout],
  ] as const)('preserves raw results for a %s', async (_, readResult) => {
    const { readCommand } = caseReportOptions('jest');
    const fake = harness({ onRun: (_, command) => command === readCommand ? readResult : undefined });
    await expect(fake.run({ ...request, collectCaseResults: true })).resolves.toEqual({ runA: ok, runB: ok });
  });

  it('does not append flags or read a report for a custom command', async () => {
    const { args, readCommand } = caseReportOptions('jest');
    const fake = harness();
    await expect(fake.run({
      ...request, testCommand: 'custom-script', collectCaseResults: false,
    })).resolves.toEqual({ runA: ok, runB: ok });
    for (const vm of [0, 1]) {
      expect(fake.commands(vm).at(-1)?.command).toBe('custom-script');
      expect(fake.commands(vm).some(({ command }) => command.includes(args) || command === readCommand)).toBe(false);
    }
  });

  it('does not read partial evidence after a test timeout', async () => {
    const { args, readCommand } = caseReportOptions('jest');
    const timedOutTest = harness({
      onRun: (_, command) => command === `${request.testCommand} ${args}` ? timeout : undefined,
    });
    await expect(timedOutTest.run({ ...request, collectCaseResults: true }))
      .resolves.toEqual({ runA: timeout, runB: timeout });
    expect(timedOutTest.events.some((event) => event.kind === 'run' && event.command === readCommand)).toBe(false);
  });

  it('closes both handles even when a head upload throws a retriable infrastructure error', async () => {
    const error = new Error('upload unreachable');
    const fake = harness({
      onWrite: (vm) => { if (vm === 1) throw error; },
      onClose: () => { throw new Error('cleanup transport error'); },
    });
    await expect(fake.run({ ...request, headInstallCommand: null })).rejects.toBe(error);
    expect(fake.closed()).toEqual([0, 1]);
    expect(fake.logger.warn).toHaveBeenCalledTimes(2);
  });
});
