# Phase 2 Execution Plan — Diff Splitter

Scope source: `docs/architecture.md`, heading **"MVP Build Phases"**, Phase 2 line:

> **Phase 2 (Diff Splitter):** Build unified-diff parser that cleanly separates test-only hunks from implementation hunks and handles edge cases (deleted tests, pure-refactor PRs).

Also touches these parts of `docs/architecture.md`:
- Heading **"End-to-End Verification Pipeline"** — step 2 in full: "The worker pulls the unified PR diff via GitHub API and splits changed files into two patches using repo-configured test globs (`test_*.py`, `*_test.py`, `*.test.ts`, `*.spec.ts`)" → Test-Only Patch, Full PR Patch, and the *Short-Circuit*: "If no test files were added or modified, the Check Run completes immediately with a `neutral` status (*"No test changes detected to verify"*)."
- Heading **"API & Interface Contracts"** — the Check Run Output bullet (PATCH/POST check runs with structured `output.title`/`output.summary`).
- Heading **"Key Engineering Guardrails"** — #2 (never leak tokens/secrets; token-free error messages), #1 (v1 scope: pytest / vitest / jest test conventions drive the default globs).
- **NOT touched in Phase 2:** the `Core Data Model` tables (DB phase), sandbox execution and the verdict matrix (Phase 3), repo-config overrides via `PATCH /api/repos/:id/config` (Phase 4 — Phase 2 instead takes globs as a parameter with the architecture's four defaults), runner auto-detection from `pyproject.toml`/`package.json` (needed to *execute* tests → lands with Phase 3).

## Design decisions

- **Diff source is sha-pinned, not "current PR":** the job records `baseSha`/`headSha`, so the worker fetches `GET /repos/{owner}/{repo}/compare/{base}...{head}` with the `application/vnd.github.diff` media type. A PR that receives new pushes after enqueue must not change what a job verifies.
- **Byte-exact split:** the parser slices the diff into per-file *sections* (each starting at its `diff --git` line, kept verbatim). The Test-Only Patch is the in-order concatenation of the test-file sections — never re-serialized — so `git apply` in Phase 3 applies cleanly.
- **Classifications:** `added | modified | deleted | renamed` (from `new file mode` / `deleted file mode` / `rename from`+`rename to` headers); binary sections (`Binary files … differ`, `GIT binary patch`) are classified but never executable.
  - *Deleted tests* count as test changes (no silent skip) but are **not** runnable targets (Run A/B execute files that exist at head).
  - *Pure-refactor PRs* (zero test-file sections) trigger the short-circuit: the DiffProve check run is completed as `conclusion: neutral` with output "No test changes detected to verify" (find the queued run on `headSha` and PATCH it; POST a completed one if it is missing).
- **Globs:** `*` (no `/`), `**` (any), `?` (one char, no `/`), matched against the full path *or* the basename; defaults are the architecture's four patterns. Repo-configured globs arrive in Phase 4 via the existing parameter.
- **Failure = BullMQ retry:** the worker handler throws on fetch/report errors (attempts: 3, exponential backoff already configured in Phase 1), so transient GitHub/Redis failures self-heal; the job-id dedupe keeps retries idempotent.

## Pieces (one subagent per piece, disjoint files)

| # | Piece | Files owned | Architecture headings touched |
|---|-------|--------------|-------------------------------|
| 0 | Plan, shared Phase 2 contracts, server wiring, commits/merge | `PLAN.md`, `src/diff/types.ts`, `src/server.ts`, `README.md`, `src/queue/worker.ts` (placeholder removal) | glue |
| 1 | Unified-diff parser | `src/diff/parse.ts`, `src/diff/parse.test.ts` | Pipeline step 2 |
| 2 | Test-glob matcher + splitter | `src/diff/glob.ts`, `src/diff/split.ts`, `src/diff/glob.test.ts`, `src/diff/split.test.ts` | Pipeline step 2 (test globs), Guardrails #1 |
| 3 | GitHub clients: PR diff fetch + neutral check-run reporter | `src/github/pulls.ts`, `src/github/check-runs.ts`, `src/github/pulls.test.ts`, `src/github/check-runs.test.ts` | Pipeline steps 1-2, API & Interface Contracts (Check Run Output), Guardrails #2 |
| 4 | Worker pipeline handler (wave 2, after 1-3 land) | `src/queue/diff-handler.ts`, `src/queue/diff-handler.test.ts` | Pipeline step 2 + Short-Circuit, Job Orchestrator row |
| 5 | CI | `.github/workflows/ci.yml` (already covers the suite; no change expected) | — |

## Shared contracts (created by piece 0 as `src/diff/types.ts`; pieces import from here)

```ts
export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';
export interface DiffFileSection {
  raw: string;             // verbatim section bytes, starting at the `diff --git` line
  path: string;            // b-side path: new location for added/renamed, removed path for deleted
  oldPath: string | null;  // a-side path when it differs (renames)
  status: DiffFileStatus;
  isBinary: boolean;
  hunks: number; additions: number; deletions: number;
}
export const DEFAULT_TEST_GLOBS: readonly string[] = ['test_*.py', '*_test.py', '*.test.ts', '*.spec.ts'];
export interface SplitResult {
  fullDiff: string;        // verbatim input
  testOnlyDiff: string;    // test-file sections concatenated, byte-exact, in order
  files: DiffFileSection[];
  changedTestFiles: string[];   // all statuses, b-side paths
  runnableTestFiles: string[];   // exists at head and executable: excludes deleted + binary
  hasTestChanges: boolean;
}
export interface PrDiffRequest { repoFullName: string; baseSha: string; headSha: string; installationId: number; }
export type PrDiffClient = (request: PrDiffRequest) => Promise<string>;
export interface NoTestChangesReport { repoFullName: string; headSha: string; installationId: number; title: string; summary: string; }
export interface CheckRunReporter { reportNoTestChanges(report: NoTestChangesReport): Promise<void>; }
```

Piece 1: `parseUnifiedDiff(diff: string): DiffFileSection[]` — split on `^diff --git ` line starts; never throws; derive status from mode/rename headers; counts only inside hunk bodies; handle quoted paths, `--- a/…` / `+++ b/…` / `/dev/null`, `\ No newline at end of file`.

Piece 2: `matchesGlob(path, pattern)` + `isTestFile(path, globs = DEFAULT_TEST_GLOBS)`; `splitDiff(diff, globs = DEFAULT_TEST_GLOBS): SplitResult` built on piece 1.

Piece 3: `createPrDiffClient(octokit, authenticator): PrDiffClient` (compare endpoint, `.diff` media type, installation token per request, token-free errors); `createCheckRunReporter(octokit, authenticator): CheckRunReporter` (find by `ref=headSha` + `CHECK_RUN_NAME` → PATCH completed/neutral; else POST completed/neutral; structured `output.title`/`output.summary`).

Piece 4: `createDiffSplittingHandler(deps: { prDiff, checkRuns, logger }): VerificationJobHandler` — fetch → split → log summary → `!hasTestChanges` → `reportNoTestChanges(...)` → else log "deferred to Phase 3 sandbox runner" and leave the check run queued. Errors are logged then re-thrown so BullMQ retries.

Piece 0 wiring (orchestrator): `src/server.ts` hoists the shared octokit/authenticator, passes `createDiffSplittingHandler({ prDiff, checkRuns, logger: app.log })` to `startWorker`, and the Phase-1 `createLogOnlyHandler` placeholder is removed (`refactor(queue)` commit).

## Branches & commits

- `main`: Phase 2 plan; (at the end) the merged Phase 2 branch.
- `feature/phase-2-diff-splitter`: contracts → parser → glob/splitter → github clients → worker handler → server wiring → placeholder removal → README status. Merge to `main` with a `--no-ff` merge commit when the gate is green.
- `AGENTS.md` stays **local-only** (already in `.git/info/exclude`; never committed).

## Verification

- Each subagent proves its piece with `npx vitest run <its exact test files>` (scoped, parallel-friendly) and reports a status + real output.
- Orchestrator reviews every diff, runs the full gate itself: `npm run typecheck && npm test && npm run lint && npm run build`.
- Unverified locally (no GitHub credentials, no Docker/Redis on this machine): live GitHub diff fetch / check-run PATCH against a real installation; Redis round-trip (CI runs it with a service container). Unit tests use fake Octokit transports and canned diffs.
