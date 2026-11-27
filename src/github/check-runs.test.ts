import type { Octokit } from '@octokit/core';
import { describe, expect, it, vi } from 'vitest';

import { createCheckRunReporter } from './check-runs.js';

const REPORT = {
  repoFullName: 'octocat/hello-world',
  headSha: 'head456',
  installationId: 42,
  title: 'Differential verification is disabled',
  summary: 'Verification is disabled for this repository.',
};
const GET = 'GET /repos/{owner}/{repo}/check-runs/{check_run_id}';
const PATCH = 'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}';

function setup() {
  const request = vi.fn();
  const installation = vi.fn().mockResolvedValue({ token: 'ghs_x' });
  const reporter = createCheckRunReporter({ request } as unknown as Octokit, { installation });
  return { reporter, request, installation };
}

describe('createCheckRunReporter', () => {
  it('completes the worker check as neutral with the supplied skip message', async () => {
    const { reporter, request, installation } = setup();
    request.mockResolvedValueOnce({ data: { status: 'queued' } });

    await reporter.reportNoTestChanges({ ...REPORT, checkRunId: 77 });

    expect(installation).toHaveBeenCalledExactlyOnceWith(42);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, GET, {
      owner: 'octocat',
      repo: 'hello-world',
      check_run_id: 77,
      headers: { authorization: 'token ghs_x' },
    });
    expect(request).toHaveBeenNthCalledWith(2, PATCH, {
      owner: 'octocat',
      repo: 'hello-world',
      check_run_id: 77,
      status: 'completed',
      conclusion: 'neutral',
      output: { title: REPORT.title, summary: REPORT.summary },
      headers: { authorization: 'token ghs_x' },
    });
  });

  it('does not PATCH again when a skip is retried after its first write', async () => {
    const { reporter, request } = setup();
    request
      .mockResolvedValueOnce({ data: { status: 'queued' } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ data: { status: 'completed', conclusion: 'neutral' } });

    await reporter.reportNoTestChanges({ ...REPORT, checkRunId: 77 });
    await reporter.reportNoTestChanges({ ...REPORT, checkRunId: 77, title: 'Changed setup' });

    expect(request.mock.calls.map(([route]) => route)).toEqual([GET, PATCH, GET]);
  });

  it('never looks up by name or creates a replacement check when the ID is missing', async () => {
    const { reporter, request, installation } = setup();

    await expect(reporter.reportNoTestChanges(REPORT)).rejects.toThrow('without the worker check run ID');

    expect(installation).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('sanitizes errors from obtaining an installation token', async () => {
    const { reporter, request, installation } = setup();
    installation.mockRejectedValueOnce(Object.assign(new Error('private details'), { status: 403 }));

    const failure = reporter.reportNoTestChanges({ ...REPORT, checkRunId: 77 });
    await expect(failure).rejects.toThrow('failed to complete DiffProve check run as neutral for octocat/hello-world at head456 with HTTP 403');
    await expect(failure).rejects.not.toHaveProperty('cause');
    expect(request).not.toHaveBeenCalled();
  });
});
