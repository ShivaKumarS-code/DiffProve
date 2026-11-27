import type { Octokit } from '@octokit/core';
import { describe, expect, it, vi } from 'vitest';

import { createPrDiffClient } from './pulls.js';

/** Canned `.diff` body, shaped like GitHub's compare response. */
const DIFF_BODY = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n';
const MERGE_BASE_SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const COMPARE_METADATA = {
  status: 200,
  data: { merge_base_commit: { sha: MERGE_BASE_SHA } },
};

const REQUEST = {
  repoFullName: 'octocat/hello-world',
  baseSha: 'base123',
  headSha: 'head456',
  installationId: 42,
};

/** Builds the client with a fake transport and a fake token source. */
function buildClient(): {
  client: ReturnType<typeof createPrDiffClient>;
  request: ReturnType<typeof vi.fn>;
  installation: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn();
  const installation = vi.fn().mockResolvedValue({ token: 'ghs_x' });
  const octokit = { request } as unknown as Octokit;
  const client = createPrDiffClient(octokit, { installation });

  return { client, request, installation };
}

/** Reads one recorded `octokit.request` call as `[route, parameters]`. */
function callAt(
  request: ReturnType<typeof vi.fn>,
  index: number,
): [string, Record<string, unknown>] {
  return request.mock.calls[index] as [string, Record<string, unknown>];
}

describe('createPrDiffClient', () => {
  it('gets the merge base and full raw diff for the same pinned range', async () => {
    const { client, request, installation } = buildClient();
    request
      .mockResolvedValueOnce(COMPARE_METADATA)
      .mockResolvedValueOnce({ status: 200, data: DIFF_BODY });

    await expect(client(REQUEST)).resolves.toEqual({ diff: DIFF_BODY, mergeBaseSha: MERGE_BASE_SHA });

    expect(installation).toHaveBeenCalledTimes(1);
    expect(installation).toHaveBeenCalledWith(42);

    expect(request).toHaveBeenCalledTimes(2);
    const route = 'GET /repos/{owner}/{repo}/compare/{basehead}';
    const pinnedRange = { owner: 'octocat', repo: 'hello-world', basehead: 'base123...head456' };

    expect(callAt(request, 0)).toEqual([route, {
      ...pinnedRange,
      per_page: 1,
      headers: {
        accept: 'application/vnd.github.json',
        authorization: 'token ghs_x',
      },
    }]);
    expect(callAt(request, 1)).toEqual([route, {
      ...pinnedRange,
      headers: {
        accept: 'application/vnd.github.diff',
        authorization: 'token ghs_x',
      },
    }]);
  });

  it.each([
    null,
    { base_commit: { sha: MERGE_BASE_SHA } },
    { merge_base_commit: null },
    { merge_base_commit: { sha: 123 } },
    { merge_base_commit: { sha: 'ghs_x' } },
    { merge_base_commit: { sha: MERGE_BASE_SHA.slice(0, 7) } },
  ])('rejects invalid merge-base metadata without falling back to the branch tip (%j)', async (data) => {
    const { client, request } = buildClient();
    request.mockResolvedValueOnce({ status: 200, data });

    await expect(client(REQUEST)).rejects.toThrow(/invalid merge_base_commit\.sha/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('preserves an empty diff for the neutral short-circuit', async () => {
    const { client, request } = buildClient();
    request
      .mockResolvedValueOnce(COMPARE_METADATA)
      .mockResolvedValueOnce({ status: 200, data: '' });

    await expect(client(REQUEST)).resolves.toEqual({
      diff: '',
      mergeBaseSha: MERGE_BASE_SHA,
    });
  });

  it('rejects a non-diff body without leaking the token', async () => {
    const { client, request } = buildClient();
    request
      .mockResolvedValueOnce(COMPARE_METADATA)
      .mockResolvedValueOnce({ status: 200, data: { object: 'compare' } });

    let thrown: unknown;
    try {
      await client(REQUEST);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('non-diff body');
    expect(message).toContain('HTTP 200');
    expect(message).toContain('hello-world');
    expect(message).not.toContain('ghs_x');
  });

  it('rejects a malformed repoFullName without calling GitHub', async () => {
    const { client, request, installation } = buildClient();

    await expect(
      client({ ...REQUEST, repoFullName: 'no-slash' }),
    ).rejects.toThrow(/invalid repoFullName: no-slash/);

    expect(request).not.toHaveBeenCalled();
    expect(installation).not.toHaveBeenCalled();
  });

  it.each(['json', 'diff'] as const)('sanitizes failed %s requests with the status and range', async (format) => {
    const { client, request } = buildClient();
    if (format === 'diff') {
      request.mockResolvedValueOnce(COMPARE_METADATA);
    }
    request.mockRejectedValueOnce(
      Object.assign(new Error('ghs_x'), {
        status: 404,
        response: { status: 404, headers: {}, data: { message: 'Not Found' } },
        request: { headers: { authorization: 'token ghs_x' } },
      }),
    );

    let thrown: unknown;
    try {
      await client(REQUEST);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('404');
    expect(message).toContain('hello-world');
    expect(message).toContain('base123...head456');
    expect(message).not.toContain('ghs_x');
    expect((thrown as Error).cause).toBeUndefined();
  });
});
