/**
 * Shared domain types for the differential verification pipeline.
 *
 * These types are the contract between the webhook layer (which produces
 * jobs), the queue layer (which durably stores them), and the GitHub client
 * layer (which reports status back to the PR). Phase 2/3 workers consume the
 * same `VerificationJob` shape.
 */

import { createHash } from 'node:crypto';

/** GitHub repository in "owner/name" form. */
export type RepoFullName = string;

/**
 * Durable verification job enqueued when a PR is opened, synchronized, or reopened.
 */
export interface VerificationJob {
  repoFullName: RepoFullName;
  prNumber: number;
  /** GitHub App installation id; null when the event carried no installation context. */
  installationId: number | null;
  /** Pinned PR base-branch commit sha. */
  baseSha: string;
  /** Current head commit sha of the PR. */
  headSha: string;
  /** GitHub check ID persisted by the worker before running verification. */
  checkRunId?: number;
}

/** Stable across deliveries, attempts and worker processes, even for jobs with a legacy BullMQ ID. */
export function verificationKey(job: VerificationJob): string {
  const identity = JSON.stringify([
    job.repoFullName.toLowerCase(),
    job.prNumber,
    job.baseSha.toLowerCase(),
    job.headSha.toLowerCase(),
    job.installationId,
  ]);
  return `verify-v1-${createHash('sha256').update(identity).digest('hex')}`;
}

/** Minimal structured logger, satisfied by Fastify's built-in pino logger or test fakes. */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Result of durably enqueueing a verification job. */
export interface EnqueueResult {
  /** Stable, deduplicating job id (per installation, repo, PR, pinned base and head). */
  jobId: string;
}

/**
 * Port: durable queue front. Implemented by BullMQ in production
 * (src/queue/enqueuer.ts) and by fakes in tests.
 */
export interface Enqueuer {
  enqueue(job: VerificationJob): Promise<EnqueueResult>;
}

/** Worker-owned check lifecycle, separate from the handler's verdict reporting. */
export interface VerificationChecks {
  ensureQueuedCheckRun(job: VerificationJob): Promise<number>;
  reportExhaustedFailure(job: VerificationJob): Promise<void>;
}

/** Runs verification and reports its verdict using the worker's check ID. */
export type VerificationJobHandler = (job: VerificationJob) => Promise<void>;
