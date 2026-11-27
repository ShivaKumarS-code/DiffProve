import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createInstallationStore } from './installations.js';
import { runMigrations } from './migrate.js';
import { createPgPool, type DbPool } from './pool.js';
import { createRepoConfigLookup, createRepositoryStore } from './repositories.js';
import type {
  InstallationStore,
  RepositoryRow,
  RepositoryStore,
  RepoConfigStore,
  VerificationRunInsert,
  VerificationRunStore,
} from './types.js';
import { createVerificationRunStore } from './verification-runs.js';

const databaseUrl = process.env.DATABASE_URL;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const mixedEvidence: NonNullable<VerificationRunInsert['caseEvidence']> = {
  reproducing: 1,
  nonReproducing: 1,
  totalCases: 3,
  cases: [
    { id: 'test regression', base: 'fail', head: 'pass' },
    { id: 'test <always passes>', base: 'pass', head: 'pass' },
    { id: 'test skipped', base: 'unknown', head: 'skipped' },
  ],
};

/** Unique repository name per test run, so CI reruns never collide. */
function uniqueRepoFullName(): string {
  return `diffprove-test/${randomUUID()}`;
}

/** Random 48-bit GitHub installation id, kept inside JavaScript's safe range. */
function uniqueInstallationId(): number {
  return Number.parseInt(randomUUID().replaceAll('-', '').slice(0, 12), 16);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function makeRun(
  repoFullName: string,
  overrides: Partial<VerificationRunInsert> = {},
): VerificationRunInsert {
  return {
    repoFullName,
    installationId: null,
    language: 'node',
    prNumber: 42,
    baseSha: 'base-sha',
    headSha: 'head-sha',
    changedTestFiles: ['tests/example.test.ts'],
    runAStatus: 'fail',
    runBStatus: 'pass',
    verdict: 'verified-fix',
    durationMs: 1_200,
    runALog: 'Run A failed',
    runBLog: 'Run B passed',
    ...overrides,
  };
}

describe('Verification run JSONB decoding', () => {
  it.each([
    ['legacy column missing', undefined, null],
    ['legacy SQL null', null, null],
    ['valid mixed evidence', mixedEvidence, mixedEvidence],
    ['JSON string instead of an object', JSON.stringify(mixedEvidence), null],
    ['status outside the case enum', { ...mixedEvidence, cases: [{ id: 'one', base: true, head: 'pass' }] }, null],
    ['invalid aggregate count', { ...mixedEvidence, reproducing: 1.5 }, null],
  ])('preserves the run with %s', async (_label, stored, expected) => {
    const query = vi.fn<() => Promise<Record<string, unknown>[]>>()
      .mockResolvedValueOnce([{
        id: 'run-id',
        verdict: 'mixed-test',
        case_evidence: stored,
      }])
      .mockResolvedValueOnce([{ total_runs: 1, weak_test_count: 0, mixed_test_count: 1 }]);
    const pool: DbPool = {
      query: async <T extends Record<string, unknown>>() => (await query()) as T[],
      close: vi.fn<DbPool['close']>(),
    };
    const store = createVerificationRunStore(pool, createRepositoryStore(pool));

    await expect(store.listRuns('repo-id')).resolves.toMatchObject({
      runs: [{ id: 'run-id', verdict: 'mixed-test', caseEvidence: expected }],
      catchRate: 0,
      mixedTestCount: 1,
    });
  });
});

describe.skipIf(!process.env.DATABASE_URL)('PostgreSQL stores (integration, needs DATABASE_URL)', () => {
  let pool: DbPool | undefined;
  let installations: InstallationStore;
  let repositories: RepositoryStore;
  let repoConfigs: RepoConfigStore;
  let runs: VerificationRunStore;

  /** Narrowed access to the pool for assertions that need raw SQL. */
  function db(): DbPool {
    if (!pool) {
      throw new Error('PostgreSQL pool is not initialized');
    }
    return pool;
  }

  /** Creates a fresh repository row with a unique name for this test run. */
  async function createRepository(
    language: 'python' | 'node' | null = 'node',
  ): Promise<RepositoryRow> {
    return repositories.ensureRepository({
      repoFullName: uniqueRepoFullName(),
      installationId: null,
      language,
    });
  }

  beforeAll(async () => {
    if (!databaseUrl) {
      throw new Error('DATABASE_URL must be set for the PostgreSQL integration tests');
    }

    const createdPool = createPgPool(databaseUrl);
    pool = createdPool;

    // Twice: the second application must record nothing, which is the
    // idempotency the server relies on at every start.
    await runMigrations(createdPool);
    await runMigrations(createdPool);

    installations = createInstallationStore(createdPool);
    repositories = createRepositoryStore(createdPool);
    repoConfigs = createRepoConfigLookup(repositories);
    runs = createVerificationRunStore(createdPool, repositories);
  }, 30_000);

  afterAll(async () => {
    try {
      await pool?.close();
    } finally {
      // A failed close must still clear the handle so a retried hook cannot
      // double-end the same pool.
      pool = undefined;
    }
  });

  it('applies migrations once and records them in schema_migrations', async () => {
    await runMigrations(db()); // third call: still a no-op

    const rows = await db().query<{ name: string; count: number }>(
      'select name, count(*)::int as count from schema_migrations where name = any($1::text[]) group by name order by name',
      [['001-init', '003-verification-run-case-evidence']],
    );

    expect(rows).toEqual([
      { name: '001-init', count: 1 },
      { name: '003-verification-run-case-evidence', count: 1 },
    ]);
  });

  it('upserts an installation and updates the account login on conflict', async () => {
    const githubInstallationId = uniqueInstallationId();

    await installations.upsertInstallation({ githubInstallationId, accountLogin: 'first-owner' });
    await installations.upsertInstallation({ githubInstallationId, accountLogin: 'second-owner' });

    const rows = await db().query<{ account_login: string }>(
      'select account_login from installations where github_installation_id = $1',
      [githubInstallationId],
    );

    expect(rows).toEqual([{ account_login: 'second-owner' }]);
  });

  it('keeps one repository row per full name and resolves the installation uuid', async () => {
    const githubInstallationId = uniqueInstallationId();
    await installations.upsertInstallation({ githubInstallationId, accountLogin: 'acme' });

    const repoFullName = uniqueRepoFullName();
    const created = await repositories.ensureRepository({
      repoFullName,
      installationId: githubInstallationId,
      language: 'python',
    });

    expect(created.id).toMatch(UUID_PATTERN);
    expect(created.repoFullName).toBe(repoFullName);
    expect(created.language).toBe('python');
    expect(created.enabled).toBe(true);
    expect(created.testCommand).toBeNull();
    expect(created.testFileGlobs).toBeNull();
    expect(created.installationId).toMatch(UUID_PATTERN);
    expect(created.createdAt).toBeInstanceOf(Date);

    // Same full name -> same row; the language is refreshed and a null
    // installation (job without installation context) keeps the existing link.
    const repeated = await repositories.ensureRepository({
      repoFullName,
      installationId: null,
      language: 'node',
    });

    expect(repeated.id).toBe(created.id);
    expect(repeated.language).toBe('node');
    expect(repeated.installationId).toBe(created.installationId);

    await expect(repositories.getRepository(created.id)).resolves.toEqual(repeated);
  });

  it('accepts language: null on onboarding and preserves an existing language on later null calls', async () => {
    const repoFullName = uniqueRepoFullName();

    const onboarded = await repositories.ensureRepository({
      repoFullName,
      installationId: null,
      language: null,
    });
    expect(onboarded.language).toBeNull();

    const detected = await repositories.ensureRepository({
      repoFullName,
      installationId: null,
      language: 'python',
    });
    expect(detected.id).toBe(onboarded.id);
    expect(detected.language).toBe('python');

    const reonboarded = await repositories.ensureRepository({
      repoFullName,
      installationId: null,
      language: null,
    });
    expect(reonboarded.id).toBe(onboarded.id);
    expect(reonboarded.language).toBe('python');
  });

  it('patches only supplied config fields and clears overrides with explicit null', async () => {
    const repository = await createRepository('node');

    const commandOnly = await repositories.updateRepositoryConfig(repository.id, {
      testCommand: 'npx vitest run --changed',
    });

    expect(commandOnly?.testCommand).toBe('npx vitest run --changed');
    expect(commandOnly?.testFileGlobs).toBeNull();
    expect(commandOnly?.enabled).toBe(true);

    const globs = await repositories.updateRepositoryConfig(repository.id, {
      testFileGlobs: ['tests/**/*.test.ts'],
    });

    expect(globs?.testFileGlobs).toEqual(['tests/**/*.test.ts']);
    // The earlier command survives a patch that does not mention it.
    expect(globs?.testCommand).toBe('npx vitest run --changed');

    const cleared = await repositories.updateRepositoryConfig(repository.id, {
      testCommand: null,
      enabled: false,
    });

    expect(cleared?.testCommand).toBeNull();
    expect(cleared?.enabled).toBe(false);
    expect(cleared?.testFileGlobs).toEqual(['tests/**/*.test.ts']);

    await expect(
      repositories.updateRepositoryConfig(randomUUID(), { testCommand: 'npx vitest run' }),
    ).resolves.toBeNull();
  });

  it('looks up the worker-facing repo config by full name', async () => {
    const repository = await createRepository('python');

    await expect(repoConfigs.lookupConfig(repository.repoFullName)).resolves.toEqual({
      testFileGlobs: null,
      testCommand: null,
      enabled: true,
    });

    await repositories.updateRepositoryConfig(repository.id, {
      testCommand: 'pytest -q',
      testFileGlobs: ['tests/**/*.py'],
      enabled: false,
    });

    await expect(repoConfigs.lookupConfig(repository.repoFullName)).resolves.toEqual({
      testFileGlobs: ['tests/**/*.py'],
      testCommand: 'pytest -q',
      enabled: false,
    });

    await expect(repoConfigs.lookupConfig(`missing/${randomUUID()}`)).resolves.toBeNull();
  });

  it('inserts runs and computes the weak-test catch rate over the full history', async () => {
    const repository = await createRepository('node');
    const changedTestFiles = ['tests/example.test.ts', 'tests/math.test.ts'];

    await runs.insertRun(
      makeRun(repository.repoFullName, {
        changedTestFiles,
        runAStatus: 'fail',
        runBStatus: 'pass',
        verdict: 'verified-fix',
        durationMs: 1_850,
        runALog: 'Run A failed: AssertionError',
        runBLog: 'Run B passed: 12 tests',
      }),
    );

    // A later timestamp keeps the newest-first assertion deterministic.
    await sleep(10);

    await runs.insertRun(
      makeRun(repository.repoFullName, {
        prNumber: 43,
        changedTestFiles: [],
        runAStatus: 'pass',
        runBStatus: 'fail',
        verdict: 'weak-test',
        durationMs: 90,
        runALog: 'Run A passed',
        runBLog: 'Run B failed',
      }),
    );

    await sleep(10);
    await runs.insertRun(
      makeRun(repository.repoFullName, {
        prNumber: 44,
        verdict: 'mixed-test',
        caseEvidence: mixedEvidence,
      }),
    );

    const history = await runs.listRuns(repository.id);

    expect(history.totalRuns).toBe(3);
    expect(history.weakTestCount).toBe(1);
    expect(history.mixedTestCount).toBe(1);
    expect(history.catchRate).toBe(0.3333);
    expect(history.runs).toHaveLength(3);
    expect(history.runs[0]).toMatchObject({ verdict: 'mixed-test', caseEvidence: mixedEvidence });

    const verified = history.runs.find((run) => run.verdict === 'verified-fix');
    expect(verified).toBeDefined();
    expect(verified?.repositoryId).toBe(repository.id);
    expect(verified?.prNumber).toBe(42);
    expect(verified?.baseSha).toBe('base-sha');
    expect(verified?.headSha).toBe('head-sha');
    expect(verified?.changedTestFiles).toEqual(changedTestFiles);
    expect(verified?.durationMs).toBe(1_850);
    expect(verified?.runALog).toBe('Run A failed: AssertionError');
    expect(verified?.runBLog).toBe('Run B passed: 12 tests');
    expect(verified?.caseEvidence).toBeNull();
    expect(verified?.createdAt).toBeInstanceOf(Date);

    const weak = history.runs.find((run) => run.verdict === 'weak-test');
    expect(weak?.changedTestFiles).toEqual([]);

    // The aggregates cover the whole repository; only `runs` is paginated.
    const limited = await runs.listRuns(repository.id, 1);
    expect(limited.runs).toHaveLength(1);
    expect(limited.totalRuns).toBe(3);
    expect(limited.weakTestCount).toBe(1);
    expect(limited.mixedTestCount).toBe(1);
    expect(limited.catchRate).toBe(0.3333);
  });

  it('upserts verification runs idempotently for the same repository, PR, and SHAs', async () => {
    const repository = await createRepository('node');

    await runs.insertRun(
      makeRun(repository.repoFullName, {
        prNumber: 77,
        baseSha: 'base-1',
        headSha: 'head-1',
        changedTestFiles: ['tests/a.test.ts'],
        runAStatus: 'fail',
        runBStatus: 'pass',
        verdict: 'mixed-test',
        durationMs: 1_000,
        runALog: 'first A',
        runBLog: 'first B',
        caseEvidence: mixedEvidence,
      }),
    );

    await runs.insertRun(
      makeRun(repository.repoFullName, {
        prNumber: 77,
        baseSha: 'base-1',
        headSha: 'head-1',
        changedTestFiles: ['tests/a.test.ts', 'tests/b.test.ts'],
        runAStatus: 'pass',
        runBStatus: 'fail',
        verdict: 'weak-test',
        durationMs: 2_500,
        runALog: 'retry A',
        runBLog: 'retry B',
        caseEvidence: null,
      }),
    );

    const history = await runs.listRuns(repository.id);
    expect(history.totalRuns).toBe(1);
    expect(history.weakTestCount).toBe(1);
    expect(history.mixedTestCount).toBe(0);
    expect(history.runs).toHaveLength(1);
    expect(history.runs[0]).toMatchObject({
      repositoryId: repository.id,
      prNumber: 77,
      baseSha: 'base-1',
      headSha: 'head-1',
      changedTestFiles: ['tests/a.test.ts', 'tests/b.test.ts'],
      runAStatus: 'pass',
      runBStatus: 'fail',
      verdict: 'weak-test',
      durationMs: 2_500,
      runALog: 'retry A',
      runBLog: 'retry B',
      caseEvidence: null,
    });
  });

  it('returns a null catch rate for a repository with no runs', async () => {
    const repository = await createRepository('python');

    await expect(runs.listRuns(repository.id)).resolves.toEqual({
      runs: [],
      totalRuns: 0,
      weakTestCount: 0,
      mixedTestCount: 0,
      catchRate: null,
    });
  });

  it('removes an installation, unlinks its repositories, and tolerates repeats', async () => {
    const githubInstallationId = uniqueInstallationId();
    await installations.upsertInstallation({ githubInstallationId, accountLogin: 'to-remove' });

    const repository = await repositories.ensureRepository({
      repoFullName: uniqueRepoFullName(),
      installationId: githubInstallationId,
      language: 'node',
    });
    expect(repository.installationId).toMatch(UUID_PATTERN);

    await installations.removeInstallation(githubInstallationId);

    const remaining = await db().query<{ count: number }>(
      'select count(*)::int as count from installations where github_installation_id = $1',
      [githubInstallationId],
    );
    expect(remaining).toEqual([{ count: 0 }]);

    // `on delete set null` keeps the repository (and its run history); only
    // the installation link is cleared.
    const unlinked = await repositories.getRepository(repository.id);
    expect(unlinked?.installationId).toBeNull();

    // A redelivered `installation.deleted` event must not fail.
    await expect(installations.removeInstallation(githubInstallationId)).resolves.toBeUndefined();
  });
});
