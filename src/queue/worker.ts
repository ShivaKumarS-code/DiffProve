/**
 * Verification worker bootstrap (Phase 1).
 *
 * The worker is deliberately thin: it owns the BullMQ lifecycle and hands each
 * dequeued `VerificationJob` to a pluggable `VerificationJobHandler`. Phase 1
 * ships only `createLogOnlyHandler`; Phases 2-3 plug in the Run A / Run B
 * differential pipeline without touching the queuing code.
 *
 * As with the enqueuer, importing this module opens no Redis connection —
 * `startWorker` is what constructs the client.
 */

import { Worker } from 'bullmq';
import { Redis } from 'ioredis';

import type { Logger, VerificationJob, VerificationJobHandler } from '../domain.js';
import { VERIFICATION_QUEUE_NAME } from './enqueuer.js';

/** Phase-1 placeholder handler: logs the job and resolves. The real differential pipeline lands in Phases 2-3. */
export function createLogOnlyHandler(logger: Logger): VerificationJobHandler {
  return async (job: VerificationJob): Promise<void> => {
    logger.info(
      `verification job received: repo=${job.repoFullName} pr=${job.prNumber} head=${job.headSha} (Phase 1 log-only handler)`,
    );
  };
}

/**
 * Starts consuming `diffprove:verification` and invokes `handler` per job.
 *
 * The returned `close()` drains and closes the worker (and the Redis
 * connections BullMQ derives from the supplied client), then quits the base
 * Redis client we created. BullMQ treats a caller-provided ioredis instance as
 * shared, so it does not disconnect it on `close()`; without the explicit
 * `quit()` the socket would keep the process alive.
 */
export function startWorker(
  redisUrl: string,
  handler: VerificationJobHandler,
  opts?: { concurrency?: number; logger?: Logger },
): { close(): Promise<void> } {
  // BullMQ requires `maxRetriesPerRequest: null` for the blocking connection it
  // duplicates from this client.
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });

  const worker = new Worker(
    VERIFICATION_QUEUE_NAME,
    async (job) => {
      await handler(job.data as VerificationJob);
    },
    { connection, concurrency: opts?.concurrency ?? 5 },
  );

  worker.on('failed', (job, error) => {
    // Log only the message string: String(error) / whole error objects can
    // carry request payloads and other unredacted internals into logs.
    opts?.logger?.error(`verification job failed: id=${job?.id ?? 'unknown'} error=${error.message}`);
  });

  return {
    async close(): Promise<void> {
      await worker.close();
      // BullMQ closed the worker and its blocking duplicates, but a
      // caller-provided ioredis client stays owned by us.
      await connection.quit();
    },
  };
}
