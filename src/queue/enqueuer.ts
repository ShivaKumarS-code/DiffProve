/**
 * Durable verification queue front (Phase 1).
 *
 * The architecture's "Job Orchestrator" component owns durable queuing,
 * per-repo concurrency caps, and retry policies (BullMQ + Redis). Phase 1 only
 * needs the durable enqueue half: the webhook layer calls `Enqueuer.enqueue`
 * after it posts the `queued` check run, and `src/queue/worker.ts` hands the
 * job to a pluggable handler. The real differential pipeline (Run A / Run B)
 * lands in Phases 2-3.
 *
 * Constructing a `Queue` does not open a Redis socket until the first command,
 * so this module imports cleanly — and its unit tests run — on machines with no
 * Redis. Only the integration test (gated on `REDIS_URL`) ever awaits
 * `enqueue`.
 */

import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import type { EnqueueResult, Enqueuer, VerificationJob } from '../domain.js';

// BullMQ v6 rejects queue names containing ':' (it throws synchronously at
// Queue construction, before any Redis connection), so the queue name uses a
// dash-separated form.
export const VERIFICATION_QUEUE_NAME = 'diffprove-verification';

/** Deterministic, deduplicating job id: 'verify~<owner>~<repo>~<pr>~<headSha>'. */
export function jobIdFor(job: VerificationJob): string {
  // Every '/' is flattened to '~' so "octocat/hello-world" contributes a single
  // id segment; a repoFullName without a slash still yields a usable id.
  const repo = job.repoFullName.replaceAll('/', '~');

  return `verify~${repo}~${job.prNumber}~${job.headSha}`;
}

/**
 * Creates the Redis-backed enqueuer.
 *
 * The returned `close()` releases the queue and then quits the base Redis client
 * this factory created. BullMQ treats a caller-provided ioredis instance as
 * shared, so it does not disconnect it on `close()`; without the explicit
 * `quit()` the socket would keep the process alive. Callers (server shutdown,
 * tests) are responsible for invoking `close()` exactly once.
 */
export function createEnqueuer(redisUrl: string): Enqueuer & { close(): Promise<void> } {
  // BullMQ requires `maxRetriesPerRequest: null` so blocking commands never
  // give up mid-flight (its own workers duplicate this option for polling).
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue(VERIFICATION_QUEUE_NAME, { connection });

  return {
    async enqueue(job: VerificationJob): Promise<EnqueueResult> {
      // Re-adding a job that already exists with the same jobId is a no-op that
      // returns the existing job — this is what makes GitHub webhook retries
      // safe: a redelivered `pull_request` event cannot run the same PR head
      // twice.
      const added = await queue.add('verify', job, {
        jobId: jobIdFor(job),
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        // Keep finished jobs long enough to keep deduplicating retried webhook
        // deliveries, and failed jobs long enough for triage.
        removeOnComplete: { age: 24 * 60 * 60 },
        removeOnFail: { age: 7 * 24 * 60 * 60 },
      });

      return { jobId: added.id ?? jobIdFor(job) };
    },

    async close(): Promise<void> {
      await queue.close();
      // BullMQ closed the queue and everything it derived from `connection`, but
      // a caller-provided ioredis client stays owned by us.
      await connection.quit();
    },
  };
}
