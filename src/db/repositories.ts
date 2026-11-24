/**
 * Repository rows: onboarding, config overrides, and the worker's pre-run
 * config lookup (docs/architecture.md, "Core Data Model" → "PostgreSQL
 * Tables", and step 2 of "End-to-End Verification Pipeline": the
 * "repo-configured test globs").
 *
 * `createRepositoryStore` implements the `RepositoryStore` port over `pg`.
 * `createRepoConfigLookup` adapts those rows to the worker-facing
 * `RepoConfigStore`; it uses an index-backed select by full name when it is
 * handed the store from `createRepositoryStore`, and falls back to the port's
 * `listRepositories()` for fakes that only implement the contract.
 */

import type { DbPool } from './pool.js';
import type { RepositoryRow, RepositoryStore, RepoConfigStore } from './types.js';

/** Raw `repositories` row exactly as PostgreSQL returns it. */
type RepositoryDbRow = {
  id: string;
  installation_id: string | null;
  repo_full_name: string;
  language: 'python' | 'node' | null;
  test_command: string | null;
  test_file_globs: string[] | null;
  enabled: boolean;
  created_at: Date;
};

/**
 * Public ports take ids from HTTP routes, where a non-uuid value would
 * otherwise become PostgreSQL error 22P02 (surfacing as a 500) instead of the
 * plain "no such row" null that callers handle.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Maps a snake_case database row onto the camelCase contract. */
function mapRepository(row: RepositoryDbRow): RepositoryRow {
  return {
    id: row.id,
    installationId: row.installation_id,
    repoFullName: row.repo_full_name,
    language: row.language,
    testCommand: row.test_command,
    testFileGlobs: row.test_file_globs,
    enabled: row.enabled,
    createdAt: row.created_at,
  };
}

/**
 * The port plus the internal by-name select used by `createRepoConfigLookup`.
 * Only the port is part of the public store type so consumers can keep using
 * fakes that implement exactly `RepositoryStore`.
 */
type RepositoryLookupStore = RepositoryStore & {
  getRepositoryByFullName(repoFullName: string): Promise<RepositoryRow | null>;
};

function hasRepositoryLookup(store: RepositoryStore): store is RepositoryLookupStore {
  return typeof (store as Partial<RepositoryLookupStore>).getRepositoryByFullName === 'function';
}

export function createRepositoryStore(pool: DbPool): RepositoryStore {
  async function selectRepositoryByFullName(repoFullName: string): Promise<RepositoryRow | null> {
    const rows = await pool.query<RepositoryDbRow>(
      'select * from repositories where repo_full_name = $1',
      [repoFullName],
    );
    const row = rows[0];
    return row ? mapRepository(row) : null;
  }

  async function selectRepositoryById(id: string): Promise<RepositoryRow | null> {
    if (!isUuid(id)) {
      return null;
    }
    const rows = await pool.query<RepositoryDbRow>('select * from repositories where id = $1', [id]);
    const row = rows[0];
    return row ? mapRepository(row) : null;
  }

  /**
   * Resolves the GitHub installation id to the `installations` uuid the FK
   * needs. A job can arrive before its `installation` webhook event was
   * stored, so a missing installation resolves to null (the column is
   * nullable) instead of failing the insert.
   */
  async function resolveInstallationUuid(githubInstallationId: number | null): Promise<string | null> {
    if (githubInstallationId === null) {
      return null;
    }
    const rows = await pool.query<{ id: string }>(
      'select id from installations where github_installation_id = $1',
      [githubInstallationId],
    );
    return rows[0]?.id ?? null;
  }

  async function ensureRepository(input: {
    repoFullName: string;
    installationId: number | null;
    language: 'python' | 'node';
  }): Promise<RepositoryRow> {
    const installationId = await resolveInstallationUuid(input.installationId);

    const rows = await pool.query<RepositoryDbRow>(
      `insert into repositories (installation_id, repo_full_name, language)
       values ($1, $2, $3)
       on conflict (repo_full_name) do update
         set installation_id = coalesce(excluded.installation_id, repositories.installation_id),
             language = excluded.language
       returning *`,
      [installationId, input.repoFullName, input.language],
    );

    const row = rows[0];
    if (!row) {
      throw new Error(`repository upsert for "${input.repoFullName}" returned no row`);
    }
    return mapRepository(row);
  }

  async function listRepositories(): Promise<RepositoryRow[]> {
    const rows = await pool.query<RepositoryDbRow>(
      'select * from repositories order by repo_full_name asc',
    );
    return rows.map(mapRepository);
  }

  async function updateRepositoryConfig(
    id: string,
    config: { testCommand?: string | null; testFileGlobs?: string[] | null; enabled?: boolean },
  ): Promise<RepositoryRow | null> {
    if (!isUuid(id)) {
      return null;
    }

    // Column names come from this fixed allowlist; values stay parameterized.
    const assignments: string[] = [];
    const params: unknown[] = [];

    if (config.testCommand !== undefined) {
      params.push(config.testCommand);
      assignments.push(`test_command = $${params.length}`);
    }
    if (config.testFileGlobs !== undefined) {
      params.push(config.testFileGlobs);
      assignments.push(`test_file_globs = $${params.length}`);
    }
    if (config.enabled !== undefined) {
      params.push(config.enabled);
      assignments.push(`enabled = $${params.length}`);
    }

    if (assignments.length === 0) {
      return selectRepositoryById(id);
    }

    params.push(id);
    const rows = await pool.query<RepositoryDbRow>(
      `update repositories set ${assignments.join(', ')} where id = $${params.length} returning *`,
      params,
    );

    const row = rows[0];
    return row ? mapRepository(row) : null;
  }

  const store: RepositoryLookupStore = {
    ensureRepository,
    getRepository: selectRepositoryById,
    listRepositories,
    updateRepositoryConfig,
    getRepositoryByFullName: selectRepositoryByFullName,
  };

  return store;
}

/**
 * Worker-facing config lookup: resolves repo-configured globs, the test
 * command override, and the `enabled` flag by repository full name. Returns
 * null when the repository has no row, which the worker treats as "use the
 * auto-detected defaults".
 */
export function createRepoConfigLookup(store: RepositoryStore): RepoConfigStore {
  return {
    async lookupConfig(repoFullName) {
      const repository = hasRepositoryLookup(store)
        ? await store.getRepositoryByFullName(repoFullName)
        : ((await store.listRepositories()).find((row) => row.repoFullName === repoFullName) ?? null);

      if (!repository) {
        return null;
      }

      return {
        testFileGlobs: repository.testFileGlobs,
        testCommand: repository.testCommand,
        enabled: repository.enabled,
      };
    },
  };
}
