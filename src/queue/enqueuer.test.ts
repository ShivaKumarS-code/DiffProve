import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';

import type { Logger, VerificationChecks, VerificationJob, VerificationJobHandler } from '../domain.js';
import { createEnqueuer, jobIdFor, VERIFICATION_QUEUE_NAME, VERIFY_JOB_NAME } from './enqueuer.js';
import { FINALIZE_JOB_NAME, finalizationJobId, startWorker } from './worker.js';

const sampleJob: VerificationJob = {
  repoFullName: 'octocat/hello-world',
  prNumber: 7,
  installationId: 42,
  baseSha: 'base000',
  headSha: 'abc123',
};

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** Give each worker its own queue even when tests share a Redis database. */
function uniquePrefix(): string {
  return `diffprove-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

describe('VERIFICATION_QUEUE_NAME', () => {
  it('is safe for BullMQ v6, which rejects queue names containing ":"', () => {
    // Regression guard: 'diffprove:verification' threw synchronously at Queue
    // construction ("Queue name cannot contain :") and crashed server startup.
    expect(VERIFICATION_QUEUE_NAME).toBe('diffprove-verification');
    expect(VERIFICATION_QUEUE_NAME).not.toContain(':');
  });
});

describe('jobIdFor', () => {
  it('builds a GitHub- and BullMQ-safe ID', () => {
    expect(jobIdFor(sampleJob)).toMatch(/^verify-v1-[a-f\d]{64}$/);
  });

  it('is deterministic for the same job', () => {
    const cloned: VerificationJob = { ...sampleJob, checkRunId: 77 };

    expect(jobIdFor(cloned)).toBe(jobIdFor(sampleJob));
    expect(jobIdFor({ ...sampleJob, repoFullName: 'Octocat/Hello-World' })).toBe(jobIdFor(sampleJob));
  });

  it('includes repository, PR, pinned base and head, and installation in the identity', () => {
    for (const change of [
      { repoFullName: 'octocat/other-repo' },
      { prNumber: 8 },
      { baseSha: 'base111' },
      { headSha: 'def456' },
      { installationId: 43 },
    ]) {
      expect(jobIdFor({ ...sampleJob, ...change })).not.toBe(jobIdFor(sampleJob));
    }
  });
});

// Redis is optional on dev machines: without REDIS_URL the integration suite is
// skipped and the process never opens a socket.
const redisUrl = process.env.REDIS_URL;

describe.skipIf(!redisUrl)('BullMQ verification queue (integration, needs REDIS_URL)', () => {
  it('delivers an enqueued job once despite concurrent deliveries and redelivery', async () => {
    // The suite is skipped when REDIS_URL is unset; the assertion documents that.
    const url = redisUrl!;
    const prefix = uniquePrefix();
    const job = sampleJob;
    const handler = vi.fn<VerificationJobHandler>(async () => {});
    const enqueuer = createEnqueuer(url, prefix);
    const ensureQueuedCheckRun = vi.fn(async () => 77);
    const worker = startWorker(url, handler, {
      concurrency: 2,
      prefix,
      checks: { ensureQueuedCheckRun, reportExhaustedFailure: vi.fn() },
      logger: fakeLogger(),
    });

    try {
      const [first, duplicate] = await Promise.all([enqueuer.enqueue(job), enqueuer.enqueue(job)]);
      expect(first.jobId).toBe(jobIdFor(job));
      expect(duplicate.jobId).toBe(first.jobId);

      await vi.waitFor(() => expect(handler).toHaveBeenCalled(), { timeout: 12_000 });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ ...job, checkRunId: 77 });
      expect(ensureQueuedCheckRun).toHaveBeenCalledExactlyOnceWith(job);

      // Same pinned identity: the deterministic jobId must swallow the
      // duplicate instead of running the verification a second time.
      const second = await enqueuer.enqueue(job);
      expect(second.jobId).toBe(first.jobId);

      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(handler).toHaveBeenCalledTimes(1);
      expect(ensureQueuedCheckRun).toHaveBeenCalledTimes(1);
    } finally {
      await worker.close();
      await enqueuer.close();
    }
  }, 20_000);

  it('keeps an exhausted check finalization retry in Redis across worker restarts', async () => {
    const url = redisUrl!;
    const prefix = uniquePrefix();
    const job = sampleJob;
    const id = jobIdFor(job);
    const finalId = finalizationJobId(id);
    const connection = new Redis(url, { maxRetriesPerRequest: 1 });
    const queue = new Queue(VERIFICATION_QUEUE_NAME, { connection, prefix });
    const handler = vi.fn<VerificationJobHandler>().mockRejectedValue(new Error('verification failed'));
    const ensureQueuedCheckRun = vi.fn<VerificationChecks['ensureQueuedCheckRun']>().mockResolvedValue(77);
    const firstDelivery = vi.fn<VerificationChecks['reportExhaustedFailure']>()
      .mockRejectedValue(new Error('temporary GitHub failure'));
    const initial = startWorker(url, handler, {
      concurrency: 1,
      prefix,
      checks: { ensureQueuedCheckRun, reportExhaustedFailure: firstDelivery },
      logger: fakeLogger(),
    });
    let restarted: ReturnType<typeof startWorker> | undefined;

    try {
      await queue.add(VERIFY_JOB_NAME, job, {
        jobId: id,
        attempts: 2,
        backoff: { type: 'fixed', delay: 25 },
        removeOnFail: { age: 7 * 24 * 60 * 60 },
      });
      await vi.waitFor(async () => {
        const original = await queue.getJob(id);
        const pending = await queue.getJob(finalId);
        expect(original).toMatchObject({ attemptsMade: 2, data: { ...job, checkRunId: 77 } });
        expect(await original?.getState()).toBe('failed');
        expect(pending).toMatchObject({ name: FINALIZE_JOB_NAME, attemptsMade: 1 });
        expect(await pending?.getState()).toBe('delayed');
      }, { timeout: 12_000 });
      await initial.close();
      expect(handler).toHaveBeenCalledTimes(2);
      expect(firstDelivery).toHaveBeenCalledExactlyOnceWith({ ...job, checkRunId: 77 });

      const unexpectedVerification = vi.fn<VerificationJobHandler>();
      const reportExhaustedFailure = vi.fn<VerificationChecks['reportExhaustedFailure']>(async () => {});
      restarted = startWorker(url, unexpectedVerification, {
        concurrency: 1,
        prefix,
        checks: { ensureQueuedCheckRun, reportExhaustedFailure },
        logger: fakeLogger(),
      });
      await vi.waitFor(async () => {
        const completed = await queue.getJob(finalId);
        expect(completed).toMatchObject({ attemptsMade: 2 });
        expect(await completed?.getState()).toBe('completed');
      }, { timeout: 12_000 });

      expect(reportExhaustedFailure).toHaveBeenCalledExactlyOnceWith({ ...job, checkRunId: 77 });
      expect(unexpectedVerification).not.toHaveBeenCalled();
      expect(ensureQueuedCheckRun).toHaveBeenCalledExactlyOnceWith(job);
    } finally {
      await initial.close();
      await restarted?.close();
      await queue.close();
      await connection.quit();
    }
  }, 30_000);
});
