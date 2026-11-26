# Fix Plan: E2B Sandbox Paths, Tool Bootstrapping, and Python `.venv` Relocation

## Context from Live Smoke Test (`ShivaKumarS-code/Evalora` PR #1)
Running PR #1 in production E2B hit `[invalid_argument] cwd '/run-a' does not exist` because:
1. Default E2B sandboxes run commands as non-root `user`, where `/` is read-only (`mkdir -p /workspace` and `cp -a /workspace /run-a` failed silently).
2. `e2b-runner.ts` ignored return results from extraction and `cp -a`, and `isFailedStep` treated `exitCode: null` (when `timedOut: false`) as success.
3. Default E2B sandboxes have `python3` (3.11.6), `pip`, `git`, `node`, `npm`, `npx`, and `yarn`, but do **not** preinstall `uv`, `poetry`, or `pnpm`.
4. Editable Python installs (`uv sync` / `pip install -e .`) write `.venv/lib/*/site-packages/*.pth` containing the absolute path of `WORKSPACE`, which after `cp -a WORKSPACE RUN_B` would make Run B import Run A/base `src/` instead of patched head `src/`.

## Architecture Mapping (`docs/architecture.md`)
All changes stay strictly inside **Phase 3 (E2B Differential Runner)** (`src/runner/`), preserving webhook intake, diff splitting, verdict matrix, egress lockdown before untrusted code execution, and dashboard API boundaries.

---

## Piece 1 — Install Command Bootstrapping (`commands`)
- **Files:** `src/runner/commands.ts`, `src/runner/commands.test.ts`
- **Architecture boundary:** Phase 3 sandbox provisioning (`End-to-End Verification Pipeline` step 3: `uv.lock`, `poetry.lock`, `pnpm-lock.yaml`).
- **Changes:**
  - Ensure `uv` is installed if missing before `uv sync`: `(command -v uv >/dev/null 2>&1 || pip install -q uv) && uv sync`.
  - Ensure `poetry` is installed if missing before `poetry install`: `(command -v poetry >/dev/null 2>&1 || pip install -q poetry) && POETRY_VIRTUALENVS_IN_PROJECT=true poetry install`.
  - Run `pnpm` via `npx --yes pnpm install --frozen-lockfile` so user-writable `~/.npm` works without root global install permissions.
  - Update `src/runner/commands.test.ts`.
- **Verification:** `npx vitest run src/runner/commands.test.ts`

## Piece 2 — Writable Sandbox Paths, Prep Failure Checks & `.venv` Relocation (`e2b-runner`)
- **Files:** `src/runner/e2b-runner.ts`, `src/runner/e2b-runner.test.ts`
- **Architecture boundary:** Phase 3 sandbox runner (`End-to-End Verification Pipeline` steps 3–5, Guardrail #2).
- **Changes:**
  - Move `WORKSPACE`, `RUN_A`, and `RUN_B` under user-writable `/tmp/diffprove`: `/tmp/diffprove/workspace`, `/tmp/diffprove/run-a`, `/tmp/diffprove/run-b` (keeping `STAGING = '/tmp/diffprove'`).
  - Fix `isFailedStep` to match its doc comment: `return result.timedOut || result.exitCode !== 0;` (so `exitCode: null` errors fail prep steps instead of continuing silently).
  - Check `isFailedStep` on workspace extraction (`EXTRACT` / `rm -rf ... && EXTRACT`) and `cp -a` cloning for Run A and Run B, returning `failedPrepPair(...)` on failure.
  - After cloning `WORKSPACE` -> `RUN_A` / `RUN_B` for `runnerKind === 'pytest'`, run a fast Python stdlib helper (no-op if `.venv` doesn't exist) rewriting occurrences of `${WORKSPACE}` to `${runDir}` in `.venv/lib/*/site-packages/*.pth` and text scripts under `.venv/bin/*` so Run B imports head `src/` and uses `RUN_B/.venv`.
  - Update `src/runner/e2b-runner.test.ts` and add regression tests for extraction/copy failure, `exitCode: null` prep failures, and pytest `.venv` relocation.
- **Verification:** `npx vitest run src/runner/e2b-runner.test.ts`
