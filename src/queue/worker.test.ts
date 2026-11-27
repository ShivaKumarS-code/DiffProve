import { type JobsOptions, UnrecoverableError } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VerificationChecks, VerificationJob, VerificationJobHandler } from '../domain.js';
import { handleWebhookEvent } from '../webhooks/handle-event.js';
import { createEnqueuer, jobIdFor, VERIFY_JOB_NAME } from './enqueuer.js';
import { createVerificationProcessor, FINALIZE_JOB_NAME, finalizationJobId, startWorker } from './worker.js';

type QueueData = VerificationJob | { verificationJobId: string };
type QueueJob = {
  name: string;
  id: string;
  attemptsMade: number;
  opts: { attempts: number };
  getState: () => Promise<string>;
  data: QueueData;
  updateData: (data: QueueData) => Promise<void>;
};

const queue = vi.hoisted(() => ({
  add: vi.fn<(name: string, data: QueueData, opts: JobsOptions & { jobId: string }) => Promise<{ id: string }>>(),
  getJob: vi.fn<(id: string) => Promise<QueueJob | undefined>>(),
  process: undefined as ((job: QueueJob) => Promise<void>) | undefined,
  emitFailure: undefined as ((job: QueueJob, error: Error) => void) | undefined,
  pause: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  quit: vi.fn(async () => {}),
}));

vi.mock('bullmq', async (importOriginal) => {
  const { EventEmitter } = await import('node:events');
  const actual = await importOriginal<typeof import('bullmq')>();
  return {
    ...actual,
    Queue: class {
      add = queue.add;
      getJob = queue.getJob;
      close = async () => {};
    },
    Worker: class extends EventEmitter {
      constructor(_name: string, processor: (job: QueueJob) => Promise<void>) {
        super();
        queue.process = processor;
        queue.emitFailure = (job, error) => this.emit('failed', job, error, 'active');
      }
      run = async () => {};
      pause = queue.pause;
      close = queue.close;
    },
  };
});

vi.mock('ioredis', () => ({ Redis: class { quit = queue.quit; } }));

const LEGACY_JOB = {
  repoFullName: 'octocat/hello-world',
  prNumber: 7,
  installationId: 42,
  baseSha: 'base000',
  headSha: 'abc123',
} satisfies VerificationJob;
const TRACKED_JOB = { ...LEGACY_JOB, checkRunId: 77 };
const RETRYABLE_ERROR = new Error('private details');
const URL = 'redis://localhost:6379';

function latch() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { release, wait };
}

function setup() {
  const ensureQueuedCheckRun = vi.fn<VerificationChecks['ensureQueuedCheckRun']>(async () => 77);
  const reportExhaustedFailure = vi.fn<VerificationChecks['reportExhaustedFailure']>(async () => {});
  return {
    checks: { ensureQueuedCheckRun, reportExhaustedFailure },
    handler: vi.fn<VerificationJobHandler>(async () => {}),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

function createJob(overrides: Partial<QueueJob> = {}): QueueJob {
  return {
    name: VERIFY_JOB_NAME,
    id: 'job-1',
    attemptsMade: 0,
    opts: { attempts: 3 },
    data: LEGACY_JOB,
    updateData: async () => {},
    getState: async () => 'failed',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  queue.getJob.mockReset();
  queue.add.mockImplementation(async (_name, _data, { jobId }) => ({ id: jobId }));
});

describe('verification processor', () => {
  it('can start immediately but never runs the handler before the check ID is durable', async () => {
    const { checks, handler } = setup();
    const store = latch();
    const updateData = vi.fn<(data: VerificationJob) => Promise<void>>(async () => store.wait);
    const process = createVerificationProcessor(handler, checks);

    const active = process({ data: LEGACY_JOB, updateData });
    await vi.waitFor(() => expect(updateData).toHaveBeenCalledExactlyOnceWith(TRACKED_JOB));
    expect(handler).not.toHaveBeenCalled();
    store.release();
    await active;

    expect(checks.ensureQueuedCheckRun).toHaveBeenCalledExactlyOnceWith(LEGACY_JOB);
    expect(handler).toHaveBeenCalledExactlyOnceWith(TRACKED_JOB);
  });

  it('recovers the external check after persistence failure and reuses the durable ID on handler retry', async () => {
    const { checks, handler } = setup();
    let storedJob: VerificationJob = LEGACY_JOB;
    const updateData = vi.fn(async (data: VerificationJob) => { storedJob = data; })
      .mockRejectedValueOnce(new Error('failed to persist check ID'));
    handler.mockRejectedValueOnce(new Error('pipeline unavailable'));
    const process = createVerificationProcessor(handler, checks);

    await expect(process({ data: storedJob, updateData })).rejects.toThrow('failed to persist check ID');
    expect(handler).not.toHaveBeenCalled();
    await expect(process({ data: storedJob, updateData })).rejects.toThrow('pipeline unavailable');
    await process({ data: storedJob, updateData });

    expect(checks.ensureQueuedCheckRun.mock.calls).toEqual([[LEGACY_JOB], [LEGACY_JOB]]);
    expect(updateData.mock.calls).toEqual([[TRACKED_JOB], [TRACKED_JOB]]);
    expect(handler.mock.calls).toEqual([[TRACKED_JOB], [TRACKED_JOB]]);
  });
});

describe('worker wiring', () => {
  it('acknowledges without waiting for the immediate worker and dedupes concurrent deliveries and redelivery', async () => {
    const { checks, handler, logger } = setup();
    const check = latch();
    checks.ensureQueuedCheckRun.mockImplementationOnce(async () => {
      await check.wait;
      return 77;
    });
    const enqueuer = createEnqueuer(URL);
    const worker = startWorker(URL, handler, { checks, logger });
    const stored = new Map<string, VerificationJob>();
    let claimed: Promise<void> | undefined;
    // Model BullMQ's atomic add-if-absent: the persisted payload and claim
    // are not replaced on duplicate adds, including after the ID is stored.
    queue.add.mockImplementation(async (_name, data, { jobId }) => {
      if ('verificationJobId' in data) throw new Error('unexpected finalization enqueue');
      if (!stored.has(jobId)) {
        stored.set(jobId, data);
        claimed = queue.process!(createJob({
          id: jobId,
          data,
          async updateData(next) {
            if ('verificationJobId' in next) throw new Error('unexpected finalization data');
            stored.set(jobId, next);
          },
        }));
      }
      return { id: jobId };
    });

    try {
      const deliver = () => handleWebhookEvent(
        { kind: 'pull_request', action: 'opened', ...LEGACY_JOB },
        { enqueuer, logger, installations: null },
      );
      const [first, second] = await Promise.all([deliver(), deliver()]);
      expect(first).toEqual({ statusCode: 202, message: `queued verification job ${jobIdFor(LEGACY_JOB)}` });
      expect(second).toEqual(first);
      expect(handler).not.toHaveBeenCalled();
      check.release();
      await claimed;
      expect(await deliver()).toEqual(first);
      expect(stored.get(jobIdFor(LEGACY_JOB))).toEqual(TRACKED_JOB);
      expect(checks.ensureQueuedCheckRun).toHaveBeenCalledExactlyOnceWith(LEGACY_JOB);
      expect(handler).toHaveBeenCalledExactlyOnceWith(TRACKED_JOB);
    } finally {
      check.release();
      await claimed;
      await worker.close();
      await enqueuer.close();
    }
  });

  it('persists an independent retry job before the last attempt fails and dedupes backup scheduling', async () => {
    const { checks, handler, logger } = setup();
    handler.mockRejectedValue(RETRYABLE_ERROR);
    const stored = new Set<string>();
    const store = latch();
    queue.add.mockImplementation(async (_name, _data, { jobId }) => {
      await store.wait;
      stored.add(jobId);
      return { id: jobId };
    });
    const worker = startWorker(URL, handler, { checks, logger });
    const job = createJob({ data: TRACKED_JOB });

    try {
      await expect(queue.process!(job)).rejects.toBe(RETRYABLE_ERROR);
      expect(queue.add).not.toHaveBeenCalled();
      let returned = false;
      const lastAttempt = queue.process!({ ...job, attemptsMade: 2 }).catch((error: unknown) => {
        returned = true;
        return error;
      });
      const finalId = finalizationJobId(job.id);
      await vi.waitFor(() => expect(queue.add).toHaveBeenCalledExactlyOnceWith(
        FINALIZE_JOB_NAME,
        { verificationJobId: job.id },
        expect.objectContaining({ jobId: finalId, attempts: 8, backoff: { type: 'exponential', delay: 5_000 } }),
      ));
      expect(returned).toBe(false);
      expect(checks.reportExhaustedFailure).not.toHaveBeenCalled();
      store.release();
      expect(await lastAttempt).toBe(RETRYABLE_ERROR);
      expect(stored.has(finalId)).toBe(true);

      queue.emitFailure!({ ...job, attemptsMade: 3 }, RETRYABLE_ERROR);
      await worker.close();
      expect(queue.add).toHaveBeenCalledTimes(2);
      expect(queue.add.mock.calls[1]).toEqual(queue.add.mock.calls[0]);
      expect(stored.size).toBe(1);
    } finally {
      store.release();
      await worker.close();
    }
  });

  it('queues finalization for a stalled job and drains the backup enqueue on close', async () => {
    const { checks, handler, logger } = setup();
    const store = latch();
    queue.add.mockImplementationOnce(async (_name, _data, { jobId }) => {
      await store.wait;
      return { id: jobId };
    });
    const worker = startWorker(URL, handler, { checks, logger });
    const job = createJob({ id: 'job-2', attemptsMade: 1 });
    queue.emitFailure!(job, new UnrecoverableError('job stalled too many times'));

    try {
      const closed = worker.close();
      await vi.waitFor(() => expect(queue.add).toHaveBeenCalledExactlyOnceWith(
        FINALIZE_JOB_NAME,
        { verificationJobId: job.id },
        expect.objectContaining({ jobId: finalizationJobId(job.id) }),
      ));
      expect(queue.close).not.toHaveBeenCalled();
      expect(queue.quit).not.toHaveBeenCalled();
      expect(checks.reportExhaustedFailure).not.toHaveBeenCalled();
      store.release();
      await closed;
      expect(queue.close).toHaveBeenCalledTimes(1);
      expect(queue.quit).toHaveBeenCalledTimes(1);
    } finally {
      store.release();
      await worker.close();
    }
  });

  it('defers while the source is active, retries temporary errors, and never reschedules finalization', async () => {
    const { checks, handler, logger } = setup();
    checks.reportExhaustedFailure.mockRejectedValueOnce(RETRYABLE_ERROR);
    const getState = vi.fn()
      .mockResolvedValueOnce('active')
      .mockResolvedValueOnce('completed')
      .mockResolvedValue('failed');
    queue.getJob.mockResolvedValue(createJob({ getState, data: TRACKED_JOB }));
    const worker = startWorker(URL, handler, { checks, logger });
    const job = createJob({
      id: finalizationJobId('job-1'),
      name: FINALIZE_JOB_NAME,
      opts: { attempts: 8 },
      data: { verificationJobId: 'job-1' },
    });

    try {
      await expect(queue.process!(job)).rejects.toThrow('not yet in a terminal state');
      await queue.process!(job);
      expect(checks.reportExhaustedFailure).not.toHaveBeenCalled();
      await expect(queue.process!(job)).rejects.toBe(RETRYABLE_ERROR);
      await queue.process!(job);

      queue.emitFailure!({ ...job, attemptsMade: 1 }, RETRYABLE_ERROR);
      queue.emitFailure!({ ...job, attemptsMade: 8 }, RETRYABLE_ERROR);
      await worker.close();

      expect(checks.reportExhaustedFailure.mock.calls).toEqual([[TRACKED_JOB], [TRACKED_JOB]]);
      expect(handler).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
      expect(logger.error.mock.calls).toEqual([
        ['verification check finalization attempt failed: id=finalize-job-1'],
        ['verification check finalization exhausted: id=finalize-job-1'],
      ]);
    } finally {
      await worker.close();
    }
  });
});
