import type { Octokit } from '@octokit/core';
import { describe, expect, it, vi } from 'vitest';

import type { VerdictReportInput } from '../runner/types.js';
import { createVerdictReporter } from './verdict-report.js';

const REPORT: VerdictReportInput = {
  repoFullName: 'octocat/hello-world',
  headSha: 'head456',
  installationId: 42,
  prNumber: 7,
  verdict: 'verified-fix',
  conclusion: 'success',
  title: 'Differential verification passed',
  summary: '**Verified fix** — Run A failed on base as expected and Run B passes on head.',
  runA: { status: 'fail', exitCode: 1, durationMs: 400, logExcerpt: 'AssertionError: 3 != 4' },
  runB: { status: 'pass', exitCode: 0, durationMs: 800, logExcerpt: '1 passed in 0.42s' },
  durationMs: 1234,
};
const GET = 'GET /repos/{owner}/{repo}/check-runs/{check_run_id}';
const PATCH = 'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}';

function setup() {
  const request = vi.fn();
  const installation = vi.fn().mockResolvedValue({ token: 'ghs_x' });
  const reporter = createVerdictReporter({ request } as unknown as Octokit, { installation });
  return { reporter, request, installation };
}

describe('createVerdictReporter', () => {
  it('completes the worker check with the rendered verdict', async () => {
    const { reporter, request, installation } = setup();
    request.mockResolvedValueOnce({ data: { status: 'queued' } });

    await reporter.reportVerdict({ ...REPORT, checkRunId: 77 });

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
      conclusion: 'success',
      output: { title: REPORT.title, summary: REPORT.summary },
      headers: { authorization: 'token ghs_x' },
    });
  });

  it('does not make an ambiguous write when no worker check ID was supplied', async () => {
    const { reporter, request, installation } = setup();

    await expect(reporter.reportVerdict(REPORT)).rejects.toThrow('without the worker check run ID');

    expect(installation).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('sanitizes failed PATCH requests and does not fall back to a second write', async () => {
    const { reporter, request } = setup();
    request
      .mockResolvedValueOnce({ data: { status: 'queued' } })
      .mockRejectedValueOnce(Object.assign(new Error('token ghs_x'), { status: 503 }));

    const failure = reporter.reportVerdict({ ...REPORT, checkRunId: 77 });
    await expect(failure).rejects.toThrow('failed to report verified-fix verdict for octocat/hello-world at head456 with HTTP 503');
    await expect(failure).rejects.not.toHaveProperty('cause');
    expect(request.mock.calls.map(([route]) => route)).toEqual([GET, PATCH]);
  });

  it('preserves the original verdict if an ambiguous PATCH succeeded and the retry reaches a different result', async () => {
    const { reporter, request } = setup();
    request
      .mockResolvedValueOnce({ data: { status: 'queued' } })
      .mockRejectedValueOnce(new Error('lost PATCH response'))
      .mockResolvedValueOnce({ data: { status: 'completed', conclusion: 'success' } });

    await expect(reporter.reportVerdict({ ...REPORT, checkRunId: 77 })).rejects.toThrow('failed to report');
    await reporter.reportVerdict({ ...REPORT, checkRunId: 77, verdict: 'weak-test', conclusion: 'failure' });

    expect(request.mock.calls.map(([route]) => route)).toEqual([GET, PATCH, GET]);
  });
});
