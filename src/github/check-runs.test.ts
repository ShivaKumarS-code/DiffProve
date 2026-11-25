import type { Octokit } from '@octokit/core';
import { describe, expect, it, vi } from 'vitest';

import { CHECK_RUN_NAME } from './checks.js';
import { createCheckRunReporter } from './check-runs.js';

const REPORT = {
  repoFullName: 'octocat/hello-world',
  headSha: 'head456',
  installationId: 42,
  title: 'No test changes detected to verify',
  summary: 'pure refactor: 2 files, 0 tests',
};

const LIST_ROUTE = 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs';
const PATCH_ROUTE = 'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}';
const CREATE_ROUTE = 'POST /repos/{owner}/{repo}/check-runs';

/** Builds the reporter with a fake transport and a fake token source. */
function buildReporter(): {
  reporter: ReturnType<typeof createCheckRunReporter>;
  request: ReturnType<typeof vi.fn>;
  installation: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn();
  const installation = vi.fn().mockResolvedValue({ token: 'ghs_x' });
  const octokit = { request } as unknown as Octokit;
  const reporter = createCheckRunReporter(octokit, { installation });

  return { reporter, request, installation };
}

/** Reads one recorded `octokit.request` call as `[route, parameters]`. */
function callAt(
  request: ReturnType<typeof vi.fn>,
  index: number,
): [string, Record<string, unknown>] {
  return request.mock.calls[index] as [string, Record<string, unknown>];
}

describe('createCheckRunReporter', () => {
  it('patches the queued DiffProve check run to completed/neutral', async () => {
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

    await expect(reporter.reportNoTestChanges(REPORT)).resolves.toBeUndefined();

    expect(installation).toHaveBeenCalledTimes(1);
    expect(installation).toHaveBeenCalledWith(42);
    expect(request).toHaveBeenCalledTimes(2);

    const [listRoute, listParameters] = callAt(request, 0);
    expect(listRoute).toBe(LIST_ROUTE);
    expect(listParameters).toMatchObject({
      owner: 'octocat',
      repo: 'hello-world',
      ref: 'head456',
      check_name: CHECK_RUN_NAME,
      per_page: 100,
      headers: { authorization: 'token ghs_x' },
    });

    const [patchRoute, patchParameters] = callAt(request, 1);
    expect(patchRoute).toBe(PATCH_ROUTE);
    expect(patchParameters).toMatchObject({
      owner: 'octocat',
      repo: 'hello-world',
      check_run_id: 77,
      status: 'completed',
      conclusion: 'neutral',
      headers: { authorization: 'token ghs_x' },
    });
    // Report fields flow through untouched ("API & Interface Contracts").
    expect(patchParameters.output).toEqual({
      title: 'No test changes detected to verify',
      summary: 'pure refactor: 2 files, 0 tests',
    });
  });

  it('POSTs a completed/neutral run when the queued one is absent', async () => {
    const { reporter, request, installation } = buildReporter();
    request
      .mockResolvedValueOnce({
        status: 200,
        data: { total_count: 1, check_runs: [{ id: 1, name: 'Other CI' }] },
      })
      .mockResolvedValueOnce({ status: 201, data: {} });

    await expect(reporter.reportNoTestChanges(REPORT)).resolves.toBeUndefined();

    expect(installation).toHaveBeenCalledTimes(1);
    expect(installation).toHaveBeenCalledWith(42);
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
      conclusion: 'neutral',
      headers: { authorization: 'token ghs_x' },
    });
    expect(createParameters.output).toEqual({
      title: 'No test changes detected to verify',
      summary: 'pure refactor: 2 files, 0 tests',
    });
  });

  it('POSTs a completed/neutral run when the head commit has no check runs at all', async () => {
    const { reporter, request } = buildReporter();
    request
      .mockResolvedValueOnce({
        status: 200,
        data: { total_count: 0, check_runs: [] },
      })
      .mockResolvedValueOnce({ status: 201, data: {} });

    await expect(reporter.reportNoTestChanges(REPORT)).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledTimes(2);
    const [createRoute, createParameters] = callAt(request, 1);
    expect(createRoute).toBe(CREATE_ROUTE);
    expect(createParameters).toMatchObject({
      name: CHECK_RUN_NAME,
      head_sha: 'head456',
      status: 'completed',
      conclusion: 'neutral',
    });
    expect(createParameters.output).toEqual({
      title: 'No test changes detected to verify',
      summary: 'pure refactor: 2 files, 0 tests',
    });
  });

  it('rejects a malformed repoFullName without calling GitHub', async () => {
    const { reporter, request, installation } = buildReporter();

    await expect(
      reporter.reportNoTestChanges({ ...REPORT, repoFullName: 'no-slash' }),
    ).rejects.toThrow(/invalid repoFullName: no-slash/);

    expect(request).not.toHaveBeenCalled();
    expect(installation).not.toHaveBeenCalled();
  });

  it('rethrows check-run lookup failures with the HTTP status and repo, without the token', async () => {
    const { reporter, request } = buildReporter();
    request.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 403'), {
        status: 403,
        response: { status: 403, headers: {}, data: { message: 'Forbidden' } },
      }),
    );

    let thrown: unknown;
    try {
      await reporter.reportNoTestChanges(REPORT);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('403');
    expect(message).toContain('hello-world');
    expect(message).toContain('head456');
    expect(message).not.toContain('ghs_x');
    // A failed lookup must not fall through to creating a run.
    expect(request).toHaveBeenCalledTimes(1);
  });
});
