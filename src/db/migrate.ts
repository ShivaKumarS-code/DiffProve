/**
 * Migration runner for the run history database.
 *
 * Applies `MIGRATIONS` in array order, skipping every name already recorded in
 * `schema_migrations`, so it is safe to call on every process start (and the
 * integration test calls it twice to prove that). Each migration runs in its
 * own transaction with its name recorded in the same transaction: a migration
 * either fully applies and is recorded, or neither happens.
 *
 * The `DATABASE_URL` embeds credentials; nothing here logs it or includes it
 * in an error (guardrail #2). Errors are re-thrown untouched for the caller to
 * log without connection details.
 */

import { MIGRATIONS } from './migrations.js';
import type { DbPool } from './pool.js';

const CREATE_SCHEMA_MIGRATIONS_TABLE = `
  create table if not exists schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )
`;

export async function runMigrations(pool: DbPool): Promise<void> {
  await pool.query(CREATE_SCHEMA_MIGRATIONS_TABLE);

  const applied = await pool.query<{ name: string }>('select name from schema_migrations');
  const appliedNames = new Set(applied.map((row) => row.name));

  for (const migration of MIGRATIONS) {
    if (appliedNames.has(migration.name)) {
      continue;
    }

    await pool.query('begin');
    try {
      await pool.query(migration.sql);
      await pool.query('insert into schema_migrations (name) values ($1)', [migration.name]);
      await pool.query('commit');
    } catch (error) {
      // Swallow a failing rollback (the connection may already be gone) so the
      // real migration error is what reaches the caller.
      await pool.query('rollback').catch(() => undefined);
      throw error;
    }
  }
}
