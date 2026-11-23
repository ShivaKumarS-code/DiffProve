import type { Octokit } from '@octokit/core';
import { describe, expect, it, vi } from 'vitest';

import type { CheckRunInput } from '../domain.js';
import { CHECK_RUN_NAME, createCheckRunPoster } from './checks.js';

const QUEUED_INPUT: CheckRunInput = {
  repoFullName: 'octocat/hello-world',
  headSha: 'abc123def',
  installationId: 42,
};

/** Builds the poster with a fake transport and a fake token source. */
function buildPoster(): {
  poster: ReturnType<typeof createCheckRunPoster>;
  request: ReturnType<typeof vi.fn>;
  installation: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn();
  const installation = vi.fn().mockResolvedValue({ token: 'ghs_x' });
  const octokit = { request } as unknown as Octokit;
  const poster = createCheckRunPoster(octokit, { installation });

  return { poster, request, installation };
}

describe('createCheckRunPoster', () => {
  it('posts a queued check run on the PR head sha using an installation token', async () => {
    const { poster, request, installation } = buildPoster();

    await expect(poster.postQueuedCheckRun(QUEUED_INPUT)).resolves.toBeUndefined();

    expect(installation).toHaveBeenCalledTimes(1);
    expect(installation).toHaveBeenCalledWith(42);

    expect(request).toHaveBeenCalledTimes(1);
    const [route, parameters] = request.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];

    expect(route).toBe('POST /repos/{owner}/{repo}/check-runs');
    expect(parameters).toMatchObject({
      owner: 'octocat',
      repo: 'hello-world',
      name: CHECK_RUN_NAME,
      head_sha: 'abc123def',
      status: 'queued',
    });
    expect(parameters.headers).toEqual({ authorization: 'token ghs_x' });
  });

  it('rejects a malformed repoFullName without calling GitHub', async () => {
    const { poster, request, installation } = buildPoster();

    await expect(
      poster.postQueuedCheckRun({ ...QUEUED_INPUT, repoFullName: 'no-slash' }),
    ).rejects.toThrow(/invalid repoFullName: no-slash/);

    expect(request).not.toHaveBeenCalled();
    expect(installation).not.toHaveBeenCalled();
  });

  it('refuses to post a check run without installation context', async () => {
    const { poster, request, installation } = buildPoster();

    await expect(
      poster.postQueuedCheckRun({ ...QUEUED_INPUT, installationId: null }),
    ).rejects.toThrow(/installation context/);

    expect(request).not.toHaveBeenCalled();
    expect(installation).not.toHaveBeenCalled();
  });

  it('rethrows request failures with the HTTP status and repo, without the token', async () => {
    const { poster, request } = buildPoster();
    request.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 403'), {
        status: 403,
        response: { status: 403, headers: {}, data: { message: 'Forbidden' } },
      }),
    );

    let thrown: unknown;
    try {
      await poster.postQueuedCheckRun(QUEUED_INPUT);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('403');
    expect(message).toContain('hello-world');
    expect(message).toContain('abc123def');
    expect(message).not.toContain('ghs_x');
  });
});
