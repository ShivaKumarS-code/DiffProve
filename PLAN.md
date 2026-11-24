# Phase 4 Execution Plan — Verdict Reporting & Dashboard

Scope source: `docs/architecture.md`, heading **"MVP Build Phases"**, Phase 4 line:

> **Phase 4 (Verdict Reporting & Dashboard):** Map Run A/B exit codes to rich GitHub Check Run reports and build the Next.js history/config UI.

Also touches these parts of `docs/architecture.md`:
- Heading **"End-to-End Verification Pipeline"** — step 6 in full: "The worker updates the GitHub Check Run with a structured Markdown summary, clipped stdout/stderr excerpts from Run A and Run B, and saves the record to PostgreSQL." And step 2's "repo-configured test globs" — now backed by the `repositories` table instead of hard defaults.
- Heading **"Core Data Model"** — all four PostgreSQL tables (`installations`, `repositories`, `env_snapshots`, `verification_runs`) exactly as specified.
- Heading **"Component Architecture & Stack"** — rows `Run History DB` (PostgreSQL) and `Web Dashboard` (Next.js + Tailwind CSS: repo onboarding, custom test commands, verification history & logs).
- Heading **"API & Interface Contracts"** — `GET /api/repos/:id/runs` (history + weak-test catch rate) and `PATCH /api/repos/:id/config` (override auto-detected `test_command` / `test_file_globs`).
- Heading **"Key Engineering Guardrails"** — #2 unchanged (tokens never in sandboxes/logs; DB credentials never echoed).

## Design decisions

- **PostgreSQL via `pg` + a tiny SQL migration runner** — no ORM, consistent with the dependency-light stack. `DATABASE_URL` is optional (same graceful-degradation pattern as `E2B_API_KEY`): without it the pipeline runs as in Phase 3 and the API answers 503.
- **The Fastify service owns `/api/*`** — the architecture lists repo config and runs endpoints under the server's responsibilities; the Next.js app is a pure frontend that calls them (`NEXT_PUBLIC_API_URL`). Root `package.json` becomes an npm **workspace root** with the service staying as the root package and `apps/web` as a member — no disruptive move of the verified service.
- **Rich report, same conclusions:** the renderer produces the structured Markdown (verdict header, the matrix row that fired, Run A / Run B sections with clipped log excerpts). `new-symbol` stays `neutral` per the matrix's allowed column, now with the annotation the matrix's "(Annotated)" calls for.
- **Repo config drives the worker:** `test_file_globs` overrides the default globs in `splitDiff`; `test_command` overrides the auto-detected targeted command; `enabled=false` leaves a job queued with a warning. Every completed differential is persisted to `verification_runs`; installation webhook events now upsert/remove `installations` rows (the Phase 1 "persistence lands with the DB phase" promise).
- **`env_snapshots`** is created per the Core Data Model but stays metadata-only in v1 (the live snapshot cache remains Redis-backed from Phase 3); the worker records snapshot usage there when a repository row exists.

## Pieces (one subagent per piece, disjoint files)

| # | Piece | Files owned | Architecture headings touched |
|---|-------|--------------|-------------------------------|
| 0 | Plan, DB/report/API contracts, workspace glue, server wiring, commits | `PLAN.md`, `src/db/types.ts`, `src/runner/types.ts` (report input — with piece 2), root `package.json`, `docker-compose.yml`, `.github/workflows/ci.yml`, `src/server.ts`, `README.md`, `.env.example` | glue |
| 1 | DB layer: pool, migrations, stores | `src/db/pool.ts`, `src/db/migrate.ts`, `src/db/migrations/001_init.sql`, `src/db/installations.ts`, `src/db/repositories.ts`, `src/db/verification-runs.ts`, `src/db/db.test.ts` (DATABASE_URL-gated) | Core Data Model, Run History DB row |
| 2 | Rich report renderer + GitHub reporter upgrade | `src/runner/report.ts`, `src/runner/report.test.ts`, `src/runner/matrix.ts` + `matrix.test.ts` (describeVerdict → renderer), `src/runner/types.ts` (VerdictReportInput gains prNumber + run outcomes), `src/github/verdict-report.ts` + `verdict-report.test.ts` | Pipeline step 6 (structured Markdown, clipped excerpts) |
| 3 | Worker integration: repo config, persistence, installation events | `src/queue/differential-handler.ts` + test, `src/webhooks/handle-event.ts` + test, `src/config.ts` + `config.test.ts` (DATABASE_URL), `.env.example` | Pipeline steps 2 & 6, Core Data Model |
| 4 | Fastify API routes | `src/api/routes.ts`, `src/app.ts`, `src/app.test.ts` | API & Interface Contracts (runs/config endpoints) |
| 5 | Next.js dashboard (orchestrator pre-installs workspace deps) | `apps/web/next.config.mjs`, `postcss.config.mjs`, `tsconfig.json`, `apps/web/src/**` | Web Dashboard row |

Waves: 1 (db) ∥ 2 (report) → 3 ∥ 4 ∥ 5 → orchestrator wiring.

## Contracts (piece 0 creates `src/db/types.ts`; pieces import from it)

```ts
export interface RepositoryRow { id: string; installationId: string | null; repoFullName: string; language: 'python' | 'node' | null; testCommand: string | null; testFileGlobs: string[] | null; enabled: boolean; createdAt: Date; }
export interface VerificationRunRow { id: string; repositoryId: string; prNumber: number; baseSha: string; headSha: string; changedTestFiles: string[]; runAStatus: string; runBStatus: string; verdict: string; durationMs: number; runALog: string; runBLog: string; createdAt: Date; }
export interface RunHistorySummary { runs: VerificationRunRow[]; totalRuns: number; weakTestCount: number; catchRate: number | null; } // catchRate = weak-test / total, null when no runs
export interface InstallationRecord { githubInstallationId: number; accountLogin: string | null; }
export interface InstallationStore { upsertInstallation(record: InstallationRecord): Promise<void>; removeInstallation(githubInstallationId: number): Promise<void>; }
export interface RepositoryStore { ensureRepository(input: { repoFullName: string; installationId: number | null; language: 'python' | 'node' }): Promise<RepositoryRow>; getRepository(id: string): Promise<RepositoryRow | null>; listRepositories(): Promise<RepositoryRow[]>; updateRepositoryConfig(id: string, config: { testCommand?: string | null; testFileGlobs?: string[] | null; enabled?: boolean }): Promise<RepositoryRow | null>; }
export interface VerificationRunStore { insertRun(run: VerificationRunInsert): Promise<void>; listRuns(repositoryId: string, limit?: number): Promise<RunHistorySummary>; }
export interface VerificationRunInsert { repoFullName: string; installationId: number | null; language: 'python' | 'node'; prNumber: number; baseSha: string; headSha: string; changedTestFiles: string[]; runAStatus: string; runBStatus: string; verdict: string; durationMs: number; runALog: string; runBLog: string; }
export interface RepoConfig { testFileGlobs: string[] | null; testCommand: string | null; enabled: boolean; }
export interface RepoConfigStore { lookupConfig(repoFullName: string): Promise<RepoConfig | null>; } // null = not configured → defaults
```

Report contracts (piece 2 extends `src/runner/types.ts`): `VerdictReportInput` gains `prNumber: number`, `runA: SandboxRunOutcome`, `runB: SandboxRunOutcome`; the renderer `buildVerdictReport(verdict, a, b, ctx)` in `src/runner/report.ts` returns `{ title, summary }` (Markdown).

Piece 1: `createPgPool(databaseUrl)` (pg Pool + close), `runMigrations(pool)` (applies `migrations/*.sql` once, recorded in `schema_migrations`), and the three stores implementing the ports with parameterized SQL. Integration tests gated behind `DATABASE_URL` (CI runs a postgres service; locally skipped).

Piece 2: pure `report.ts` (Markdown: verdict statement, fired matrix row, `### Run A / Run B` sections with clipped `logExcerpt` in `<details>`), replacing `describeVerdict`; `src/github/verdict-report.ts` passes the richer fields through unchanged (title/summary verbatim).

Piece 3: the differential handler — repo config lookup before splitting (globs override; `test_command` override; `enabled=false` → warn + leave queued), run persistence after the verdict (including `logExcerpt`s as `run_a_log`/`run_b_log`), and the installation webhook handler persists `installation` events through an optional `InstallationStore`. Config gains optional `DATABASE_URL` (postgres:// or postgresql:// scheme).

Piece 4: `registerApiRoutes(app, deps)` — `GET /api/repos`, `GET /api/repos/:id/runs?limit=`, `PATCH /api/repos/:id/config` with zod-validated bodies, 404s for unknown ids, 503 when no stores are wired.

Piece 5: Next.js (App Router, client components) + Tailwind — `/` lists repositories; `/repos/[id]` shows the run history (verdict badges, catch rate, collapsible logs) and the config form (test command, globs, enabled) PATCHing the API. Proof: `npm run build -w apps/web`.

## Branches & commits (consolidated)

- `main`: Phase 4 plan; (at the end) the merged branch + push.
- `feature/phase-4-verdict-dashboard`, capability-level commits:
  1. `feat(db): PostgreSQL schema, migrations, and stores`
  2. `feat(report): rich verdict reports with clipped run logs`
  3. `feat(worker): repo-configured globs, run persistence, installation records`
  4. `feat(api): repo history and config endpoints`
  5. `feat(web): Next.js verification dashboard` (workspace + app)
  6. `feat(server): compose database, rich reports, and API` (+ README status)
- Merge `--no-ff`, push to origin. `AGENTS.md` stays local-only.

## Verification

- Scoped per-piece vitest/eslint by subagents; orchestrator reviews every diff and runs the full gate (`typecheck`, `test`, `lint`, `build`) plus the dashboard build and a boot smoke.
- Unverified locally (no Docker/Postgres, no live GitHub, no browser): PG round-trips (CI runs them with a service container), live check-run PATCH rendering, dashboard visual rendering (build-verified only).
