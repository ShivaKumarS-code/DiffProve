import type { Octokit } from '@octokit/core';
import { describe, expect, it, vi } from 'vitest';

import { type VerificationJob, verificationKey } from '../domain.js';
import { CHECK_RUN_NAME, createVerificationChecks } from './checks.js';

const JOB: VerificationJob = {
  repoFullName: 'octocat/hello-world',
  headSha: 'abc123def',
  baseSha: 'bbb222',
  prNumber: 7,
  installationId: 42,
};

const LIST = 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs';
const CREATE = 'POST /repos/{owner}/{repo}/check-runs';
const GET = 'GET /repos/{owner}/{repo}/check-runs/{check_run_id}';
const PATCH = 'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}';
const EXTERNAL_ID = verificationKey(JOB);
const SAME_IDENTITY = { name: CHECK_RUN_NAME, external_id: EXTERNAL_ID, app: { id: 13 } };
const SCOPE = {
  owner: 'octocat',
  repo: 'hello-world',
  headers: { authorization: 'token ghs_x' },
};

function listed(checkRuns: unknown[] = [], link?: string) {
  return { data: { check_runs: checkRuns }, headers: { link } };
}

function setup() {
  const request = vi.fn();
  const installation = vi.fn().mockResolvedValue({ token: 'ghs_x' });
  const checks = createVerificationChecks({ request } as unknown as Octokit, { installation }, 13);
  return { checks, request, installation };
}

describe('createVerificationChecks', () => {
  it('creates a queued check on the pinned head with a stable external ID', async () => {
    const { checks, request, installation } = setup();
    request.mockResolvedValueOnce(listed()).mockResolvedValueOnce({ data: { id: 77 } });

    await expect(checks.ensureQueuedCheckRun(JOB)).resolves.toBe(77);

    expect(installation).toHaveBeenCalledExactlyOnceWith(42);
    expect(request).toHaveBeenNthCalledWith(1, LIST, {
      ...SCOPE,
      app_id: 13,
      ref: JOB.headSha,
      filter: 'all',
      page: 1,
      per_page: 100,
    });
    expect(request).toHaveBeenNthCalledWith(2, CREATE, {
      ...SCOPE,
      name: CHECK_RUN_NAME,
      head_sha: JOB.headSha,
      status: 'queued',
      external_id: EXTERNAL_ID,
    });
  });

  it('recovers only a matching App and external ID, across pages and regardless of status', async () => {
    const { checks, request } = setup();
    request
      .mockResolvedValueOnce(listed([
        { id: 1, name: CHECK_RUN_NAME, app: { id: 13 }, external_id: null },
        { id: 2, name: CHECK_RUN_NAME, app: { id: 13 }, external_id: verificationKey({ ...JOB, prNumber: 9 }) },
        { id: 3, ...SAME_IDENTITY, app: { id: 99 } },
      ], '<https://api.github.com/page?page=2>; rel="next"'))
      .mockResolvedValueOnce(listed([{ id: 77, ...SAME_IDENTITY, status: 'completed' }]));

    await expect(checks.ensureQueuedCheckRun(JOB)).resolves.toBe(77);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith(LIST, expect.objectContaining({ page: 2, filter: 'all' }));
  });

  it('recovers a check when GitHub created it but the POST response was lost', async () => {
    const { checks, request } = setup();
    request
      .mockResolvedValueOnce(listed())
      .mockRejectedValueOnce(new Error('connection closed'))
      .mockResolvedValueOnce(listed([{ id: 77, ...SAME_IDENTITY }]));

    await expect(checks.ensureQueuedCheckRun(JOB)).rejects.toThrow('ensure queued check run');
    await expect(checks.ensureQueuedCheckRun(JOB)).resolves.toBe(77);
    expect(request.mock.calls.map(([route]) => route)).toEqual([LIST, CREATE, LIST]);
  });

  it('looks up and completes the exact check after exhaustion when the ID was not persisted', async () => {
    const { checks, request } = setup();
    request.mockResolvedValueOnce(listed([{ id: 77, ...SAME_IDENTITY }]))
      .mockResolvedValueOnce({ data: { status: 'queued' } })
      .mockResolvedValueOnce({});

    await checks.reportExhaustedFailure(JOB);

    expect(request).toHaveBeenNthCalledWith(2, GET, { ...SCOPE, check_run_id: 77 });
    expect(request).toHaveBeenNthCalledWith(3, PATCH, {
      ...SCOPE,
      check_run_id: 77,
      status: 'completed',
      conclusion: 'neutral',
      output: {
        title: 'Differential verification could not complete',
        summary: 'DiffProve could not finish verification after retries. No test verdict is available.',
      },
    });
  });

  it('creates a completed neutral check directly if no check was ever created', async () => {
    const { checks, request } = setup();
    request.mockResolvedValueOnce(listed()).mockResolvedValueOnce({});

    await checks.reportExhaustedFailure(JOB);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith(CREATE, expect.objectContaining({
      head_sha: JOB.headSha,
      external_id: EXTERNAL_ID,
      status: 'completed',
      conclusion: 'neutral',
    }));
  });

  it('does not overwrite a completed verdict after the history write fails', async () => {
    const { checks, request } = setup();
    request.mockResolvedValueOnce({ data: { status: 'completed', conclusion: 'success' } });

    await checks.reportExhaustedFailure({ ...JOB, checkRunId: 77 });

    expect(request).toHaveBeenCalledExactlyOnceWith(GET, { ...SCOPE, check_run_id: 77 });
  });

  it('does not guess whether a persisted check is complete if the exact GET fails', async () => {
    const { checks, request } = setup();
    request.mockRejectedValueOnce(Object.assign(new Error('private request details'), { status: 503 }));

    await expect(checks.reportExhaustedFailure({ ...JOB, checkRunId: 77 }))
      .rejects.toThrow('failed to report exhausted verification for octocat/hello-world at abc123def with HTTP 503');

    expect(request).toHaveBeenCalledExactlyOnceWith(GET, { ...SCOPE, check_run_id: 77 });
  });

  it('does not expose GitHub request details or create on lookup failure', async () => {
    const { checks, request } = setup();
    request.mockRejectedValueOnce(Object.assign(new Error('token ghs_x'), { status: 403 }));

    const failure = checks.ensureQueuedCheckRun(JOB);
    await expect(failure).rejects.toThrow('failed to ensure queued check run for octocat/hello-world at abc123def with HTTP 403');
    await expect(failure).rejects.not.toHaveProperty('cause');
    expect(request).toHaveBeenCalledTimes(1);
  });
});
