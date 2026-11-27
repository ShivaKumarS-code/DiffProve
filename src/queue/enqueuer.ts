/**
 * Durable verification queue front. Webhooks acknowledge after enqueueing;
 * only the worker performs GitHub check operations.
 */

import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import { type EnqueueResult, type Enqueuer, type VerificationJob, verificationKey } from '../domain.js';

// BullMQ v6 rejects queue names containing ':' (it throws synchronously at
// Queue construction, before any Redis connection), so the queue name uses a
// dash-separated form.
export const VERIFICATION_QUEUE_NAME = 'diffprove-verification';
export const VERIFY_JOB_NAME = 'verify';

/** Use the same pinned verification identity for the job and the GitHub check. */
export function jobIdFor(job: VerificationJob): string {
  return verificationKey(job);
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
export function createEnqueuer(redisUrl: string, prefix?: string): Enqueuer & { close(): Promise<void> } {
  // BullMQ requires `maxRetriesPerRequest: null` so blocking commands never
  // give up mid-flight (its own workers duplicate this option for polling).
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue(VERIFICATION_QUEUE_NAME, {
    connection,
    ...(prefix === undefined ? {} : { prefix }),
  });

  return {
    async enqueue(job: VerificationJob): Promise<EnqueueResult> {
      // Re-adding a job that already exists with the same jobId is a no-op that
      // preserves stored data (including checkRunId) and dedupes concurrent
      // deliveries of the same pinned base/head while the job is retained.
      const added = await queue.add(VERIFY_JOB_NAME, job, {
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
