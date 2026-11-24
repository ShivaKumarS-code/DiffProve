/**
 * Installation lifecycle persistence (docs/architecture.md, "Core Data Model" →
 * "PostgreSQL Tables"; webhook `installation` events).
 *
 * Both operations are idempotent: GitHub redelivers webhooks, so the upsert
 * converges on the latest `account_login` and deleting an already-absent row
 * is a no-op.
 */

import type { DbPool } from './pool.js';
import type { InstallationRecord, InstallationStore } from './types.js';

export function createInstallationStore(pool: DbPool): InstallationStore {
  return {
    async upsertInstallation(record: InstallationRecord): Promise<void> {
      await pool.query(
        `insert into installations (github_installation_id, account_login)
         values ($1, $2)
         on conflict (github_installation_id) do update
           set account_login = excluded.account_login`,
        [record.githubInstallationId, record.accountLogin],
      );
    },

    async removeInstallation(githubInstallationId: number): Promise<void> {
      await pool.query('delete from installations where github_installation_id = $1', [
        githubInstallationId,
      ]);
    },
  };
}
