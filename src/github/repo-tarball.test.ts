import type { Octokit } from '@octokit/core';
import { describe, expect, it, vi } from 'vitest';

import { createRepoTarballClient } from './repo-tarball.js';

const INPUT = {
  repoFullName: 'octocat/hello-world',
  ref: 'base123',
  installationId: 42,
};

const TARBALL_ROUTE = 'GET /repos/{owner}/{repo}/tarball/{ref}';

/** First bytes of a gzip stream — enough to look like an archive body. */
const ARCHIVE_BYTES = [0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00];

/** Builds the client with a fake transport and a fake token source. */
function buildClient(): {
  client: ReturnType<typeof createRepoTarballClient>;
  request: ReturnType<typeof vi.fn>;
  installation: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn();
  const installation = vi.fn().mockResolvedValue({ token: 'ghs_x' });
  const octokit = { request } as unknown as Octokit;
  const client = createRepoTarballClient(octokit, { installation });

  return { client, request, installation };
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

describe('createRepoTarballClient', () => {
  it('returns the redirected archive body as bytes when Octokit hands back an ArrayBuffer', async () => {
    const { client, request, installation } = buildClient();
    const arrayBuffer = new Uint8Array(ARCHIVE_BYTES).buffer as ArrayBuffer;
    request.mockResolvedValue({ status: 200, data: arrayBuffer });

    const bytes = await client(INPUT);

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes)).toEqual(ARCHIVE_BYTES);

    expect(installation).toHaveBeenCalledTimes(1);
    expect(installation).toHaveBeenCalledWith(42);

    expect(request).toHaveBeenCalledTimes(1);
    const [route, parameters] = callAt(request, 0);
    expect(route).toBe(TARBALL_ROUTE);
    expect(parameters).toMatchObject({
      owner: 'octocat',
      repo: 'hello-world',
      ref: 'base123',
      headers: { authorization: 'token ghs_x' },
    });
  });

  it('passes the owner/repo split and installation id straight through', async () => {
    const { client, request, installation } = buildClient();
    request.mockResolvedValue({ status: 200, data: Uint8Array.from(ARCHIVE_BYTES) });

    const bytes = await client({ repoFullName: 'acme/widgets', ref: 'head456', installationId: 7 });

    expect(Array.from(bytes)).toEqual(ARCHIVE_BYTES);
    expect(installation).toHaveBeenCalledWith(7);

    const [route, parameters] = callAt(request, 0);
    expect(route).toBe(TARBALL_ROUTE);
    expect(parameters).toEqual({
      owner: 'acme',
      repo: 'widgets',
      ref: 'head456',
      headers: { authorization: 'token ghs_x' },
    });
  });

  it('rejects an empty body as an unexpected tarball response', async () => {
    const { client, request } = buildClient();
    request.mockResolvedValue({ status: 200, data: new Uint8Array(0) });

    const message = await messageOf(client(INPUT));

    expect(message).toContain('unexpected tarball response');
    expect(message).toContain('HTTP 200');
    expect(message).toContain('hello-world');
    expect(message).toContain('base123');
    expect(message).not.toContain('ghs_x');
  });

  it('rejects a non-binary body as an unexpected tarball response, without the token', async () => {
    const { client, request } = buildClient();
    request.mockResolvedValue({ status: 200, data: 'PK\u0003\u0004 not really a tarball' });

    const message = await messageOf(client(INPUT));

    expect(message).toContain('unexpected tarball response');
    expect(message).toContain('hello-world');
    expect(message).not.toContain('ghs_x');
  });

  it('rethrows request failures with the HTTP status, repo and ref, without the token', async () => {
    const { client, request } = buildClient();
    request.mockRejectedValue(requestError(404, 'Not Found'));

    const message = await messageOf(client(INPUT));

    expect(message).toContain('404');
    expect(message).toContain('hello-world');
    expect(message).toContain('base123');
    expect(message).not.toContain('ghs_x');
  });

  it('rejects a malformed repoFullName without calling GitHub', async () => {
    const { client, request, installation } = buildClient();

    await expect(
      client({ ...INPUT, repoFullName: 'no-slash' }),
    ).rejects.toThrow(/invalid repoFullName: no-slash/);

    expect(request).not.toHaveBeenCalled();
    expect(installation).not.toHaveBeenCalled();
  });
});
