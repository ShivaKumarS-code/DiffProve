import type { Octokit } from '@octokit/core';
import { describe, expect, it, vi } from 'vitest';

import { createPrDiffClient } from './pulls.js';

/** Canned `.diff` body, shaped like GitHub's compare response. */
const DIFF_BODY = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n';

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
  it('fetches the sha-pinned compare diff with the .diff media type and an installation token', async () => {
    const { client, request, installation } = buildClient();
    request.mockResolvedValue({ status: 200, data: DIFF_BODY });

    await expect(client(REQUEST)).resolves.toBe(DIFF_BODY);

    expect(installation).toHaveBeenCalledTimes(1);
    expect(installation).toHaveBeenCalledWith(42);

    expect(request).toHaveBeenCalledTimes(1);
    const [route, parameters] = callAt(request, 0);

    expect(route).toBe('GET /repos/{owner}/{repo}/compare/{basehead}');
    expect(parameters).toMatchObject({
      owner: 'octocat',
      repo: 'hello-world',
      basehead: 'base123...head456',
      headers: {
        accept: 'application/vnd.github.diff',
        authorization: 'token ghs_x',
      },
    });
  });

  it('rejects a non-diff body without leaking the token', async () => {
    const { client, request } = buildClient();
    request.mockResolvedValue({ status: 200, data: { object: 'compare' } });

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

  it('rethrows compare failures with the HTTP status, repo and basehead, without the token', async () => {
    const { client, request } = buildClient();
    request.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 404'), {
        status: 404,
        response: { status: 404, headers: {}, data: { message: 'Not Found' } },
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
  });
});
