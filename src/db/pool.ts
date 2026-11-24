/**
 * PostgreSQL connection pool for the run history database
 * (docs/architecture.md, "Component Architecture & Stack" → "Run History DB").
 *
 * `createPgPool` is the only place a `DATABASE_URL` becomes a live pool. That
 * URL may embed credentials, so it is never logged and never interpolated into
 * an error message (guardrail #2); `pg` errors are propagated unchanged.
 *
 * Importing this module is safe without PostgreSQL running: constructing a
 * `pg` pool opens no connection, the first query does.
 */

import { Pool } from 'pg';

/** Minimal query surface the stores depend on (satisfied by a live `pg` pool). */
export interface DbPool {
  query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

/**
 * Creates the shared pool (at most 10 connections). The caller owns its
 * lifetime and must `close()` it on shutdown, including in test teardown.
 */
export function createPgPool(databaseUrl: string): DbPool {
  const pool = new Pool({ connectionString: databaseUrl, max: 10 });

  return {
    query: async <T extends Record<string, unknown>>(sql: string, params?: unknown[]) => {
      const result = await pool.query(sql, params);
      return result.rows as T[];
    },
    close: () => pool.end(),
  };
}
