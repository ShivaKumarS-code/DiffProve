import { describe, expect, it, vi } from 'vitest';

import type { Logger, VerificationJob } from '../domain.js';
import { createLogOnlyHandler } from './worker.js';

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

describe('createLogOnlyHandler', () => {
  it('resolves and logs the repo, PR number, and head sha of the received job', async () => {
    const logger = fakeLogger();
    const handler = createLogOnlyHandler(logger);

    await expect(handler(sampleJob)).resolves.toBeUndefined();

    const info = vi.mocked(logger.info);
    expect(info).toHaveBeenCalledTimes(1);

    const message = info.mock.calls[0]?.[0] ?? '';
    expect(message).toContain(`repo=${sampleJob.repoFullName}`);
    expect(message).toContain(`pr=${sampleJob.prNumber}`);
    expect(message).toContain(sampleJob.headSha);
  });

  it('is a handler that needs no Redis and reports nothing as a failure', async () => {
    const logger = fakeLogger();
    const handler = createLogOnlyHandler(logger);

    await handler(sampleJob);

    expect(logger.info).toHaveBeenCalledOnce();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
