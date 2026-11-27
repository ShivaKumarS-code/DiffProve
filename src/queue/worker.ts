/** BullMQ worker bootstrap and per-attempt verification. */
import { type Job, Queue, UnrecoverableError, Worker } from 'bullmq';
import { Redis } from 'ioredis';

import type { Logger, VerificationChecks, VerificationJob, VerificationJobHandler } from '../domain.js';
import { VERIFICATION_QUEUE_NAME, VERIFY_JOB_NAME } from './enqueuer.js';

export const FINALIZE_JOB_NAME = 'finalize-exhausted-verification';
type FinalizationJobData = { verificationJobId: string };
type QueueData = VerificationJob | FinalizationJobData;
type QueueName = typeof VERIFY_JOB_NAME | typeof FINALIZE_JOB_NAME;
type QueueJob = Job<QueueData, void, QueueName>;

export function finalizationJobId(verificationJobId: string): string {
  return `finalize-${verificationJobId}`;
}

function isLastAttempt(attempt: number, totalAttempts: number | undefined, error: unknown): boolean {
  return attempt >= (totalAttempts ?? 1) || (
    error instanceof Error && error.name === UnrecoverableError.name
  );
}

/** The worker must store the check ID before handler side effects can begin. */
export function createVerificationProcessor(
  handler: VerificationJobHandler,
  checks: VerificationChecks,
): (job: Pick<Job<VerificationJob>, 'data' | 'updateData'>) => Promise<void> {
  return async (job) => {
    let data = job.data;
    if (data.installationId !== null && data.checkRunId === undefined) {
      const checkRunId = await checks.ensureQueuedCheckRun(data);
      data = { ...data, checkRunId };
      await job.updateData(data);
    }
    await handler(data);
  };
}

interface WorkerOpts {
  checks: VerificationChecks;
  concurrency?: number;
  logger?: Logger;
  prefix?: string;
}

export function startWorker(
  redisUrl: string,
  handler: VerificationJobHandler,
  { checks, concurrency = 5, logger, prefix }: WorkerOpts,
): { close(): Promise<void> } {
  // BullMQ requires `maxRetriesPerRequest: null` for its blocking connection.
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queueOptions = { connection, ...(prefix === undefined ? {} : { prefix }) };
  const queue = new Queue<QueueData, void, QueueName>(VERIFICATION_QUEUE_NAME, queueOptions);
  const processVerification = createVerificationProcessor(handler, checks);

  async function enqueueFinalization(verificationJobId: string): Promise<void> {
    await queue.add(FINALIZE_JOB_NAME, { verificationJobId }, {
      jobId: finalizationJobId(verificationJobId),
      // The intent is written before BullMQ finishes the last verification
      // attempt. Give that transition a head start; the processor still checks.
      delay: 1_000,
      attempts: 8,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 7 * 24 * 60 * 60 },
      removeOnFail: { age: 7 * 24 * 60 * 60 },
    });
  }

  async function processFinalization(verificationJobId: string): Promise<void> {
    const original = await queue.getJob(verificationJobId);
    if (original === undefined || original.name !== VERIFY_JOB_NAME || 'verificationJobId' in original.data) {
      throw new UnrecoverableError('verification job unavailable for finalization');
    }
    const state = await original.getState();
    if (state === 'completed') {
      // The original worker may have lost its lock before moving to failed. If
      // a later delivery succeeded, this pre-scheduled intent is obsolete.
      return;
    }
    if (state !== 'failed') {
      throw new Error('verification job is not yet in a terminal state');
    }
    // Re-read the source from Redis to use the authoritative ID, if any. The
    // Checks adapter recovers by external_id when it was never persisted.
    await checks.reportExhaustedFailure(original.data);
  }

  const worker = new Worker<QueueData, void, QueueName>(
    VERIFICATION_QUEUE_NAME,
    async (job) => {
      if (job.name === FINALIZE_JOB_NAME && 'verificationJobId' in job.data) {
        return processFinalization(job.data.verificationJobId);
      }
      if (job.name !== VERIFY_JOB_NAME || 'verificationJobId' in job.data) {
        throw new UnrecoverableError('unknown verification queue job');
      }

      try {
        await processVerification({ data: job.data, updateData: (data) => job.updateData(data) });
      } catch (error) {
        const id = job.id;
        if (
          id !== undefined &&
          job.data.installationId !== null &&
          isLastAttempt(job.attemptsMade + 1, job.opts.attempts, error)
        ) {
          try {
            await enqueueFinalization(id);
          } catch {
            // Preserve the verification error and let the failed event retry
            // the enqueue. Do not run GitHub writes on either failure path.
            logger?.error(`failed to schedule verification check finalization: id=${id}`);
          }
        }
        throw error;
      }
    },
    { ...queueOptions, concurrency, autorun: false },
  );
  const scheduling = new Set<Promise<void>>();

  function onFailure(job: QueueJob | undefined, error: Error): void {
    if (job?.name === FINALIZE_JOB_NAME) {
      const last = isLastAttempt(job.attemptsMade, job.opts.attempts, error);
      logger?.error(`verification check finalization ${last ? 'exhausted' : 'attempt failed'}: id=${job.id ?? 'unknown'}`);
      // Finalization has its own finite retry budget; never enqueue from here.
      return;
    }
    logger?.error(`verification job attempt failed: id=${job?.id ?? 'unknown'}`);
    if (
      job === undefined ||
      job.id === undefined ||
      job.name !== VERIFY_JOB_NAME ||
      'verificationJobId' in job.data ||
      job.data.installationId === null ||
      !isLastAttempt(job.attemptsMade, job.opts.attempts, error)
    ) {
      return;
    }
    const id = job.id;

    const schedule = (async () => {
      try {
        if (await job.getState() === 'failed') {
          // Backup for exhausted stalls (which bypass the processor) and a
          // failed pre-enqueue. Duplicate adds retain the existing retry job.
          await enqueueFinalization(id);
        }
      } catch {
        // Without Redis or a surviving worker, the fallback has no outbox of
        // its own. A missed stall/backup enqueue needs operator reconciliation.
        logger?.error(`failed to schedule exhausted verification check: id=${id}`);
      }
    })();
    scheduling.add(schedule);
    void schedule.then(() => scheduling.delete(schedule));
  }

  worker.on('failed', onFailure);
  worker.on('error', () => logger?.error('verification worker encountered a queue error'));
  void worker.run().catch(() => logger?.error('verification worker stopped unexpectedly'));

  let closing: Promise<void> | undefined;
  return {
    close(): Promise<void> {
      closing ??= (async () => {
        try {
          // Stop new claims and allow the current failure events to arrive,
          // then drain their scheduling work while Redis is still connected.
          // Pending finalization jobs persist for the next worker.
          await worker.pause();
          worker.off('failed', onFailure);
          await Promise.all(scheduling);
        } finally {
          try {
            await worker.close();
          } finally {
            try {
              await queue.close();
            } finally {
              // BullMQ treats our ioredis instance as shared.
              await connection.quit();
            }
          }
        }
      })();
      return closing;
    },
  };
}
