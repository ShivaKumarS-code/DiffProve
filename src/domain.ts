/**
 * Shared domain types for the differential verification pipeline.
 *
 * These types are the contract between the webhook layer (which produces
 * jobs), the queue layer (which durably stores them), and the GitHub client
 * layer (which reports status back to the PR). Phase 2/3 workers consume the
 * same `VerificationJob` shape.
 */

/** GitHub repository in "owner/name" form. */
export type RepoFullName = string;

/**
 * Durable verification job enqueued when a PR with test changes is opened,
 * synchronized, or reopened.
 */
export interface VerificationJob {
  repoFullName: RepoFullName;
  prNumber: number;
  /** GitHub App installation id; null when the event carried no installation context. */
  installationId: number | null;
  /** Commit sha the PR is based on. */
  baseSha: string;
  /** Current head commit sha of the PR. */
  headSha: string;
}

/** Input for creating a GitHub check run on a PR head commit. */
export interface CheckRunInput {
  repoFullName: RepoFullName;
  headSha: string;
  installationId: number | null;
}

export type CheckRunStatus = 'queued' | 'in_progress' | 'completed';

/** Minimal structured logger, satisfied by Fastify's built-in pino logger or test fakes. */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Result of durably enqueueing a verification job. */
export interface EnqueueResult {
  /** Stable, deduplicating job id (per repo, PR, and head sha). */
  jobId: string;
}

/**
 * Port: durable queue front. Implemented by BullMQ in production
 * (src/queue/enqueuer.ts) and by fakes in tests.
 */
export interface Enqueuer {
  enqueue(job: VerificationJob): Promise<EnqueueResult>;
}

/**
 * Port: posts a `queued` check run on the PR head commit. Implemented by the
 * Octokit-backed client (src/github/checks.ts) and by fakes in tests.
 */
export interface CheckRunPoster {
  postQueuedCheckRun(input: CheckRunInput): Promise<void>;
}

/**
 * Phase 1 placeholder handler: the real Run A / Run B pipeline (Phases 2-3)
 * will implement this once the diff splitter and sandbox runner land.
 */
export type VerificationJobHandler = (job: VerificationJob) => Promise<void>;
