# Bug & Correctness Fix Plan

Scope source: `docs/architecture.md`, headings **"End-to-End Verification Pipeline"** (steps 2–6), **"Core Data Model"** (`verification_runs`), **"API & Interface Contracts"** (GitHub Check Run Output, `PATCH /api/repos/:id/config`), and **"Key Engineering Guardrails"** (#1, #2, #4).

## Goals

Fix the verified bugs and correctness gaps across the pipeline without crossing module boundaries:

1. **Shell-quoting & Python `.venv` handling:** Replace unsafe double-quoting of diff-derived paths with POSIX single-quoting, configure Poetry to keep `.venv` in-project (`POETRY_VIRTUALENVS_IN_PROJECT=true`), and support `{file}` / `{files}` substitution in custom `testCommand` overrides.
2. **E2B snapshot isolation & `.venv` preservation:** Create lockfile snapshots right after base dependency installation (before applying PR patches or executing untrusted code), rescue `/workspace/.venv` on `pytest` snapshot hits (and use `mv` instead of `cp -a` for `node_modules` / `.venv`), and prepend `$PWD/.venv/bin` to `PATH` when running `pytest`.
3. **Deleted/binary-only test PRs & custom `testCommand` resilience:** Short-circuit PRs with no runnable test files (`runnableTestFiles.length === 0` and no custom `testCommand`) to `neutral` instead of running the whole repository test suite; infer `RunnerKind` when a repo configures a custom `testCommand` without a detectable manifest runner.
4. **GitHub Check Run lookup reliability:** Filter `findDiffProveCheckRun` server-side with `check_name` and `per_page: 100` so DiffProve's queued run is found even when a commit has >30 check runs.
5. **Idempotent `verification_runs` persistence:** Deduplicate and enforce a unique index on `(repository_id, pr_number, base_sha, head_sha)` with an upsert in `insertRun` so BullMQ retries never create duplicate history rows.

## Pieces (disjoint files, one subagent per piece)

| # | Piece | Files owned | Architecture headings touched | Wave |
|---|-------|-------------|-------------------------------|------|
| 1 | Shell-safe quoting, Poetry in-project venv, custom command formatter | `src/runner/commands.ts`, `src/runner/commands.test.ts` | Pipeline steps 3–5, Guardrails #1 & #4 | 1 |
| 2 | E2B snapshot ordering, `.venv` rescue & `PATH`, `mv` cache carry-over | `src/runner/e2b-runner.ts`, `src/runner/e2b-runner.test.ts` | Pipeline steps 3–5, Guardrails #2 & #4 | 1 |
| 4 | Check-run lookup server-side filtering (`check_name`, `per_page: 100`) | `src/github/check-runs.ts`, `src/github/check-runs.test.ts` | API & Interface Contracts (Check Run Output) | 1 |
| 5 | `verification_runs` unique index migration + idempotent `insertRun` upsert | `src/db/migrations.ts`, `src/db/verification-runs.ts`, `src/db/db.test.ts` | Core Data Model (`verification_runs`), Pipeline step 6 | 1 |
| 3 | Worker deleted-test short-circuit, `{file}`/`{files}` substitution, custom-command runner fallback | `src/queue/differential-handler.ts`, `src/queue/differential-handler.test.ts` | Pipeline steps 2 & 4–6, Guardrail #1 | 2 |

Waves: `1 || 2 || 4 || 5` → `3` (Piece 3 consumes Piece 1's `formatCustomTestCommand` and single-quoted `buildTestCommand` contract).

## Cross-piece contracts

- `src/runner/commands.ts` exports:
  - `buildInstallCommand(files, kind)` — quotes `requirements.txt` path with single quotes; emits `POETRY_VIRTUALENVS_IN_PROJECT=true poetry install` for `poetry.lock`.
  - `buildTestCommand(kind, testFiles)` — POSIX single-quotes each path (`'...'`, escaping `'` as `'\''`).
  - `formatCustomTestCommand(template, testFiles)` — replaces `{files}` or `{file}` with space-joined POSIX single-quoted `testFiles`; returns `template` verbatim when neither placeholder is present.

## Verification

- Each subagent runs scoped `vitest` and `eslint` on its owned files (note: on Windows in this environment, `vitest run` may need unsandboxed execution if `vite` hits `EPERM` on `realpath` inside the sandbox).
- Orchestrator inspects every `git diff` and runs `npm run typecheck`, `npm test`, `npm run lint`, `npm run build`, and `npm run build:web`.
- Postgres/Redis integration tests remain gated behind `DATABASE_URL` / `REDIS_URL` unless services are running locally.
