import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { RepoConfig, RepoConfigStore, VerificationRunStore } from '../db/types.js';
import type { Logger, VerificationJob } from '../domain.js';
import { DEFAULT_TEST_GLOBS, NO_TEST_CHANGES_TITLE } from '../diff/types.js';
import type { CheckRunReporter, PrDiffClient } from '../diff/types.js';
import type {
  DifferentialRunRequest,
  DifferentialRunner,
  RepoContentClient,
  RepoTarballClient,
  SandboxRawResult,
  TestCaseResult,
  VerdictReporter,
} from '../runner/types.js';
import { createDifferentialHandler } from './differential-handler.js';

/**
 * Fixtures are byte-exact unified-diff shapes (same style as the parser,
 * splitter and Phase 2 handler tests), so the REAL `splitDiff` classifies them
 * exactly the way it classifies a GitHub `.diff` payload. Only the ports are
 * faked — no network, no Redis, no E2B.
 */
const IMPL_ONLY_DIFF = [
  'diff --git a/src/app.py b/src/app.py',
  'index 1111111..2222222 100644',
  '--- a/src/app.py',
  '+++ b/src/app.py',
  '@@ -1,3 +1,3 @@',
  ' def main():',
  '-    return 1',
  '+    return 2',
  '',
].join('\n');

/** The Test-Only Patch of {@link MIXED_DIFF}: exactly one runnable vitest file. */
const TEST_ONLY_SECTION = [
  'diff --git a/tests/app.test.ts b/tests/app.test.ts',
  'new file mode 100644',
  'index 0000000..4444444',
  '--- /dev/null',
  '+++ b/tests/app.test.ts',
  '@@ -0,0 +1,6 @@',
  "+import { expect, test } from 'vitest';",
  "+import { add } from '../src/app';",
  '+',
  '+test("adds two numbers", () => {',
  '+  expect(add(1, 2)).toBe(3);',
  '+});',
  '',
].join('\n');

const MIXED_DIFF = IMPL_ONLY_DIFF + TEST_ONLY_SECTION;

/**
 * A Python test file that ONLY the repo-configured `*_snap.py` glob matches:
 * none of the default globs (`test_*.py`, `*_test.py`, `*.test.ts`, `*.spec.ts`)
 * classify it as a test.
 */
const SNAPSHOT_TEST_DIFF = [
  'diff --git a/tests/checkout_snap.py b/tests/checkout_snap.py',
  'new file mode 100644',
  'index 0000000..5555555',
  '--- /dev/null',
  '+++ b/tests/checkout_snap.py',
  '@@ -0,0 +1,3 @@',
  '+def test_checkout():',
  '+    assert checkout() == 3',
  '+',
].join('\n');

/** A PR that only deletes a test file (has test changes, but zero runnable tests). */
const DELETED_TEST_DIFF = [
  'diff --git a/tests/test_gone.py b/tests/test_gone.py',
  'deleted file mode 100644',
  'index 3333333..0000000',
  '--- a/tests/test_gone.py',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-def test_old():',
  '-    assert True',
  '',
].join('\n');

/** A `repositories` row with no overrides (the defaults apply). */
const DEFAULT_REPO_CONFIG: RepoConfig = {
  testFileGlobs: null,
  testCommand: null,
  enabled: true,
};

const JOB: VerificationJob = {
  repoFullName: 'octocat/hello-world',
  prNumber: 7,
  installationId: 42,
  baseSha: 'base123',
  headSha: 'head456',
};

const CHECK_RUN_ID = 321;
const MERGE_BASE_SHA = 'abcdef0123456789abcdef0123456789abcdef01';

function pinnedDiff(diff: string) {
  return { diff, mergeBaseSha: MERGE_BASE_SHA };
}

/** A realistic vitest manifest: dependency detection wins over scripts.test. */
const PACKAGE_JSON = JSON.stringify(
  {
    name: 'example-app',
    version: '1.0.0',
    private: true,
    scripts: { test: 'vitest run' },
    devDependencies: { typescript: '^6.0.3', vitest: '^5.1.1' },
  },
  null,
  2,
);

const LOCKFILE_TEXT = JSON.stringify(
  {
    name: 'example-app',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: 'example-app', version: '1.0.0' } },
  },
  null,
  2,
);

/** The lockfile hash the handler must compute, derived independently here. */
const EXPECTED_LOCKFILE_KEY = createHash('sha256')
  .update(LOCKFILE_TEXT, 'utf8')
  .digest('hex');

/** Fake gzip header: the handler must pass the bytes through untouched. */
const TARBALL = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]);
const HEAD_TARBALL = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x00, 0x00, 0x00]);

/** Base tree: no new test file yet (the PR adds it). */
const BASE_FILES = ['package.json', 'package-lock.json', 'src/app.py'];
const HEAD_FILES = ['package.json', 'package-lock.json', 'src/app.py', 'tests/app.test.ts'];

/** Assertion failure on base: exit 1 with no import/syntax signature. */
const RUN_A_FAIL: SandboxRawResult = {
  exitCode: 1,
  stdout: '',
  stderr: 'FAIL tests/app.test.ts > adds two numbers\nAssertionError: expected 2 to be 3',
  timedOut: false,
  durationMs: 1200,
};

/** Passing suite on head. */
const RUN_B_PASS: SandboxRawResult = {
  exitCode: 0,
  stdout: 'Test Files  1 passed (1)\nTests  1 passed (1)',
  stderr: '',
  timedOut: false,
  durationMs: 800,
};

const REPRODUCING_CASE = 'tests/app.test.ts > reproduces regression';
const NON_REPRODUCING_CASE = 'tests/app.test.ts > already passes';
const BASE_CASES: TestCaseResult[] = [
  { id: REPRODUCING_CASE, status: 'fail' },
  { id: NON_REPRODUCING_CASE, status: 'pass' },
];
const HEAD_CASES: TestCaseResult[] = [
  { id: REPRODUCING_CASE, status: 'pass' },
  { id: NON_REPRODUCING_CASE, status: 'pass' },
];

/** Newly introduced symbol: base cannot resolve the import (guardrail #3). */
const RUN_A_IMPORT_ERROR: SandboxRawResult = {
  exitCode: 1,
  stdout: '',
  stderr: "Error: Cannot find module './new-helper'\n  imported from tests/app.test.ts",
  timedOut: false,
  durationMs: 1500,
};

/** Sandbox timeout: an environment failure, never a verdict on the PR. */
const RUN_A_TIMEOUT: SandboxRawResult = {
  exitCode: null,
  stdout: '',
  stderr: 'command timed out after 120000ms',
  timedOut: true,
  durationMs: 120000,
};

interface HarnessOptions {
  /** Pass `null` to simulate an environment without E2B configured. */
  runner?: DifferentialRunner | null;
  /** Config the fake store resolves; null (the default) = no `repositories` row. */
  repoConfig?: RepoConfig | null;
  /** Pass `null` to simulate an environment without PostgreSQL (no config store). */
  repoConfigStore?: RepoConfigStore | null;
  /** Pass `null` to simulate an environment without PostgreSQL (no run persistence). */
  runs?: VerificationRunStore | null;
}

/** Builds the handler wired to fakes for every injected port. */
function buildHarness(options: HarnessOptions = {}) {
  const prDiff = vi.fn<PrDiffClient>();
  const reportNoTestChanges = vi.fn<CheckRunReporter['reportNoTestChanges']>();
  const fetchTextFile = vi.fn<RepoContentClient['fetchTextFile']>();
  const listPaths = vi.fn<RepoContentClient['listPaths']>();
  const repoTarball = vi.fn<RepoTarballClient>();
  const runnerMock = vi.fn<DifferentialRunner>();
  const reportVerdict = vi.fn<VerdictReporter['reportVerdict']>();
  const lookupConfig = vi.fn<RepoConfigStore['lookupConfig']>();
  const insertRun = vi.fn<VerificationRunStore['insertRun']>();
  const info = vi.fn<Logger['info']>();
  const warn = vi.fn<Logger['warn']>();
  const error = vi.fn<Logger['error']>();

  lookupConfig.mockResolvedValue(options.repoConfig ?? null);

  const runsStore: VerificationRunStore = {
    insertRun,
    listRuns: vi.fn<VerificationRunStore['listRuns']>(),
  };

  const handler = createDifferentialHandler({
    prDiff,
    checkRuns: { reportNoTestChanges },
    repoContent: { fetchTextFile, listPaths },
    repoTarball,
    runner: options.runner === undefined ? runnerMock : options.runner,
    verdicts: { reportVerdict },
    repoConfig:
      options.repoConfigStore === undefined ? { lookupConfig } : options.repoConfigStore,
    runs: options.runs === undefined ? runsStore : options.runs,
    logger: { info, warn, error },
  });

  return {
    handler,
    prDiff,
    reportNoTestChanges,
    fetchTextFile,
    listPaths,
    repoTarball,
    runner: runnerMock,
    reportVerdict,
    lookupConfig,
    insertRun,
    info,
    warn,
    error,
  };
}

/** Wires a Vitest repo with identical lockfile contents at base and head. */
function givenVitestRepo(harness: ReturnType<typeof buildHarness>): void {
  harness.prDiff.mockResolvedValue(pinnedDiff(MIXED_DIFF));
  harness.fetchTextFile.mockImplementation(async ({ path }) => {
    if (path === 'package.json') {
      return PACKAGE_JSON;
    }
    if (path === 'pyproject.toml') {
      return null;
    }
    if (path === 'package-lock.json') {
      return LOCKFILE_TEXT;
    }
    return null;
  });
  harness.listPaths.mockImplementation(async ({ ref }) =>
    ref === JOB.headSha ? HEAD_FILES : BASE_FILES,
  );
  harness.repoTarball.mockImplementation(async ({ ref }) =>
    ref === JOB.headSha ? HEAD_TARBALL : TARBALL,
  );
}

/** Recorded messages of a fake logger method, in call order. */
function messagesOf(mock: { mock: { calls: readonly (readonly string[])[] } }): string[] {
  return mock.mock.calls.map((call) => call[0] ?? '');
}

/** The first message a fake logger method recorded. */
function firstMessage(mock: { mock: { calls: readonly (readonly string[])[] } }): string {
  return messagesOf(mock)[0] ?? '';
}

describe('createDifferentialHandler — no test changes', () => {
  it('reports one neutral check run with the Phase 2 title and summary', async () => {
    const harness = buildHarness();
    harness.prDiff.mockResolvedValue(pinnedDiff(IMPL_ONLY_DIFF));

    await expect(harness.handler({ ...JOB, checkRunId: CHECK_RUN_ID })).resolves.toBeUndefined();

    expect(harness.prDiff).toHaveBeenCalledTimes(1);
    expect(harness.prDiff).toHaveBeenCalledWith({
      repoFullName: 'octocat/hello-world',
      baseSha: 'base123',
      headSha: 'head456',
      installationId: 42,
    });

    // Phase 4: the repo config is consulted (no row → defaults apply).
    expect(harness.lookupConfig).toHaveBeenCalledTimes(1);
    expect(harness.lookupConfig).toHaveBeenCalledWith('octocat/hello-world');

    expect(harness.reportNoTestChanges).toHaveBeenCalledTimes(1);
    expect(harness.reportNoTestChanges).toHaveBeenCalledWith({
      repoFullName: 'octocat/hello-world',
      headSha: 'head456',
      installationId: 42,
      checkRunId: CHECK_RUN_ID,
      title: NO_TEST_CHANGES_TITLE,
      summary:
        `1 changed file(s), none matching the test file globs (${DEFAULT_TEST_GLOBS.join(', ')}). ` +
        'Differential verification skipped: no new or modified tests to verify.',
    });

    // The reused title must stay the exact wording the architecture documents.
    expect(NO_TEST_CHANGES_TITLE).toBe('No test changes detected to verify');

    // No sandbox work is started for a pure refactor.
    expect(harness.runner).not.toHaveBeenCalled();
    expect(harness.fetchTextFile).not.toHaveBeenCalled();
    expect(harness.listPaths).not.toHaveBeenCalled();
    expect(harness.repoTarball).not.toHaveBeenCalled();
    expect(harness.reportVerdict).not.toHaveBeenCalled();
    expect(harness.insertRun).not.toHaveBeenCalled();
    expect(harness.warn).not.toHaveBeenCalled();
    expect(harness.error).not.toHaveBeenCalled();
  });

  it('names every default test glob and logs the Phase 2 split summary', async () => {
    const harness = buildHarness();
    harness.prDiff.mockResolvedValue(pinnedDiff(IMPL_ONLY_DIFF));

    await harness.handler(JOB);

    const summary = harness.reportNoTestChanges.mock.calls[0]?.[0]?.summary ?? '';
    for (const glob of ['test_*.py', '*_test.py', '*.test.ts', '*.spec.ts']) {
      expect(summary).toContain(glob);
    }

    expect(messagesOf(harness.info)).toContain(
      'split: 1 file(s) changed, 0 test file(s), 0 runnable: (none)',
    );
  });

  it('short-circuits deleted-only test PRs as neutral without running the suite', async () => {
    const harness = buildHarness();
    harness.prDiff.mockResolvedValue(pinnedDiff(DELETED_TEST_DIFF));

    await expect(harness.handler(JOB)).resolves.toBeUndefined();

    expect(harness.reportNoTestChanges).toHaveBeenCalledTimes(1);
    const report = harness.reportNoTestChanges.mock.calls[0]?.[0];
    expect(report).toMatchObject({
      repoFullName: 'octocat/hello-world',
      headSha: 'head456',
      installationId: 42,
      title: NO_TEST_CHANGES_TITLE,
    });
    expect(report?.summary).toContain('tests/test_gone.py');
    expect(report?.summary).toContain('deleted or binary');
    expect(report?.summary).toContain('no runnable tests');
    expect(report).not.toHaveProperty('checkRunId');

    expect(harness.fetchTextFile).not.toHaveBeenCalled();
    expect(harness.listPaths).not.toHaveBeenCalled();
    expect(harness.repoTarball).not.toHaveBeenCalled();
    expect(harness.runner).not.toHaveBeenCalled();
    expect(harness.reportVerdict).not.toHaveBeenCalled();
    expect(harness.insertRun).not.toHaveBeenCalled();
  });
});

describe('createDifferentialHandler — repository disabled', () => {
  it('completes the exact check as neutral without fetching the diff', async () => {
    const harness = buildHarness({ repoConfig: { ...DEFAULT_REPO_CONFIG, enabled: false } });

    await expect(harness.handler({ ...JOB, checkRunId: CHECK_RUN_ID })).resolves.toBeUndefined();

    expect(harness.lookupConfig).toHaveBeenCalledTimes(1);
    expect(harness.lookupConfig).toHaveBeenCalledWith('octocat/hello-world');
    expect(harness.prDiff).not.toHaveBeenCalled();
    expect(harness.reportNoTestChanges).toHaveBeenCalledExactlyOnceWith({
      repoFullName: JOB.repoFullName,
      headSha: JOB.headSha,
      installationId: JOB.installationId,
      checkRunId: CHECK_RUN_ID,
      title: 'Differential verification is disabled',
      summary: expect.stringContaining('this repository has disabled it'),
    });
    expect(harness.fetchTextFile).not.toHaveBeenCalled();
    expect(harness.listPaths).not.toHaveBeenCalled();
    expect(harness.repoTarball).not.toHaveBeenCalled();
    expect(harness.runner).not.toHaveBeenCalled();
    expect(harness.reportVerdict).not.toHaveBeenCalled();
    expect(harness.insertRun).not.toHaveBeenCalled();

    expect(harness.warn).toHaveBeenCalledTimes(1);
    const warning = firstMessage(harness.warn);
    expect(warning).toContain('octocat/hello-world');
    expect(warning).toContain('disabled');
    expect(harness.error).not.toHaveBeenCalled();
  });

  it('rethrows a failed neutral completion so the worker can retry the same check', async () => {
    const harness = buildHarness({ repoConfig: { ...DEFAULT_REPO_CONFIG, enabled: false } });
    const job = { ...JOB, checkRunId: CHECK_RUN_ID };
    const failure = new Error('failed to complete check run: HTTP 500');
    harness.reportNoTestChanges.mockRejectedValueOnce(failure);

    await expect(harness.handler(job)).rejects.toBe(failure);
    expect(messagesOf(harness.info).some((message) => message.includes('reported neutral'))).toBe(false);
    await expect(harness.handler(job)).resolves.toBeUndefined();

    expect(harness.reportNoTestChanges).toHaveBeenCalledTimes(2);
    expect(harness.reportNoTestChanges.mock.calls[1]?.[0]).toEqual(
      harness.reportNoTestChanges.mock.calls[0]?.[0],
    );
    expect(harness.reportNoTestChanges.mock.calls[0]?.[0]?.checkRunId).toBe(CHECK_RUN_ID);
    expect(harness.reportVerdict).not.toHaveBeenCalled();
    expect(harness.insertRun).not.toHaveBeenCalled();
  });
});

describe('createDifferentialHandler — repo-configured test globs', () => {
  it('splits with the configured globs instead of the defaults', async () => {
    // E2B is off so the handler stops right after splitting: reaching the E2B
    // skip (rather than a no-test-changes skip) proves the diff had test changes.
    const harness = buildHarness({
      runner: null,
      repoConfig: { ...DEFAULT_REPO_CONFIG, testFileGlobs: ['*_snap.py'] },
    });
    harness.prDiff.mockResolvedValue(pinnedDiff(SNAPSHOT_TEST_DIFF));

    await harness.handler(JOB);

    expect(harness.reportNoTestChanges).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ title: 'Differential verification sandbox is unavailable' }),
    );
    expect(harness.warn).toHaveBeenCalledTimes(1);
    const warning = firstMessage(harness.warn);
    expect(warning).toContain('E2B_API_KEY');
    expect(warning).toContain('tests/checkout_snap.py');
    expect(harness.insertRun).not.toHaveBeenCalled();
  });

  it('lists the configured globs in the no-test-changes summary', async () => {
    const harness = buildHarness({
      repoConfig: { ...DEFAULT_REPO_CONFIG, testFileGlobs: ['*_snap.py'] },
    });
    harness.prDiff.mockResolvedValue(pinnedDiff(IMPL_ONLY_DIFF));

    await harness.handler(JOB);

    expect(harness.reportNoTestChanges).toHaveBeenCalledTimes(1);
    const summary = harness.reportNoTestChanges.mock.calls[0]?.[0]?.summary ?? '';
    expect(summary).toContain('(*_snap.py)');

    // The override replaces the defaults; it does not extend them.
    for (const glob of ['test_*.py', '*_test.py', '*.test.ts', '*.spec.ts']) {
      expect(summary).not.toContain(glob);
    }
  });
});

describe('createDifferentialHandler — E2B not configured', () => {
  it('completes the exact check as neutral and warns about E2B_API_KEY', async () => {
    const harness = buildHarness({ runner: null });
    harness.prDiff.mockResolvedValue(pinnedDiff(MIXED_DIFF));

    await expect(harness.handler({ ...JOB, checkRunId: CHECK_RUN_ID })).resolves.toBeUndefined();

    expect(harness.warn).toHaveBeenCalledTimes(1);
    const warning = firstMessage(harness.warn);
    expect(warning).toContain('E2B_API_KEY');
    expect(warning).toContain('skipping');
    expect(warning).toContain('octocat/hello-world#7');

    // No contents were fetched and no verdict or run history was recorded.
    expect(harness.reportNoTestChanges).toHaveBeenCalledExactlyOnceWith({
      repoFullName: JOB.repoFullName,
      headSha: JOB.headSha,
      installationId: JOB.installationId,
      checkRunId: CHECK_RUN_ID,
      title: 'Differential verification sandbox is unavailable',
      summary: expect.stringContaining('E2B is not configured'),
    });
    expect(harness.fetchTextFile).not.toHaveBeenCalled();
    expect(harness.listPaths).not.toHaveBeenCalled();
    expect(harness.repoTarball).not.toHaveBeenCalled();
    expect(harness.runner).not.toHaveBeenCalled();
    expect(harness.reportVerdict).not.toHaveBeenCalled();
    expect(harness.insertRun).not.toHaveBeenCalled();
    expect(harness.error).not.toHaveBeenCalled();
  });
});

describe('createDifferentialHandler — repo-configured test command', () => {
  it('runs exactly the configured command instead of the built one', async () => {
    const harness = buildHarness({
      repoConfig: { ...DEFAULT_REPO_CONFIG, testCommand: 'npm test -- --runInBand' },
    });
    givenVitestRepo(harness);
    harness.runner.mockResolvedValue({
      runA: { ...RUN_A_FAIL, caseResults: BASE_CASES },
      runB: { ...RUN_B_PASS, caseResults: HEAD_CASES },
    });
    harness.reportVerdict.mockResolvedValue(undefined);

    await harness.handler(JOB);

    const request: DifferentialRunRequest | undefined = harness.runner.mock.calls[0]?.[0];
    // The auto-detected command would be `npx vitest run 'tests/app.test.ts'`.
    expect(request?.testCommand).toBe('npm test -- --runInBand');
    expect(request?.collectCaseResults).toBe(false);
    // Everything else about the run request is unchanged.
    expect(request?.installCommand).toBe('npm ci');
    expect(request?.runnerKind).toBe('vitest');
    const report = harness.reportVerdict.mock.calls[0]?.[0];
    expect(report?.verdict).toBe('verified-fix');
    expect(report?.summary).not.toContain('### Test case evidence');
    expect(harness.insertRun.mock.calls[0]?.[0]).not.toHaveProperty('caseEvidence');
  });

  it('substitutes single-quoted runnable test paths for {files} and {file}', async () => {
    for (const template of ['npm test -- {files}', 'npx vitest run {file}']) {
      const harness = buildHarness({
        repoConfig: { ...DEFAULT_REPO_CONFIG, testCommand: template },
      });
      givenVitestRepo(harness);
      harness.runner.mockResolvedValue({ runA: RUN_A_FAIL, runB: RUN_B_PASS });
      harness.reportVerdict.mockResolvedValue(undefined);

      await harness.handler(JOB);

      const request: DifferentialRunRequest | undefined = harness.runner.mock.calls[0]?.[0];
      const expectedPrefix = template.replace(/\{files?\}$/, '');
      expect(request?.testCommand).toBe(`${expectedPrefix}'tests/app.test.ts'`);
    }
  });

  it('infers the runner instead of throwing when a custom testCommand is set and manifests lack a runner', async () => {
    const cases: Array<{
      testCommand: string;
      packageJson: string | null;
      pyprojectToml: string | null;
      expectedRunner: 'pytest' | 'vitest' | 'jest';
      expectedLanguage: 'python' | 'node';
      expectedCommand: string;
    }> = [
      {
        testCommand: 'python -m unittest {files}',
        packageJson: null,
        pyprojectToml: '[project]\nname = "demo"',
        expectedRunner: 'pytest',
        expectedLanguage: 'python',
        expectedCommand: "python -m unittest 'tests/app.test.ts'",
      },
      {
        testCommand: 'pytest -q {file}',
        packageJson: null,
        pyprojectToml: null,
        expectedRunner: 'pytest',
        expectedLanguage: 'python',
        expectedCommand: "pytest -q 'tests/app.test.ts'",
      },
      {
        testCommand: 'npx jest --runInBand {files}',
        packageJson: '{}',
        pyprojectToml: null,
        expectedRunner: 'jest',
        expectedLanguage: 'node',
        expectedCommand: "npx jest --runInBand 'tests/app.test.ts'",
      },
      {
        testCommand: 'npm run test:unit',
        packageJson: '{"name":"demo","scripts":{"test":"echo custom"}}',
        pyprojectToml: null,
        expectedRunner: 'vitest',
        expectedLanguage: 'node',
        expectedCommand: 'npm run test:unit',
      },
      {
        testCommand: 'make test',
        packageJson: null,
        pyprojectToml: '[project]\nname = "demo"',
        expectedRunner: 'pytest',
        expectedLanguage: 'python',
        expectedCommand: 'make test',
      },
    ];

    for (const c of cases) {
      const harness = buildHarness({
        repoConfig: { ...DEFAULT_REPO_CONFIG, testCommand: c.testCommand },
      });
      harness.prDiff.mockResolvedValue(pinnedDiff(MIXED_DIFF));
      harness.fetchTextFile.mockImplementation(async ({ path }) => {
        if (path === 'package.json') {
          return c.packageJson;
        }
        if (path === 'pyproject.toml') {
          return c.pyprojectToml;
        }
        return null;
      });
      harness.listPaths.mockResolvedValue([]);
      harness.repoTarball.mockResolvedValue(TARBALL);
      harness.runner.mockResolvedValue({ runA: RUN_A_FAIL, runB: RUN_B_PASS });
      harness.reportVerdict.mockResolvedValue(undefined);

      await expect(harness.handler(JOB)).resolves.toBeUndefined();

      const request: DifferentialRunRequest | undefined = harness.runner.mock.calls[0]?.[0];
      expect(request?.runnerKind).toBe(c.expectedRunner);
      expect(request?.testCommand).toBe(c.expectedCommand);
      expect(harness.insertRun).toHaveBeenCalledWith(
        expect.objectContaining({
          language: c.expectedLanguage,
          verdict: 'verified-fix',
        }),
      );
      expect(harness.error).not.toHaveBeenCalled();
    }
  });
});

describe('createDifferentialHandler — verified fix', () => {
  it('tests the merge base and exact PR head and reports verified-fix/success to the exact check', async () => {
    const harness = buildHarness();
    givenVitestRepo(harness);
    harness.runner.mockResolvedValue({ runA: RUN_A_FAIL, runB: RUN_B_PASS });
    harness.reportVerdict.mockResolvedValue(undefined);

    await expect(harness.handler({ ...JOB, checkRunId: CHECK_RUN_ID })).resolves.toBeUndefined();

    expect(JOB.baseSha).not.toBe(MERGE_BASE_SHA);
    expect(harness.prDiff).toHaveBeenCalledExactlyOnceWith({
      repoFullName: 'octocat/hello-world',
      baseSha: JOB.baseSha,
      headSha: JOB.headSha,
      installationId: 42,
    });

    // All inputs use the tested states, not the base branch tip. Only Run A's
    // manifests determine the runner; each side provides its own paths and lock.
    const baseRef = { repoFullName: JOB.repoFullName, ref: MERGE_BASE_SHA, installationId: 42 };
    const headRef = { ...baseRef, ref: JOB.headSha };
    expect(harness.fetchTextFile.mock.calls).toStrictEqual([
      [{ ...baseRef, path: 'package.json' }],
      [{ ...baseRef, path: 'pyproject.toml' }],
      [{ ...baseRef, path: 'package-lock.json' }],
      [{ ...headRef, path: 'package-lock.json' }],
    ]);
    expect(harness.listPaths.mock.calls).toStrictEqual([[baseRef], [headRef]]);
    expect(harness.repoTarball.mock.calls).toStrictEqual([[baseRef], [headRef]]);

    // Only the test patch and archive bytes (never tokens) enter the runner.
    expect(harness.runner).toHaveBeenCalledTimes(1);
    const request: DifferentialRunRequest | undefined = harness.runner.mock.calls[0]?.[0];
    expect(request).toStrictEqual({
      repoFullName: 'octocat/hello-world',
      baseSha: MERGE_BASE_SHA,
      headSha: 'head456',
      tarball: TARBALL,
      headTarball: HEAD_TARBALL,
      testOnlyDiff: TEST_ONLY_SECTION,
      testCommand: "npx vitest run 'tests/app.test.ts'",
      installCommand: 'npm ci',
      headInstallCommand: 'npm ci',
      runnerKind: 'vitest',
      lockfileKey: EXPECTED_LOCKFILE_KEY,
      headLockfileKey: EXPECTED_LOCKFILE_KEY,
      collectCaseResults: true,
    });

    // Verdict matrix row 1: FAIL + PASS → verified-fix / success.
    expect(harness.reportVerdict).toHaveBeenCalledTimes(1);
    const report = harness.reportVerdict.mock.calls[0]?.[0];
    expect(report).toMatchObject({
      repoFullName: 'octocat/hello-world',
      headSha: 'head456',
      installationId: 42,
      checkRunId: CHECK_RUN_ID,
      verdict: 'verified-fix',
      conclusion: 'success',
      title: 'Differential verification passed',
      durationMs: RUN_A_FAIL.durationMs + RUN_B_PASS.durationMs,
    });
    expect(report?.summary).toContain('0.8s');
    expect(report?.summary).toContain('2.0s');
    expect(report?.summary).toContain('Individual test case evidence is unavailable');
    expect(report?.summary).toContain(`Tested merge base (Run A): \`${MERGE_BASE_SHA}\``);
    expect(report?.summary).not.toContain(JOB.baseSha);

    // Phase 4, pipeline step 6: the run is persisted once, with the exact row.
    // Each fixture populates exactly one output stream, so the classified
    // excerpts are the fixtures' text (stdout first, then stderr).
    expect(harness.insertRun).toHaveBeenCalledTimes(1);
    expect(harness.insertRun).toHaveBeenCalledWith({
      repoFullName: 'octocat/hello-world',
      installationId: 42,
      language: 'node',
      prNumber: 7,
      baseSha: MERGE_BASE_SHA,
      headSha: 'head456',
      changedTestFiles: ['tests/app.test.ts'],
      runAStatus: 'fail',
      runBStatus: 'pass',
      verdict: 'verified-fix',
      durationMs: RUN_A_FAIL.durationMs + RUN_B_PASS.durationMs,
      runALog: RUN_A_FAIL.stderr,
      runBLog: RUN_B_PASS.stdout,
      caseEvidence: null,
    });

    // Persistence happens only after GitHub accepted the verdict.
    expect(harness.reportVerdict.mock.invocationCallOrder[0]).toBeLessThan(
      harness.insertRun.mock.invocationCallOrder[0] ?? 0,
    );

    const logged = messagesOf(harness.info);
    expect(logged.some((message) => message.includes('(differential pipeline)'))).toBe(true);
    expect(logged).toContain(
      'split: 2 file(s) changed, 1 test file(s), 1 runnable: tests/app.test.ts',
    );
    expect(logged).toContain('verdict: verified-fix (runA=fail, runB=pass, 2000ms)');
    expect(logged).toContain('reported verdict verified-fix for octocat/hello-world#7');
    expect(harness.error).not.toHaveBeenCalled();
  });
});

describe('createDifferentialHandler — comparable case evidence', () => {
  it('reports and persists mixed-test evidence when aggregate fail/pass hides a weak case', async () => {
    const harness = buildHarness();
    givenVitestRepo(harness);
    harness.runner.mockResolvedValue({
      runA: { ...RUN_A_FAIL, caseResults: BASE_CASES },
      runB: { ...RUN_B_PASS, caseResults: HEAD_CASES },
    });

    await harness.handler({ ...JOB, checkRunId: CHECK_RUN_ID });

    expect(harness.reportVerdict).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        verdict: 'mixed-test',
        conclusion: 'failure',
        checkRunId: CHECK_RUN_ID,
        summary: expect.stringContaining('already passes | pass | pass |'),
      }),
    );
    expect(harness.reportVerdict.mock.calls[0]?.[0]?.summary).toContain(
      'reproduces regression | fail | pass |',
    );
    expect(harness.insertRun).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        verdict: 'mixed-test',
        caseEvidence: {
          reproducing: 1,
          nonReproducing: 1,
          totalCases: 2,
          cases: [
            { id: NON_REPRODUCING_CASE, base: 'pass', head: 'pass' },
            { id: REPRODUCING_CASE, base: 'fail', head: 'pass' },
          ],
        },
      }),
    );
  });
});

describe('createDifferentialHandler — new symbol', () => {
  it.each([
    { runA: RUN_A_IMPORT_ERROR, status: 'import-error' },
    { runA: { ...RUN_A_IMPORT_ERROR, stderr: 'SyntaxError: Unexpected token' }, status: 'syntax-error' },
  ])('maps base $status plus passing head to new-symbol/neutral without case evidence', async ({ runA, status }) => {
    const harness = buildHarness();
    givenVitestRepo(harness);
    harness.runner.mockResolvedValue({
      runA: { ...runA, caseResults: BASE_CASES },
      runB: { ...RUN_B_PASS, caseResults: HEAD_CASES },
    });
    harness.reportVerdict.mockResolvedValue(undefined);

    await harness.handler(JOB);

    expect(harness.reportVerdict).toHaveBeenCalledTimes(1);
    const report = harness.reportVerdict.mock.calls[0]?.[0];
    expect(report).toMatchObject({
      verdict: 'new-symbol',
      conclusion: 'neutral',
      title: 'New feature test (base import/syntax error)',
    });
    expect(report?.summary).not.toContain('### Test case evidence');
    expect(harness.insertRun.mock.calls[0]?.[0]).not.toHaveProperty('caseEvidence');
    expect(messagesOf(harness.info)).toContain(
      `verdict: new-symbol (runA=${status}, runB=pass, 2300ms)`,
    );
  });
});

describe('createDifferentialHandler — environment failure', () => {
  it('never lets a sandbox timeout become a verdict on the PR', async () => {
    const harness = buildHarness();
    givenVitestRepo(harness);
    harness.runner.mockResolvedValue({
      runA: { ...RUN_A_TIMEOUT, caseResults: BASE_CASES },
      runB: { ...RUN_B_PASS, caseResults: HEAD_CASES },
    });
    harness.reportVerdict.mockResolvedValue(undefined);

    await harness.handler(JOB);

    expect(harness.reportVerdict).toHaveBeenCalledTimes(1);
    const report = harness.reportVerdict.mock.calls[0]?.[0];
    expect(report).toMatchObject({
      verdict: 'environment-failure',
      conclusion: 'neutral',
      title: 'Sandbox environment failure',
      durationMs: RUN_A_TIMEOUT.durationMs + RUN_B_PASS.durationMs,
    });
    expect(report?.summary).not.toContain('### Test case evidence');
    expect(harness.insertRun.mock.calls[0]?.[0]).not.toHaveProperty('caseEvidence');
    expect(messagesOf(harness.info)).toContain(
      'verdict: environment-failure (runA=timeout, runB=pass, 120800ms)',
    );
  });

  it('does not use case results when the head runner reports a command error', async () => {
    const harness = buildHarness();
    givenVitestRepo(harness);
    harness.runner.mockResolvedValue({
      runA: { ...RUN_A_FAIL, caseResults: BASE_CASES },
      runB: { ...RUN_B_PASS, exitCode: 127, caseResults: HEAD_CASES },
    });

    await harness.handler(JOB);

    const report = harness.reportVerdict.mock.calls[0]?.[0];
    expect(report).toMatchObject({ verdict: 'environment-failure', conclusion: 'neutral' });
    expect(report?.summary).not.toContain('### Test case evidence');
    expect(harness.insertRun.mock.calls[0]?.[0]).not.toHaveProperty('caseEvidence');
  });
});

describe('createDifferentialHandler — head lockfile differs', () => {
  it('passes independently derived hashes and install commands from each tree', async () => {
    const differentLockfile = "lockfileVersion: '9.0'\nimporters:\n  .: {}\n";
    expect(differentLockfile).not.toBe(LOCKFILE_TEXT);

    const harness = buildHarness();
    givenVitestRepo(harness);
    harness.listPaths.mockResolvedValueOnce(BASE_FILES).mockResolvedValueOnce([
      'package.json',
      'pnpm-lock.yaml',
      'tests/app.test.ts',
    ]);
    harness.fetchTextFile
      .mockResolvedValueOnce(PACKAGE_JSON)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(LOCKFILE_TEXT)
      .mockResolvedValueOnce(differentLockfile);
    harness.runner.mockResolvedValue({ runA: RUN_A_FAIL, runB: RUN_B_PASS });
    harness.reportVerdict.mockResolvedValue(undefined);

    await harness.handler(JOB);

    const request: DifferentialRunRequest | undefined = harness.runner.mock.calls[0]?.[0];
    expect(harness.fetchTextFile).toHaveBeenLastCalledWith({
      repoFullName: JOB.repoFullName,
      path: 'pnpm-lock.yaml',
      ref: JOB.headSha,
      installationId: JOB.installationId,
    });
    expect(request?.lockfileKey).toBe(EXPECTED_LOCKFILE_KEY);
    expect(request?.headLockfileKey).toBe(createHash('sha256').update(differentLockfile, 'utf8').digest('hex'));
    expect(request?.installCommand).toBe('npm ci');
    expect(request?.headInstallCommand).toBe('npx --yes pnpm install --frozen-lockfile');
  });
});

describe('createDifferentialHandler — head archive failure', () => {
  it('rethrows for retry rather than replaying the full diff or reporting an outcome', async () => {
    const harness = buildHarness();
    givenVitestRepo(harness);
    const failure = new Error('failed to download head tarball: HTTP 500');
    harness.repoTarball.mockImplementation(async ({ ref }) => {
      if (ref === JOB.headSha) throw failure;
      return TARBALL;
    });

    await expect(harness.handler({ ...JOB, checkRunId: CHECK_RUN_ID })).rejects.toBe(failure);

    expect(harness.runner).not.toHaveBeenCalled();
    expect(harness.reportNoTestChanges).not.toHaveBeenCalled();
    expect(harness.reportVerdict).not.toHaveBeenCalled();
    expect(harness.insertRun).not.toHaveBeenCalled();
  });
});

describe('createDifferentialHandler — unsupported repository', () => {
  it('completes the exact check as neutral before any sandbox work', async () => {
    const harness = buildHarness();
    harness.prDiff.mockResolvedValue(pinnedDiff(MIXED_DIFF));
    harness.fetchTextFile.mockResolvedValue(null);

    await expect(harness.handler({ ...JOB, checkRunId: CHECK_RUN_ID })).resolves.toBeUndefined();

    // Only the two manifest probes ran; no tree listing, tarball, or sandbox.
    expect(harness.fetchTextFile).toHaveBeenCalledTimes(2);
    expect(harness.listPaths).not.toHaveBeenCalled();
    expect(harness.repoTarball).not.toHaveBeenCalled();
    expect(harness.runner).not.toHaveBeenCalled();
    expect(harness.reportVerdict).not.toHaveBeenCalled();
    expect(harness.insertRun).not.toHaveBeenCalled();

    expect(harness.reportNoTestChanges).toHaveBeenCalledExactlyOnceWith({
      repoFullName: JOB.repoFullName,
      headSha: JOB.headSha,
      installationId: JOB.installationId,
      checkRunId: CHECK_RUN_ID,
      title: 'No supported test runner detected',
      summary: expect.stringContaining(MERGE_BASE_SHA),
    });
    expect(firstMessage(harness.warn)).toContain('no supported test runner detected');
    expect(harness.error).not.toHaveBeenCalled();
  });
});

describe('createDifferentialHandler — runner failure', () => {
  it('logs and rethrows so BullMQ retries, without reporting a verdict', async () => {
    const harness = buildHarness();
    givenVitestRepo(harness);
    const failure = new Error('E2B sandbox creation failed: HTTP 500');
    harness.runner.mockRejectedValue(failure);

    await expect(harness.handler(JOB)).rejects.toBe(failure);

    expect(harness.reportVerdict).not.toHaveBeenCalled();
    expect(harness.error).toHaveBeenCalledTimes(1);
    const logged = firstMessage(harness.error);
    expect(logged).toContain('differential runner failed');
    expect(logged).toContain('octocat/hello-world#7');
    expect(logged).toContain('HTTP 500');
    // No success line may claim a verdict that was never computed.
    expect(messagesOf(harness.info).some((message) => message.includes('verdict:'))).toBe(false);
  });
});

describe('createDifferentialHandler — verdict report failure', () => {
  it('logs and rethrows; re-completing the check run is idempotent', async () => {
    const harness = buildHarness();
    givenVitestRepo(harness);
    harness.runner.mockResolvedValue({ runA: RUN_A_FAIL, runB: RUN_B_PASS });
    const failure = new Error('failed to complete check run: HTTP 500');
    harness.reportVerdict.mockRejectedValue(failure);

    await expect(harness.handler(JOB)).rejects.toBe(failure);

    expect(harness.error).toHaveBeenCalledTimes(1);
    const logged = firstMessage(harness.error);
    expect(logged).toContain('failed to report verdict verified-fix');
    expect(logged).toContain('HTTP 500');
    // An unreported verdict must never be persisted either.
    expect(harness.insertRun).not.toHaveBeenCalled();
    expect(
      messagesOf(harness.info).some((message) =>
        message.includes('reported verdict verified-fix'),
      ),
    ).toBe(false);
  });
});

describe('createDifferentialHandler — no database configured', () => {
  it('splits with the default globs when no config store is configured', async () => {
    const harness = buildHarness({ repoConfigStore: null });
    harness.prDiff.mockResolvedValue(pinnedDiff(IMPL_ONLY_DIFF));

    await harness.handler(JOB);

    expect(harness.lookupConfig).not.toHaveBeenCalled();
    const summary = harness.reportNoTestChanges.mock.calls[0]?.[0]?.summary ?? '';
    expect(summary).toContain(`(${DEFAULT_TEST_GLOBS.join(', ')})`);
  });

  it('reports the verdict without persisting a run when runs is null', async () => {
    const harness = buildHarness({ runs: null });
    givenVitestRepo(harness);
    harness.runner.mockResolvedValue({ runA: RUN_A_FAIL, runB: RUN_B_PASS });
    harness.reportVerdict.mockResolvedValue(undefined);

    await expect(harness.handler(JOB)).resolves.toBeUndefined();

    expect(harness.reportVerdict).toHaveBeenCalledTimes(1);
    expect(harness.reportVerdict.mock.calls[0]?.[0]).not.toHaveProperty('checkRunId');
    expect(harness.insertRun).not.toHaveBeenCalled();
    expect(harness.error).not.toHaveBeenCalled();
    expect(messagesOf(harness.info)).toContain(
      'reported verdict verified-fix for octocat/hello-world#7',
    );
  });
});

describe('createDifferentialHandler — run persistence failure', () => {
  it('logs and rethrows after the verdict was reported so BullMQ retries', async () => {
    const harness = buildHarness();
    givenVitestRepo(harness);
    harness.runner.mockResolvedValue({ runA: RUN_A_FAIL, runB: RUN_B_PASS });
    harness.reportVerdict.mockResolvedValue(undefined);
    const failure = new Error('insert into verification_runs failed: connection refused');
    harness.insertRun.mockRejectedValue(failure);

    await expect(harness.handler(JOB)).rejects.toBe(failure);

    // The (idempotent) GitHub report already happened: the retry re-reports the
    // same verdict and may insert the row again — the accepted v1 edge.
    expect(harness.reportVerdict).toHaveBeenCalledTimes(1);
    expect(harness.insertRun).toHaveBeenCalledTimes(1);
    expect(harness.error).toHaveBeenCalledTimes(1);
    const logged = firstMessage(harness.error);
    expect(logged).toContain('failed to persist verification run');
    expect(logged).toContain('octocat/hello-world#7');
    expect(logged).toContain('connection refused');
    // The success line must not claim a completed, recorded run.
    expect(
      messagesOf(harness.info).some((message) =>
        message.includes('reported verdict verified-fix'),
      ),
    ).toBe(false);
  });
});

describe('createDifferentialHandler — missing installation id', () => {
  it('warns and touches no port before the diff fetch', async () => {
    const harness = buildHarness();

    await expect(harness.handler({ ...JOB, installationId: null })).resolves.toBeUndefined();

    expect(harness.lookupConfig).not.toHaveBeenCalled();
    expect(harness.prDiff).not.toHaveBeenCalled();
    expect(harness.reportNoTestChanges).not.toHaveBeenCalled();
    expect(harness.fetchTextFile).not.toHaveBeenCalled();
    expect(harness.listPaths).not.toHaveBeenCalled();
    expect(harness.repoTarball).not.toHaveBeenCalled();
    expect(harness.runner).not.toHaveBeenCalled();
    expect(harness.reportVerdict).not.toHaveBeenCalled();
    expect(harness.insertRun).not.toHaveBeenCalled();

    expect(harness.warn).toHaveBeenCalledTimes(1);
    const warning = firstMessage(harness.warn);
    expect(warning).toContain('octocat/hello-world');
    expect(warning).toContain('pr=7');
    expect(warning.toLowerCase()).toContain('installation');

    // It must not look like a received-and-processed job.
    expect(messagesOf(harness.info).some((message) => message.includes('verification job received'))).toBe(false);
  });
});
