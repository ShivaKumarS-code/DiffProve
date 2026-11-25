/**
 * Persistence for completed differential runs (architecture "Run History DB"
 * row and pipeline step 6: "saves the record to PostgreSQL").
 *
 * `createVerificationRunStore` takes the `RepositoryStore` as a second
 * constructor argument rather than duplicating the repository upsert: every
 * run is inserted through an ensured repository row, so the FK is always
 * satisfiable and the repo's language/installation linkage stays current.
 */

import type { DbPool } from './pool.js';
import type {
  RepositoryStore,
  RunHistorySummary,
  VerificationRunInsert,
  VerificationRunRow,
  VerificationRunStore,
} from './types.js';

/** Raw `verification_runs` row exactly as PostgreSQL returns it. */
type VerificationRunDbRow = {
  id: string;
  repository_id: string;
  pr_number: number;
  base_sha: string;
  head_sha: string;
  changed_test_files: string[];
  run_a_status: string;
  run_b_status: string;
  verdict: string;
  duration_ms: number;
  run_a_log: string;
  run_b_log: string;
  created_at: Date;
};

/** Aggregate row behind the catch rate. `::int` keeps `count(*)` a JS number. */
type RunAggregateDbRow = {
  total_runs: number;
  weak_test_count: number;
};

/**
 * The SQL run columns in contract order; kept in one place so the select and
 * the insert cannot drift apart.
 */
const RUN_COLUMNS = `id,
       repository_id,
       pr_number,
       base_sha,
       head_sha,
       changed_test_files,
       run_a_status,
       run_b_status,
       verdict,
       duration_ms,
       run_a_log,
       run_b_log,
       created_at`;

/** Maps a snake_case database row onto the camelCase contract. */
function mapRun(row: VerificationRunDbRow): VerificationRunRow {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    prNumber: row.pr_number,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    changedTestFiles: row.changed_test_files,
    runAStatus: row.run_a_status,
    runBStatus: row.run_b_status,
    verdict: row.verdict,
    durationMs: row.duration_ms,
    runALog: row.run_a_log,
    runBLog: row.run_b_log,
    createdAt: row.created_at,
  };
}

export function createVerificationRunStore(
  pool: DbPool,
  repositories: RepositoryStore,
): VerificationRunStore {
  return {
    async insertRun(run: VerificationRunInsert): Promise<void> {
      const repository = await repositories.ensureRepository({
        repoFullName: run.repoFullName,
        installationId: run.installationId,
        language: run.language,
      });

      // A JS string[] parameter is serialized by `pg` to a PostgreSQL array
      // literal, so `changed_test_files` round-trips as text[].
      await pool.query(
        `insert into verification_runs (
           repository_id, pr_number, base_sha, head_sha, changed_test_files,
           run_a_status, run_b_status, verdict, duration_ms, run_a_log, run_b_log
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         on conflict (repository_id, pr_number, base_sha, head_sha) do update set
           changed_test_files = excluded.changed_test_files,
           run_a_status = excluded.run_a_status,
           run_b_status = excluded.run_b_status,
           verdict = excluded.verdict,
           duration_ms = excluded.duration_ms,
           run_a_log = excluded.run_a_log,
           run_b_log = excluded.run_b_log,
           created_at = now()`,
        [
          repository.id,
          run.prNumber,
          run.baseSha,
          run.headSha,
          run.changedTestFiles,
          run.runAStatus,
          run.runBStatus,
          run.verdict,
          run.durationMs,
          run.runALog,
          run.runBLog,
        ],
      );
    },

    async listRuns(repositoryId: string, limit = 50): Promise<RunHistorySummary> {
      const rows = await pool.query<VerificationRunDbRow>(
        `select ${RUN_COLUMNS}
         from verification_runs
         where repository_id = $1
         order by created_at desc
         limit $2`,
        [repositoryId, limit],
      );

      // One aggregate query for the totals: it covers every run of the
      // repository, while `rows` is only the requested page of history.
      const aggregateRows = await pool.query<RunAggregateDbRow>(
        `select
           count(*)::int as total_runs,
           (count(*) filter (where verdict = 'weak-test'))::int as weak_test_count
         from verification_runs
         where repository_id = $1`,
        [repositoryId],
      );

      const totalRuns = aggregateRows[0]?.total_runs ?? 0;
      const weakTestCount = aggregateRows[0]?.weak_test_count ?? 0;
      const catchRate =
        totalRuns === 0 ? null : Math.round((weakTestCount / totalRuns) * 10000) / 10000;

      return {
        runs: rows.map(mapRun),
        totalRuns,
        weakTestCount,
        catchRate,
      };
    },
  };
}
