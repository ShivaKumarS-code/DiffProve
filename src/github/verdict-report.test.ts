import type { Octokit } from '@octokit/core';
import { describe, expect, it, vi } from 'vitest';

import type { VerdictReportInput } from '../runner/types.js';
import { CHECK_RUN_NAME } from './checks.js';
import { createVerdictReporter } from './verdict-report.js';

const REPORT: VerdictReportInput = {
  repoFullName: 'octocat/hello-world',
  headSha: 'head456',
  installationId: 42,
  verdict: 'verified-fix',
  conclusion: 'success',
  title: 'Differential verification passed',
  summary: 'Run A failed as expected; Run B passed. Verdict: verified-fix.',
  durationMs: 1234,
};

const LIST_ROUTE = 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs';
const PATCH_ROUTE = 'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}';
const CREATE_ROUTE = 'POST /repos/{owner}/{repo}/check-runs';

/** Builds the reporter with a fake transport and a fake token source. */
function buildReporter(): {
  reporter: ReturnType<typeof createVerdictReporter>;
  request: ReturnType<typeof vi.fn>;
  installation: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn();
  const installation = vi.fn().mockResolvedValue({ token: 'ghs_x' });
  const octokit = { request } as unknown as Octokit;
  const reporter = createVerdictReporter(octokit, { installation });

  return { reporter, request, installation };
}

/** Reads one recorded `octokit.request` call as `[route, parameters]`. */
function callAt(
  request: ReturnType<typeof vi.fn>,
  index: number,
): [string, Record<string, unknown>] {
  return request.mock.calls[index] as [string, Record<string, unknown>];
}

/** Builds an Octokit `RequestError`-shaped rejection carrying an HTTP status. */
function requestError(status: number, message: string): Error {
  return Object.assign(new Error(message), {
    status,
    response: { status, headers: {}, data: { message } },
  });
}

/** Captures the message of the error a call rejects with. */
async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return (error as Error).message;
  }

  throw new Error('expected the call to reject');
}

describe('createVerdictReporter', () => {
  it('completes the existing DiffProve check run with the verdict', async () => {
    const { reporter, request, installation } = buildReporter();
    request
      .mockResolvedValueOnce({
        status: 200,
        data: {
          total_count: 2,
          check_runs: [
            { id: 1, name: 'Other CI' },
            { id: 77, name: CHECK_RUN_NAME },
          ],
        },
      })
      .mockResolvedValueOnce({ status: 200, data: {} });

    await expect(reporter.reportVerdict(REPORT)).resolves.toBeUndefined();

    expect(installation).toHaveBeenCalledTimes(1);
    expect(installation).toHaveBeenCalledWith(42);
    expect(request).toHaveBeenCalledTimes(2);

    const [listRoute, listParameters] = callAt(request, 0);
    expect(listRoute).toBe(LIST_ROUTE);
    expect(listParameters).toMatchObject({
      owner: 'octocat',
      repo: 'hello-world',
      ref: 'head456',
      headers: { authorization: 'token ghs_x' },
    });

    const [patchRoute, patchParameters] = callAt(request, 1);
    expect(patchRoute).toBe(PATCH_ROUTE);
    expect(patchParameters).toMatchObject({
      owner: 'octocat',
      repo: 'hello-world',
      check_run_id: 77,
      status: 'completed',
      conclusion: 'success',
      headers: { authorization: 'token ghs_x' },
    });
    // Report fields flow through untouched ("API & Interface Contracts").
    expect(patchParameters.output).toEqual({
      title: 'Differential verification passed',
      summary: 'Run A failed as expected; Run B passed. Verdict: verified-fix.',
    });
  });

  it('POSTs a completed run when the head commit has no DiffProve check run', async () => {
    const { reporter, request, installation } = buildReporter();
    request
      .mockResolvedValueOnce({
        status: 200,
        data: { total_count: 1, check_runs: [{ id: 1, name: 'Other CI' }] },
      })
      .mockResolvedValueOnce({ status: 201, data: {} });

    await expect(reporter.reportVerdict(REPORT)).resolves.toBeUndefined();

    expect(installation).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);

    const routes = request.mock.calls.map((call) => (call as [string])[0]);
    expect(routes).toEqual([LIST_ROUTE, CREATE_ROUTE]);
    expect(routes).not.toContain(PATCH_ROUTE);

    const [createRoute, createParameters] = callAt(request, 1);
    expect(createRoute).toBe(CREATE_ROUTE);
    expect(createParameters).toMatchObject({
      owner: 'octocat',
      repo: 'hello-world',
      name: CHECK_RUN_NAME,
      head_sha: 'head456',
      status: 'completed',
      conclusion: 'success',
      headers: { authorization: 'token ghs_x' },
    });
    expect(createParameters.output).toEqual({
      title: 'Differential verification passed',
      summary: 'Run A failed as expected; Run B passed. Verdict: verified-fix.',
    });
  });

  it('POSTs a completed run when the head commit has no check runs at all', async () => {
    const { reporter, request } = buildReporter();
    request
      .mockResolvedValueOnce({ status: 200, data: { total_count: 0, check_runs: [] } })
      .mockResolvedValueOnce({ status: 201, data: {} });

    await expect(reporter.reportVerdict(REPORT)).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledTimes(2);
    const [createRoute, createParameters] = callAt(request, 1);
    expect(createRoute).toBe(CREATE_ROUTE);
    expect(createParameters).toMatchObject({
      name: CHECK_RUN_NAME,
      head_sha: 'head456',
      status: 'completed',
      conclusion: 'success',
    });
  });

  it('rejects a malformed repoFullName without calling GitHub', async () => {
    const { reporter, request, installation } = buildReporter();

    await expect(
      reporter.reportVerdict({ ...REPORT, repoFullName: 'no-slash' }),
    ).rejects.toThrow(/invalid repoFullName: no-slash/);

    expect(request).not.toHaveBeenCalled();
    expect(installation).not.toHaveBeenCalled();
  });

  it('rethrows check-run lookup failures with the HTTP status, repo and sha, without the token', async () => {
    const { reporter, request } = buildReporter();
    request.mockRejectedValue(requestError(403, 'Forbidden'));

    const message = await messageOf(reporter.reportVerdict(REPORT));

    expect(message).toContain('403');
    expect(message).toContain('hello-world');
    expect(message).toContain('head456');
    expect(message).toContain('verified-fix');
    expect(message).not.toContain('ghs_x');
    // A failed lookup must not fall through to creating a run.
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rethrows check-run update failures without falling back to a second write', async () => {
    const { reporter, request } = buildReporter();
    request
      .mockResolvedValueOnce({
        status: 200,
        data: { total_count: 1, check_runs: [{ id: 77, name: CHECK_RUN_NAME }] },
      })
      .mockRejectedValueOnce(requestError(500, 'Server Error'));

    const message = await messageOf(reporter.reportVerdict(REPORT));

    expect(message).toContain('500');
    expect(message).toContain('head456');
    expect(message).not.toContain('ghs_x');
    expect(request).toHaveBeenCalledTimes(2);
  });
});
