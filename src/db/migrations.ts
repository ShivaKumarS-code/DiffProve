/**
 * Schema migrations for the run history database.
 *
 * The SQL lives in this module as string constants instead of loose `.sql`
 * files on purpose: `tsc` only copies compiled modules into `dist/`, so a
 * runtime file read would break the shipped build.
 *
 * `001-init` creates the four tables from docs/architecture.md
 * ("Core Data Model" → "PostgreSQL Tables") with the constraints that document
 * lists. Two details are worth calling out:
 *
 * - `repositories.created_at` is not in the architecture's column list, but
 *   `RepositoryRow.createdAt` is part of the shared contract in
 *   `src/db/types.ts`, so the column has to exist for the row mapper.
 * - `repositories.installation_id` is nullable and cleared (`on delete set
 *   null`) when an installation is removed, so uninstalling the App keeps the
 *   repo and its run history instead of deleting it. The run tables cascade
 *   when a repository row is deleted.
 *
 * `gen_random_uuid()` is built into PostgreSQL 13+; no extension is required.
 */

export const MIGRATIONS: readonly { name: string; sql: string }[] = [
  {
    name: '001-init',
    sql: `
      create table if not exists installations (
        id uuid primary key default gen_random_uuid(),
        github_installation_id bigint not null unique,
        account_login text,
        created_at timestamptz not null default now()
      );

      create table if not exists repositories (
        id uuid primary key default gen_random_uuid(),
        installation_id uuid references installations (id) on delete set null,
        repo_full_name text not null unique,
        language text check (language in ('python', 'node')),
        test_command text,
        test_file_globs text[],
        enabled boolean not null default true,
        created_at timestamptz not null default now()
      );

      create table if not exists env_snapshots (
        id uuid primary key default gen_random_uuid(),
        repository_id uuid not null references repositories (id) on delete cascade,
        lockfile_hash text not null,
        sandbox_template_id text not null,
        last_used_at timestamptz not null default now()
      );

      create table if not exists verification_runs (
        id uuid primary key default gen_random_uuid(),
        repository_id uuid not null references repositories (id) on delete cascade,
        pr_number integer not null,
        base_sha text not null,
        head_sha text not null,
        changed_test_files text[] not null default '{}',
        run_a_status text not null,
        run_b_status text not null,
        verdict text not null,
        duration_ms integer not null,
        run_a_log text not null default '',
        run_b_log text not null default '',
        created_at timestamptz not null default now()
      );

      create index if not exists verification_runs_repository_created_at_idx
        on verification_runs (repository_id, created_at desc);

      create index if not exists env_snapshots_repository_lockfile_hash_idx
        on env_snapshots (repository_id, lockfile_hash);
    `,
  },
  {
    name: '002-dedupe-verification-runs',
    sql: `
      delete from verification_runs a
      using verification_runs b
      where a.repository_id = b.repository_id
        and a.pr_number = b.pr_number
        and a.base_sha = b.base_sha
        and a.head_sha = b.head_sha
        and (
          a.created_at < b.created_at
          or (a.created_at = b.created_at and a.ctid < b.ctid)
        );

      create unique index if not exists verification_runs_repo_pr_base_head_uidx
        on verification_runs (repository_id, pr_number, base_sha, head_sha);
    `,
  },
  {
    name: '003-verification-run-case-evidence',
    sql: `
      alter table verification_runs add column if not exists case_evidence jsonb;
    `,
  },
];
