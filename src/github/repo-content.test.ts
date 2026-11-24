import type { Octokit } from '@octokit/core';
import { describe, expect, it, vi } from 'vitest';

import { createRepoContentClient } from './repo-content.js';

const FILE_INPUT = {
  repoFullName: 'octocat/hello-world',
  path: 'package.json',
  ref: 'base123',
  installationId: 42,
};

const TREE_INPUT = {
  repoFullName: 'octocat/hello-world',
  ref: 'base123',
  installationId: 42,
};

const CONTENTS_ROUTE = 'GET /repos/{owner}/{repo}/contents/{path}';
const TREE_ROUTE = 'GET /repos/{owner}/{repo}/git/trees/{tree_sha}';

/** Encodes UTF-8 text the way GitHub's contents API returns a file body. */
function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** Builds the client with a fake transport and a fake token source. */
function buildClient(): {
  client: ReturnType<typeof createRepoContentClient>;
  request: ReturnType<typeof vi.fn>;
  installation: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn();
  const installation = vi.fn().mockResolvedValue({ token: 'ghs_x' });
  const octokit = { request } as unknown as Octokit;
  const client = createRepoContentClient(octokit, { installation });

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

describe('createRepoContentClient.fetchTextFile', () => {
  it('fetches a manifest at the pinned ref and decodes the base64 body to text', async () => {
    const { client, request, installation } = buildClient();
    const manifest = '{\n  "name": "hello-world",\n  "private": true\n}\n';
    request.mockResolvedValue({
      status: 200,
      data: {
        type: 'file',
        encoding: 'base64',
        content: base64(manifest),
        name: 'package.json',
        path: 'package.json',
      },
    });

    await expect(client.fetchTextFile(FILE_INPUT)).resolves.toBe(manifest);

    expect(installation).toHaveBeenCalledTimes(1);
    expect(installation).toHaveBeenCalledWith(42);

    expect(request).toHaveBeenCalledTimes(1);
    const [route, parameters] = callAt(request, 0);
    expect(route).toBe(CONTENTS_ROUTE);
    expect(parameters).toMatchObject({
      owner: 'octocat',
      repo: 'hello-world',
      path: 'package.json',
      ref: 'base123',
      headers: { authorization: 'token ghs_x' },
    });
  });

  it('resolves null when the file is absent at that ref (404)', async () => {
    const { client, request } = buildClient();
    request.mockRejectedValue(requestError(404, 'Not Found'));

    await expect(client.fetchTextFile(FILE_INPUT)).resolves.toBeNull();

    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-base64 body as an unexpected contents response, without the token', async () => {
    const { client, request } = buildClient();
    request.mockResolvedValue({
      status: 200,
      data: { type: 'file', encoding: 'utf-8', content: 'plain, not base64' },
    });

    const message = await messageOf(client.fetchTextFile(FILE_INPUT));

    expect(request).toHaveBeenCalledTimes(1);
    expect(message).toContain('unexpected contents response');
    expect(message).toContain('package.json');
    expect(message).toContain('base123');
    expect(message).not.toContain('ghs_x');
  });

  it('rejects a directory-shaped body as an unexpected contents response', async () => {
    const { client, request } = buildClient();
    request.mockResolvedValue({
      status: 200,
      data: [{ name: 'package.json', path: 'package.json', type: 'file' }],
    });

    const message = await messageOf(client.fetchTextFile(FILE_INPUT));

    expect(message).toContain('unexpected contents response');
    expect(message).not.toContain('ghs_x');
  });

  it('rethrows request failures with the HTTP status, repo, path and ref, without the token', async () => {
    const { client, request } = buildClient();
    request.mockRejectedValue(requestError(500, 'Server Error'));

    const message = await messageOf(client.fetchTextFile(FILE_INPUT));

    expect(message).toContain('500');
    expect(message).toContain('hello-world');
    expect(message).toContain('package.json');
    expect(message).toContain('base123');
    expect(message).not.toContain('ghs_x');
  });

  it('rejects a malformed repoFullName without calling GitHub', async () => {
    const { client, request, installation } = buildClient();

    await expect(
      client.fetchTextFile({ ...FILE_INPUT, repoFullName: 'no-slash' }),
    ).rejects.toThrow(/invalid repoFullName: no-slash/);

    expect(request).not.toHaveBeenCalled();
    expect(installation).not.toHaveBeenCalled();
  });
});

describe('createRepoContentClient.listPaths', () => {
  it('lists only blob paths from the recursive tree, in the order GitHub returned them', async () => {
    const { client, request, installation } = buildClient();
    request.mockResolvedValue({
      status: 200,
      data: {
        sha: 'base123',
        truncated: false,
        tree: [
          { path: 'tests', mode: '040000', type: 'tree', sha: 'aaa' },
          { path: 'package.json', mode: '100644', type: 'blob', sha: 'bbb', size: 61 },
          { path: 'src/index.ts', mode: '100644', type: 'blob', sha: 'ccc', size: 12 },
          { path: 'poetry.lock', mode: '100644', type: 'blob', sha: 'ddd', size: 2048 },
        ],
      },
    });

    await expect(client.listPaths(TREE_INPUT)).resolves.toEqual([
      'package.json',
      'src/index.ts',
      'poetry.lock',
    ]);

    expect(installation).toHaveBeenCalledTimes(1);
    expect(installation).toHaveBeenCalledWith(42);

    expect(request).toHaveBeenCalledTimes(1);
    const [route, parameters] = callAt(request, 0);
    expect(route).toBe(TREE_ROUTE);
    expect(parameters).toMatchObject({
      owner: 'octocat',
      repo: 'hello-world',
      tree_sha: 'base123',
      recursive: '1',
      headers: { authorization: 'token ghs_x' },
    });
  });

  it('still returns the partial list when GitHub truncates the tree', async () => {
    const { client, request } = buildClient();
    request.mockResolvedValue({
      status: 200,
      data: {
        sha: 'base123',
        truncated: true,
        tree: [
          { path: 'package.json', mode: '100644', type: 'blob', sha: 'bbb', size: 61 },
          { path: '.github/workflows/ci.yml', mode: '100644', type: 'blob', sha: 'eee', size: 90 },
        ],
      },
    });

    await expect(client.listPaths(TREE_INPUT)).resolves.toEqual([
      'package.json',
      '.github/workflows/ci.yml',
    ]);
  });

  it('rethrows tree request failures with the HTTP status and ref, without the token', async () => {
    const { client, request } = buildClient();
    request.mockRejectedValue(requestError(404, 'Not Found'));

    const message = await messageOf(client.listPaths(TREE_INPUT));

    expect(message).toContain('404');
    expect(message).toContain('hello-world');
    expect(message).toContain('base123');
    expect(message).not.toContain('ghs_x');
  });

  it('rejects a malformed repoFullName without calling GitHub', async () => {
    const { client, request, installation } = buildClient();

    await expect(
      client.listPaths({ ...TREE_INPUT, repoFullName: 'no-slash' }),
    ).rejects.toThrow(/invalid repoFullName: no-slash/);

    expect(request).not.toHaveBeenCalled();
    expect(installation).not.toHaveBeenCalled();
  });
});
