/**
 * Trusted-side repo content access for runner detection and lockfile hashing.
 *
 * The sandbox must never see a GitHub token (architecture guardrail #2), so the
 * worker — not the sandbox — reads the repo: manifests and lockfiles through the
 * contents API and the recursive file list through the git trees API. Both
 * endpoints are documented under "API & Interface Contracts" and motivated by
 * the Phase 3 design note (fetch content in the trusted worker, hand the runner
 * plain bytes).
 *
 * v1 limitation: the contents API refuses file bodies larger than 1 MB, and
 * answers HTTP 403 for them. Every lockfile/manifest in scope (`pyproject.toml`,
 * `package.json`, `package-lock.json`, `poetry.lock`, ...) is far below that, so
 * the 403 surfaces as a wrapped error instead of being mistaken for absence.
 * Reading such files would need the blob API (`git/blobs/{sha}`) instead.
 */

import type { Octokit } from '@octokit/core';

import type { RepoContentClient, RepoFileInput, RepoTreeInput } from '../runner/types.js';
import type { InstallationTokenSource } from './octokit.js';

const CONTENTS_ROUTE = 'GET /repos/{owner}/{repo}/contents/{path}';
const TREE_ROUTE = 'GET /repos/{owner}/{repo}/git/trees/{tree_sha}';

/** Extracts the HTTP status from an Octokit `RequestError`-shaped value. */
function httpStatusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const candidate = error as { status?: unknown; response?: { status?: unknown } };
  const status = candidate.status ?? candidate.response?.status;

  return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
}

/**
 * Narrows an unseen response body to a base64-encoded file payload.
 *
 * The contents endpoint is polymorphic (file, directory, symlink, submodule),
 * and a directory fetch would otherwise be silently decoded as garbage, so both
 * `content` (string) and `encoding === 'base64'` must be proven before decoding.
 */
function base64FileContent(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }

  const candidate = data as { content?: unknown; encoding?: unknown };
  if (typeof candidate.content !== 'string' || candidate.encoding !== 'base64') {
    return null;
  }

  return candidate.content;
}

/**
 * Narrows an unseen response body to the tree paths worth returning.
 *
 * Only `blob` entries are files; `tree` entries are subdirectories that the
 * recursive listing already expands. The listed order is preserved.
 */
function blobPaths(data: unknown): string[] | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }

  const tree = (data as { tree?: unknown }).tree;
  if (!Array.isArray(tree)) {
    return null;
  }

  const paths: string[] = [];
  for (const entry of tree) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }

    const item = entry as { type?: unknown; path?: unknown };
    if (item.type === 'blob' && typeof item.path === 'string') {
      paths.push(item.path);
    }
  }

  return paths;
}

/**
 * Builds the `RepoContentClient`.
 *
 * The transport is auth-less (see `src/github/octokit.ts`), so the installation
 * token is attached per request here. Guardrail #2: the token is never logged
 * and never attached to a thrown error.
 */
export function createRepoContentClient(
  octokit: Octokit,
  authenticator: InstallationTokenSource,
): RepoContentClient {
  return {
    async fetchTextFile(input: RepoFileInput): Promise<string | null> {
      const [owner, repo] = input.repoFullName.split('/');
      if (!owner || !repo) {
        throw new Error(`invalid repoFullName: ${input.repoFullName}`);
      }

      const { token } = await authenticator.installation(input.installationId);

      let response: { status: number; data: unknown };
      try {
        response = await octokit.request(CONTENTS_ROUTE, {
          owner,
          repo,
          path: input.path,
          ref: input.ref,
          headers: { authorization: `token ${token}` },
        });
      } catch (error) {
        // A 404 is a legitimate answer, not a failure: the manifest or lockfile
        // simply does not exist at this ref, and the caller skips it.
        if (httpStatusOf(error) === 404) {
          return null;
        }

        const status = httpStatusOf(error);
        const statusSuffix = status === undefined ? '' : ` with HTTP ${status}`;
        const message =
          `failed to fetch ${owner}/${repo}:${input.path} at ${input.ref}${statusSuffix}` +
          ': GitHub contents request failed';

        // Deliberately no `cause`: Octokit's RequestError keeps the outgoing
        // request (including the Authorization header) on the error object, so
        // re-exposing it would leak the installation token into logs
        // (architecture guardrail #2).
        // eslint-disable-next-line preserve-caught-error -- a `cause` here would carry the token
        throw new Error(message);
      }

      const content = base64FileContent(response.data);
      if (content === null) {
        const status = httpStatusOf(response);
        const statusSuffix = status === undefined ? '' : ` (HTTP ${status})`;
        throw new Error(
          `unexpected contents response${statusSuffix} for ${owner}/${repo}:${input.path}` +
            ` at ${input.ref}: expected a base64-encoded file body`,
        );
      }

      return Buffer.from(content, 'base64').toString('utf8');
    },

    async listPaths(input: RepoTreeInput): Promise<string[]> {
      const [owner, repo] = input.repoFullName.split('/');
      if (!owner || !repo) {
        throw new Error(`invalid repoFullName: ${input.repoFullName}`);
      }

      const { token } = await authenticator.installation(input.installationId);

      let response: { status: number; data: unknown };
      try {
        response = await octokit.request(TREE_ROUTE, {
          owner,
          repo,
          tree_sha: input.ref,
          recursive: '1',
          headers: { authorization: `token ${token}` },
        });
      } catch (error) {
        const status = httpStatusOf(error);
        const statusSuffix = status === undefined ? '' : ` with HTTP ${status}`;
        const message =
          `failed to list paths for ${owner}/${repo} at ${input.ref}${statusSuffix}` +
          ': GitHub git trees request failed';

        // Deliberately no `cause`: Octokit's RequestError keeps the outgoing
        // request (including the Authorization header) on the error object, so
        // re-exposing it would leak the installation token into logs
        // (architecture guardrail #2).
        // eslint-disable-next-line preserve-caught-error -- a `cause` here would carry the token
        throw new Error(message);
      }

      const paths = blobPaths(response.data);
      if (paths === null) {
        const status = httpStatusOf(response);
        const statusSuffix = status === undefined ? '' : ` (HTTP ${status})`;
        throw new Error(
          `unexpected git tree response${statusSuffix} for ${owner}/${repo} at ${input.ref}` +
            ': expected a tree entry list',
        );
      }

      // GitHub truncates the recursive listing (usually beyond ~100k entries),
      // and this client deliberately returns the partial list anyway: the root
      // manifests and lockfiles detection needs are listed first in practice, so
      // a truncated response still yields a usable file inventory. Repos big
      // enough to truncate would need a two-phase tree walk (list the root tree
      // non-recursively, then recurse per directory).
      return paths;
    },
  };
}
