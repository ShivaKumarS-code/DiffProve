/**
 * Shared contracts for Phase 3 (E2B Differential Runner).
 *
 * Everything cross-piece lives here so the pieces can be built and tested in
 * parallel against a stable contract:
 *  - `src/runner/detect.ts`, `classify.ts`, `commands.ts`, `matrix.ts` hold the
 *    pure differential policy (detection, classification, verdict matrix).
 *  - `src/runner/e2b-runner.ts` implements `DifferentialRunner` and returns
 *    only RAW results; classification happens in the pure core, so the
 *    policy is fully unit-testable without any sandbox.
 *  - `src/github/repo-content.ts`, `repo-tarball.ts`, `verdict-report.ts`
 *    implement the GitHub-side ports.
 *  - `src/queue/differential-handler.ts` composes everything per job.
 *
 * Scope (docs/architecture.md, "End-to-End Verification Pipeline" steps 3-5):
 * boot an ephemeral E2B sandbox from a lockfile-keyed snapshot, provision the
 * base tree without ever putting a GitHub token inside the sandbox, disable
 * outbound egress after dependency installation, and execute Run A (base +
 * Test-Only Patch) and Run B (base + Full PR Patch) with the same targeted
 * test command.
 */

/** Supported test runners (architecture guardrail #1: v1 scope). */
export type RunnerKind = 'pytest' | 'vitest' | 'jest';

/**
 * Raw outcome of ONE sandbox command, as observed by the runner.
 * Classification into a `RunStatus` happens in the pure core.
 */
export interface SandboxRawResult {
  /** Process exit code; null when the command never completed or its result is unknown. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/** Raw outcome pair for the two differential runs. */
export interface DifferentialRawResult {
  runA: SandboxRawResult;
  runB: SandboxRawResult;
}

/** Everything the sandbox runner needs to execute Run A and Run B. */
export interface DifferentialRunRequest {
  repoFullName: string;
  baseSha: string;
  headSha: string;
  /** GitHub tarball of the base tree (fetched by the trusted worker; no token ever enters the sandbox). */
  tarball: Uint8Array;
  /** Test-Only Patch (applied for Run A). */
  testOnlyDiff: string;
  /** Full PR Patch (applied for Run B). */
  fullDiff: string;
  /** Targeted test command, e.g. `pytest "tests/test_a.py"`. */
  testCommand: string;
  /** Dependency install command for the BASE lockfile; null = skip install. */
  installCommand: string | null;
  /**
   * Dependency install command for Run B's HEAD state. Null when the head
   * lockfile hash equals the base hash (Run B reuses the installed deps).
   */
  headInstallCommand: string | null;
  runnerKind: RunnerKind;
  /** Lockfile hash key ('none' when no lockfile) used for snapshot caching. */
  lockfileKey: string;
}

/**
 * Port: executes the two differential runs. Throws only for infrastructure
 * failures that should be retried (e.g. sandbox creation); command-level
 * failures are returned as raw results.
 */
export type DifferentialRunner = (request: DifferentialRunRequest) => Promise<DifferentialRawResult>;

/** Classified status of one run (architecture verdict matrix vocabulary). */
export type RunStatus =
  | 'pass'
  | 'fail'
  | 'import-error'
  | 'syntax-error'
  | 'timeout'
  | 'error';

/** Classified outcome of one run, ready for verdict mapping and reporting. */
export interface SandboxRunOutcome {
  status: RunStatus;
  exitCode: number | null;
  durationMs: number;
  /** Clipped combined stdout/stderr excerpt (Phase 4 renders it richly). */
  logExcerpt: string;
}

/**
 * Verdict per the architecture's Run A / Run B matrix:
 *   FAIL+PASS → verified-fix; PASS+PASS → weak-test; FAIL+FAIL →
 *   broken-implementation; (SYNTAX|IMPORT)+PASS → new-symbol;
 *   anything with ERROR/TIMEOUT → environment-failure.
 */
export type Verdict =
  | 'verified-fix'
  | 'weak-test'
  | 'broken-implementation'
  | 'new-symbol'
  | 'environment-failure';

/**
 * Injection seam for the E2B adapter (`src/runner/e2b-sandbox.ts`): unit
 * tests provide a fake factory so the runner's command sequence is testable
 * without any cloud.
 */
export interface SandboxHandle {
  /**
   * Runs one command. NEVER throws: unknown failures are returned as a raw
   * result with `exitCode: null`; timeouts set `timedOut`.
   */
  run(command: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<SandboxRawResult>;
  /** Writes a text or binary file into the sandbox, creating directories as needed. */
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  /**
   * Locks down (or restores) outbound network egress for the running
   * sandbox. Throws when the platform rejects the change.
   */
  updateNetworkEgress(denyAll: boolean): Promise<void>;
  /**
   * Creates a snapshot of the running sandbox; resolves to the snapshot's
   * reusable reference (id/template), or null when snapshotting is
   * unavailable — never throws.
   */
  createSnapshot(name: string): Promise<string | null>;
  close(): Promise<void>;
}

/** Creates sandboxes; the E2B adapter is the only real implementation. */
export interface SandboxFactory {
  create(opts: { templateId?: string; apiKey?: string; timeoutMs?: number }): Promise<SandboxHandle>;
}

/**
 * Port: lockfile-keyed environment snapshot metadata (Redis in production,
 * `src/runner/snapshot-cache.ts`; fakes in tests). Values are reusable
 * snapshot/template references for `SandboxFactory.create`.
 */
export interface EnvSnapshotCache {
  get(repoFullName: string, lockfileKey: string): Promise<string | null>;
  set(repoFullName: string, lockfileKey: string, templateRef: string): Promise<void>;
}

/** Input for reading one text file (manifest/lockfile) from a repo at a ref. */
export interface RepoFileInput {
  repoFullName: string;
  path: string;
  ref: string;
  installationId: number;
}

/** Input for listing all file paths of a repo at a ref. */
export interface RepoTreeInput {
  repoFullName: string;
  ref: string;
  installationId: number;
}

/**
 * Port: trusted-side repo content access for runner detection and lockfile
 * hashing. `fetchTextFile` resolves null when the file does not exist (404).
 */
export interface RepoContentClient {
  fetchTextFile(input: RepoFileInput): Promise<string | null>;
  listPaths(input: RepoTreeInput): Promise<string[]>;
}

/** Port: downloads a GitHub tarball of the repo tree at a ref. */
export type RepoTarballClient = (input: {
  repoFullName: string;
  ref: string;
  installationId: number;
}) => Promise<Uint8Array>;

/** Everything the basic (Phase 3) check-run completion needs. */
export interface VerdictReportInput {
  repoFullName: string;
  headSha: string;
  installationId: number;
  verdict: Verdict;
  /** GitHub check run conclusion: success | failure | neutral (matrix column 4). */
  conclusion: 'success' | 'failure' | 'neutral';
  title: string;
  summary: string;
  durationMs: number;
}

/** Port: completes the DiffProve check run with the differential verdict. */
export interface VerdictReporter {
  reportVerdict(report: VerdictReportInput): Promise<void>;
}
