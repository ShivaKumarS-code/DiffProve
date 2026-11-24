# Phase 3 Execution Plan — E2B Differential Runner

Scope source: `docs/architecture.md`, heading **"MVP Build Phases"**, Phase 3 line:

> **Phase 3 (E2B Differential Runner):** Implement Firecracker sandbox execution for Run A and Run B with network egress disabled during test execution and lockfile-keyed snapshot caching.

Also touches these parts of `docs/architecture.md`:
- Heading **"End-to-End Verification Pipeline"** — step 3 (Sandbox Provisioning: E2B, cached snapshot keyed by lockfile hash, egress disabled before untrusted code), step 4 (Run A: base + Test-Only Patch, targeted tests, expect FAIL), step 5 (Run B: full patch, same command, expect PASS), and step 6's verdict matrix used as the *pipeline's internal classification* (basic conclusion + one-line summary; the *rich* Markdown reports are Phase 4).
- Heading **"Component Architecture & Stack"** — rows `Sandbox Runner` (E2B) and `Env Snapshot Cache` (E2B snapshots + Redis metadata).
- Heading **"Key Engineering Guardrails"** — #1 (v1 scope: pytest / vitest / jest, auto-detect from `pyproject.toml` / `package.json`), #2 (egress disabled after dependency install, **no GitHub tokens ever enter the sandbox**), #3 (new-feature ImportError classified distinctly), #4 (lockfile-hash snapshot caching for fast repeat runs).
- **NOT touched in Phase 3:** the `Core Data Model` tables and the rich Check Run Markdown reports + dashboard (Phase 4: "Map Run A/B exit codes to rich GitHub Check Run reports and build the Next.js history/config UI").

## Design decisions

- **Token-free provisioning:** the worker (trusted side) downloads the base tree as a tarball (`GET /repos/{owner}/{repo}/tarball/{ref}`) with the installation token and uploads it into the sandbox via the files API. The token never crosses the sandbox boundary; the sandbox never clones from GitHub.
- **Git-free patching:** the tarball is extracted to `/workspace`; each run copies the pristine tree (`cp -a`) and applies its patch with `git apply` (usable outside a repo). Run A = `/run-a` + Test-Only Patch; Run B = `/run-b` + Full PR Patch.
- **Egress lockdown:** installs run with egress open; then a single `sandbox.updateNetwork({ denyOut: ['0.0.0.0/0'] })` before the *test* commands — the flow the architecture mandates. Lockdown failure aborts the runs as environment failure.
- **Snapshot caching (real, keyed):** on a cache miss the runner installs base dependencies, then `sandbox.createSnapshot('diffprove-<lockfileKey>')` and records the ref in Redis (`diffprove:env-snapshots:<repo>~<key>`). On a hit the sandbox boots from the snapshot: Node deps (`node_modules`) are rescued from the snapshot tree, the pristine base is re-extracted (the snapshot's tree is stale per-PR), and deps are restored; Python deps live in global site-packages and survive the reset. Reinstall for Run B happens only when the head lockfile hash differs from base.
- **Raw results in, classified out:** the E2B runner returns *raw* results (exit code, stdout/stderr, timedOut, duration); classification and verdict mapping are pure functions in `src/runner/` so the whole differential policy is unit-tested without E2B.
- **Verdict reporting in Phase 3 is intentionally plain:** completed check run with the matrix conclusion (`success` / `failure` / `neutral`) + one-line title/summary. Phase 4 upgrades it to rich Markdown with clipped logs and annotations.

## Pieces (one subagent per piece, disjoint files)

| # | Piece | Files owned | Architecture headings touched |
|---|-------|--------------|-------------------------------|
| 0 | Plan, contracts, dependency install, server wiring, consolidated commits | `PLAN.md`, `src/runner/types.ts`, `src/server.ts`, `README.md` | glue |
| 1 | Pure runner core | `src/runner/detect.ts`, `src/runner/classify.ts`, `src/runner/commands.ts`, `src/runner/matrix.ts` + 4 test files | Pipeline step 4-6, Guardrails #1/#3 |
| 2 | E2B runner + snapshot cache | `src/runner/e2b-sandbox.ts` (thin SDK adapter), `src/runner/e2b-runner.ts`, `src/runner/snapshot-cache.ts` + tests | Pipeline step 3-5, Guardrails #2/#4 |
| 3 | GitHub clients: repo content, tarball, verdict reporter | `src/github/repo-content.ts`, `src/github/repo-tarball.ts`, `src/github/verdict-report.ts` (+ small refactor of `src/github/check-runs.ts` to share the find-check-run helper) + tests | Pipeline steps 3-6, API & Interface Contracts |
| 4 | Differential worker handler + config extension | `src/queue/differential-handler.ts` + test, `src/config.ts`, `src/config.test.ts`, `.env.example` | Pipeline steps 2-6, Job Orchestrator row |
| 5 | CI | `.github/workflows/ci.yml` (no change expected — suite grows automatically) | — |

Waves: 1 ∥ 2 (both depend only on the shared contracts in piece 0), then 3 ∥ 4, then orchestrator wiring.

## Shared contracts (piece 0 creates `src/runner/types.ts` before wave 1)

```ts
export type RunnerKind = 'pytest' | 'vitest' | 'jest';
export interface SandboxRawResult { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; durationMs: number }
export interface DifferentialRawResult { runA: SandboxRawResult; runB: SandboxRawResult }
export interface DifferentialRunRequest { repoFullName: string; baseSha: string; headSha: string; tarball: Uint8Array; testOnlyDiff: string; fullDiff: string; testCommand: string; installCommand: string | null; headInstallCommand: string | null; runnerKind: RunnerKind; lockfileKey: string }
export type DifferentialRunner = (request: DifferentialRunRequest) => Promise<DifferentialRawResult>;
export type RunStatus = 'pass' | 'fail' | 'import-error' | 'syntax-error' | 'timeout' | 'error';
export interface SandboxRunOutcome { status: RunStatus; exitCode: number | null; durationMs: number; logExcerpt: string }
export type Verdict = 'verified-fix' | 'weak-test' | 'broken-implementation' | 'new-symbol' | 'environment-failure';
export interface SandboxHandle { run(...): Promise<SandboxRawResult>; writeFile(...): Promise<void>; updateNetworkEgress(denyAll: boolean): Promise<void>; createSnapshot(name: string): Promise<string | null>; close(): Promise<void> }
export interface SandboxFactory { create(opts: { templateId?: string; apiKey?: string; timeoutMs?: number }): Promise<SandboxHandle> }
export interface EnvSnapshotCache { get(repoFullName: string, lockfileKey: string): Promise<string | null>; set(repoFullName: string, lockfileKey: string, templateRef: string): Promise<void> }
export interface RepoContentClient { fetchTextFile(input: { repoFullName: string; path: string; ref: string; installationId: number }): Promise<string | null>; listPaths(input: { repoFullName: string; ref: string; installationId: number }): Promise<string[]> }
export type RepoTarballClient = (input: { repoFullName: string; ref: string; installationId: number }) => Promise<Uint8Array>;
export interface VerdictReportInput { repoFullName: string; headSha: string; installationId: number; verdict: Verdict; conclusion: 'success' | 'failure' | 'neutral'; title: string; summary: string; durationMs: number }
export interface VerdictReporter { reportVerdict(report: VerdictReportInput): Promise<void> }
```

Piece 1: `detectRunner({ packageJson?, pyprojectToml? }): { kind: RunnerKind } | null` (vitest > jest from package.json deps/scripts, else pytest from pyproject, else null); `classifyRun(raw, kind): SandboxRunOutcome` (timeout > exit 0 pass > exit 127 or null error > import/syntax patterns > fail; 4000-char clipped excerpt); `buildInstallCommand(files, kind)`, `buildTestCommand(kind, files)`, `findLockfile(files)`; `verdictFrom(a, b): Verdict` (the architecture's matrix), `conclusionForVerdict`, `describeVerdict`.

Piece 2: `createE2bSandboxFactory()` — thin adapter over `@e2b/code-interpreter`'s `Sandbox` (the agent reads the shipped `.d.ts` for exact option names); `createE2bDifferentialRunner({ sandboxFactory, apiKey?, defaultTemplateId?, snapshotCache?, logger, installTimeoutMs?, testTimeoutMs? })` with the exact command sequence from the design decisions; `createRedisSnapshotCache(redisUrl)` (own ioredis client, `diffprove:env-snapshots:*` keys, integration test gated on `REDIS_URL`).

Piece 3: `createRepoContentClient` (contents API for text files — base64-decode, 404 → null; recursive git trees for path lists), `createRepoTarballClient` (tarball endpoint → `Uint8Array`), `createVerdictReporter` (find-or-create the DiffProve check run, PATCH to completed with conclusion + output). All installation-token per request, token-free errors, same style as Phase 1/2.

Piece 4: `createDifferentialHandler(deps)` — Phase 2's short-circuit retained (no test changes → neutral report); then: fetch manifests at base → detect runner (none → throw for BullMQ retry); list base/head paths; build install/test commands; compute lockfile keys (sha256 of lockfile content, 'none' if absent); fetch base tarball; run the differential; classify both runs; map the verdict; report it. `runner: null` (no `E2B_API_KEY`) → warn + leave queued. Config gains optional `E2B_API_KEY`, `E2B_TEMPLATE_ID`, `E2B_TEST_TIMEOUT_MS` (default 120000), `E2B_INSTALL_TIMEOUT_MS` (default 240000).

Piece 0 wiring (orchestrator): `src/server.ts` composes the E2B runner (only when `E2B_API_KEY` is set), the snapshot cache, the new GitHub clients, and swaps the worker handler to `createDifferentialHandler`. The Phase-2 `diff-handler.ts` is removed in the same consolidated commit (superseded by the differential handler, which contains its short-circuit).

## Branches & commits (consolidated per user instruction)

- `main`: Phase 3 plan; (at the end) the merged Phase 3 branch.
- `feature/phase-3-differential-runner`: a handful of *capability-level* commits, not per-file commits:
  1. `feat(runner): detection, run classification, and verdict matrix core` (contracts + piece 1)
  2. `feat(sandbox): E2B differential runner with egress lockdown and snapshot cache` (piece 2)
  3. `feat(worker): end-to-end differential pipeline with verdict reporting` (pieces 3+4, server wiring, superseded handler removal, README status)
- Merge to `main` with a `--no-ff` merge commit. Any small review fixes fold into the commit they belong to before committing.
- `AGENTS.md` stays **local-only** (`.git/info/exclude`; never committed).

## Verification

- Each subagent proves its piece with scoped `npx vitest run <files>`; the orchestrator reviews every diff and runs the full gate itself: `npm run typecheck && npm test && npm run lint && npm run build`.
- Unverified locally (no E2B account, no GitHub installation, no Docker/Redis on this machine): any live E2B sandbox interaction (boot, commands, snapshots, updateNetwork) — the adapter is thin and every behavior around it is fake-tested; live GitHub tarball/contents/trees; Redis round-trip (CI runs it with the service container).
