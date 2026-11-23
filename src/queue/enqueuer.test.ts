import { describe, expect, it, vi } from 'vitest';

import type { Logger, VerificationJob, VerificationJobHandler } from '../domain.js';
import { createEnqueuer, jobIdFor, VERIFICATION_QUEUE_NAME } from './enqueuer.js';
import { startWorker } from './worker.js';

const sampleJob: VerificationJob = {
  repoFullName: 'octocat/hello-world',
  prNumber: 7,
  installationId: 42,
  baseSha: 'base000',
  headSha: 'abc123',
};

/** Polls until `predicate` is true or the timeout elapses (integration-only helper). */
async function waitFor(predicate: () => boolean, timeoutMs = 5000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`timed out after ${timeoutMs}ms waiting for the worker to deliver the job`);
}

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** Unique per run so a leftover job in a shared Redis cannot pre-dedupe this test. */
function uniqueHeadSha(): string {
  return `sha-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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
  it('builds the documented id for a nested repo name', () => {
    expect(jobIdFor(sampleJob)).toBe('verify~octocat~hello-world~7~abc123');
  });

  it('is deterministic for the same job', () => {
    const cloned: VerificationJob = { ...sampleJob };

    expect(jobIdFor(cloned)).toBe(jobIdFor(sampleJob));
    expect(jobIdFor(sampleJob)).toBe(jobIdFor(sampleJob));
  });

  it('differs per head sha', () => {
    const nextHead: VerificationJob = { ...sampleJob, headSha: 'def456' };

    expect(jobIdFor(nextHead)).not.toBe(jobIdFor(sampleJob));
  });

  it('produces a sane id when repoFullName has no slash', () => {
    const id = jobIdFor({ ...sampleJob, repoFullName: 'hello-world' });

    expect(id).toBe('verify~hello-world~7~abc123');
    expect(id.startsWith('verify~')).toBe(true);
    expect(id).not.toContain('/');
  });
});

// Redis is optional on dev machines: without REDIS_URL the integration suite is
// skipped and the process never opens a socket.
const redisUrl = process.env.REDIS_URL;

describe.skipIf(!redisUrl)('BullMQ verification queue (integration, needs REDIS_URL)', () => {
  it('delivers an enqueued job once and dedupes a re-enqueue of the same head', async () => {
    // The suite is skipped when REDIS_URL is unset; the assertion documents that.
    const url = redisUrl!;
    const job: VerificationJob = { ...sampleJob, headSha: uniqueHeadSha() };
    const handler = vi.fn<VerificationJobHandler>(async () => {});
    const enqueuer = createEnqueuer(url);
    const worker = startWorker(url, handler, { concurrency: 1, logger: fakeLogger() });

    try {
      const first = await enqueuer.enqueue(job);
      expect(first.jobId).toBe(jobIdFor(job));

      await waitFor(() => handler.mock.calls.length > 0);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(job);
      expect(handler.mock.calls[0]?.[0]).toEqual(job);

      // Same repo / PR / head sha: the deterministic jobId must swallow the
      // duplicate instead of running the verification a second time.
      const second = await enqueuer.enqueue(job);
      expect(second.jobId).toBe(first.jobId);

      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      await worker.close();
      await enqueuer.close();
    }
  });
});
