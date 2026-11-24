/**
 * Shared database contracts for Phase 4 (Verdict Reporting & Dashboard).
 *
 * Everything cross-piece lives here so the pieces can be built and tested in
 * parallel against a stable contract: the DB stores implement these ports,
 * the worker pipeline and webhook handler consume them through fakes, and the
 * Fastify API routes read through them.
 *
 * Scope (docs/architecture.md, "Core Data Model" → "PostgreSQL Tables" and
 * "Component Architecture & Stack" → "Run History DB"): installations, repo
 * test configs, and verification verdicts with log excerpts.
 *
 * `DATABASE_URL` is optional: every port consumer treats a null store as
 * "persistence not configured" and degrades gracefully (Phase 3 behavior).
 */

/** A repository row (`repositories` table). */
export interface RepositoryRow {
  /** uuid primary key. */
  id: string;
  /** uuid FK to `installations`; null for repos seen only via jobs. */
  installationId: string | null;
  repoFullName: string;
  /** Detected ecosystem, stored for the dashboard. */
  language: 'python' | 'node' | null;
  /** Repo-configured override for the targeted test command (null = auto-detect). */
  testCommand: string | null;
  /** Repo-configured override for the test-file globs (null = defaults). */
  testFileGlobs: string[] | null;
  enabled: boolean;
  createdAt: Date;
}

/** A completed verification run row (`verification_runs` table). */
export interface VerificationRunRow {
  id: string;
  repositoryId: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  changedTestFiles: string[];
  /** `RunStatus` of Run A (pass | fail | import-error | syntax-error | timeout | error). */
  runAStatus: string;
  /** `RunStatus` of Run B. */
  runBStatus: string;
  /** `Verdict` (verified-fix | weak-test | broken-implementation | new-symbol | environment-failure). */
  verdict: string;
  durationMs: number;
  /** Clipped log excerpt from Run A (stored for the dashboard and reports). */
  runALog: string;
  /** Clipped log excerpt from Run B. */
  runBLog: string;
  createdAt: Date;
}

/**
 * Run history plus the weak-test catch rate for a repository.
 *
 * catchRate = weak-test runs / total runs, rounded to 4 decimals; null when
 * there are no runs yet. "Weak-test catch rate" is the dashboard's headline
 * metric for how often DiffProve flags non-reproducing tests.
 */
export interface RunHistorySummary {
  runs: VerificationRunRow[];
  totalRuns: number;
  weakTestCount: number;
  catchRate: number | null;
}

/** An installation record (`installations` table), written from webhook events. */
export interface InstallationRecord {
  githubInstallationId: number;
  accountLogin: string | null;
}

/** Port: installation lifecycle persistence (webhook events). */
export interface InstallationStore {
  upsertInstallation(record: InstallationRecord): Promise<void>;
  removeInstallation(githubInstallationId: number): Promise<void>;
}

/** Port: repository rows (onboarding, config overrides, dashboard lists). */
export interface RepositoryStore {
  /**
   * Ensures a repository row exists for `repoFullName` (insert when missing;
   * when present, update the installation linkage and language). Returns the row.
   */
  ensureRepository(input: {
    repoFullName: string;
    installationId: number | null;
    language: 'python' | 'node';
  }): Promise<RepositoryRow>;
  getRepository(id: string): Promise<RepositoryRow | null>;
  listRepositories(): Promise<RepositoryRow[]>;
  /**
   * Applies a config override (PATCH semantics: only provided fields change;
   * explicit null clears an override). Returns the updated row, or null when
   * the id does not exist.
   */
  updateRepositoryConfig(
    id: string,
    config: { testCommand?: string | null; testFileGlobs?: string[] | null; enabled?: boolean },
  ): Promise<RepositoryRow | null>;
}

/** Input for recording one completed verification run. */
export interface VerificationRunInsert {
  repoFullName: string;
  installationId: number | null;
  /** Stored on the ensured repository row. */
  language: 'python' | 'node';
  prNumber: number;
  baseSha: string;
  headSha: string;
  changedTestFiles: string[];
  runAStatus: string;
  runBStatus: string;
  verdict: string;
  durationMs: number;
  runALog: string;
  runBLog: string;
}

/** Port: verification run persistence and history queries. */
export interface VerificationRunStore {
  /** Ensures the repository row exists, then inserts the run. */
  insertRun(run: VerificationRunInsert): Promise<void>;
  /** Latest runs for one repository (default limit 50) plus the catch rate. */
  listRuns(repositoryId: string, limit?: number): Promise<RunHistorySummary>;
}

/**
 * Port: the worker's pre-run lookup of repo config overrides
 * (architecture pipeline step 2: "repo-configured test globs"). Null resolves
 * to defaults; `enabled: false` leaves a job queued.
 */
export interface RepoConfig {
  testFileGlobs: string[] | null;
  testCommand: string | null;
  enabled: boolean;
}

export interface RepoConfigStore {
  lookupConfig(repoFullName: string): Promise<RepoConfig | null>;
}
