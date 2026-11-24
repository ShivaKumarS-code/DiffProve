/**
 * Shared contracts for Phase 2 (Diff Splitter).
 *
 * Everything cross-piece lives here so the pieces can be built and tested in
 * parallel against a stable contract: the parser produces `DiffFileSection`s,
 * the splitter consumes them, the GitHub clients implement `PrDiffClient` /
 * `CheckRunReporter`, and the worker handler composes all three.
 *
 * Scope (docs/architecture.md, "End-to-End Verification Pipeline", step 2):
 * fetch the unified PR diff, split it into the Test-Only Patch and the Full
 * PR Patch using test-file globs, and short-circuit PRs with no test changes
 * to a `neutral` check run. Sandbox execution of the two patches is Phase 3.
 */

/** File-level change classification, derived from the diff section headers. */
export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

/**
 * One file's complete section of a unified diff.
 *
 * The section is kept byte-exact (`raw`) so the Test-Only Patch can be
 * assembled by concatenation and still apply cleanly with `git apply`.
 */
export interface DiffFileSection {
  /**
   * Verbatim section bytes: starts at the `diff --git` line, ends right
   * before the next section (or end of input, keeping whatever trailing
   * bytes the input had).
   */
  raw: string;
  /**
   * The b-side path: the new location for added/renamed files, the removed
   * path for deleted files, and the file path otherwise.
   */
  path: string;
  /** The a-side path when it differs from `path` (renames); null otherwise. */
  oldPath: string | null;
  status: DiffFileStatus;
  /** True for `Binary files … differ` / `GIT binary patch` sections. */
  isBinary: boolean;
  /** Number of `@@` hunk headers in the section. */
  hunks: number;
  /** Hunk-body lines starting with `+` (headers `+++` are never counted). */
  additions: number;
  /** Hunk-body lines starting with `-` (headers `---` are never counted). */
  deletions: number;
}

/**
 * Default test-file globs (docs/architecture.md, pipeline step 2). A repo's
 * own globs override these in Phase 4 (`PATCH /api/repos/:id/config`); until
 * then callers may pass any glob list to `splitDiff`.
 */
export const DEFAULT_TEST_GLOBS: readonly string[] = [
  'test_*.py',
  '*_test.py',
  '*.test.ts',
  '*.spec.ts',
];

/** Result of splitting a PR diff for differential verification. */
export interface SplitResult {
  /** The full diff, verbatim (the "Full PR Patch"). */
  fullDiff: string;
  /**
   * The "Test-Only Patch": only the test-file sections, concatenated in
   * input order, byte-exact — never re-serialized.
   */
  testOnlyDiff: string;
  /** Every changed file, in diff order. */
  files: DiffFileSection[];
  /** b-side paths of changed test files, all statuses (deleted included). */
  changedTestFiles: string[];
  /**
   * Changed test files that exist at head and can be executed: added /
   * modified / renamed (new path). Deleted and binary test files are
   * excluded — Run A / Run B cannot execute them.
   */
  runnableTestFiles: string[];
  /**
   * True iff any changed file matches the test globs. The pure-refactor
   * short-circuit is `!hasTestChanges`: no tests to verify → report
   * `neutral` instead of running the differential pipeline.
   */
  hasTestChanges: boolean;
}

/** Request to fetch a PR's unified diff, pinned to the job's two commits. */
export interface PrDiffRequest {
  repoFullName: string;
  baseSha: string;
  headSha: string;
  installationId: number;
}

/**
 * Port: fetches the raw unified diff of `base...head` for a pull request.
 *
 * Implemented by `src/github/pulls.ts` against the GitHub compare endpoint
 * with the `.diff` media type (sha-pinned so later pushes to the PR cannot
 * change what a job verifies); faked in unit tests with canned diffs.
 */
export type PrDiffClient = (request: PrDiffRequest) => Promise<string>;

/** Check-run output title for the pure-refactor short-circuit (pipeline step 2). */
export const NO_TEST_CHANGES_TITLE = 'No test changes detected to verify';

/** Input for the no-test-changes short-circuit report on a PR head commit. */
export interface NoTestChangesReport {
  repoFullName: string;
  headSha: string;
  installationId: number;
  /** Check run output title, e.g. "No test changes detected to verify". */
  title: string;
  /** Check run output summary explaining the skip. */
  summary: string;
}

/**
 * Port: completes the DiffProve check run as `neutral` for a PR head commit.
 * Finds the queued run created in Phase 1 and PATCHes it to
 * `completed`/`neutral`; if none exists yet, POSTs a new completed/neutral
 * run. Implemented by `src/github/check-runs.ts`; faked in unit tests.
 */
export interface CheckRunReporter {
  reportNoTestChanges(report: NoTestChangesReport): Promise<void>;
}
