/**
 * Downloads a repo tree at a ref as a tarball for the differential runner.
 *
 * `GET /repos/{owner}/{repo}/tarball/{ref}` answers 302 to a short-lived
 * `codeload.github.com` archive URL, which Octokit follows for us; the buffered
 * binary body is what the worker writes into the sandbox base tree. The token is
 * attached only to the API request here — the sandbox never sees it
 * (architecture guardrail #2, and the Phase 3 design note: the trusted worker
 * fetches content, the sandbox only receives bytes).
 *
 * Live-unverified seam: there is no GitHub App installation available on the
 * machine this was written on, so the redirect path and the exact body type
 * Octokit hands back after following it have only been exercised against fake
 * transports. Smoke-test this against a real installation before trusting it in
 * production.
 */

import type { Octokit } from '@octokit/core';

import type { RepoTarballClient } from '../runner/types.js';
import type { InstallationTokenSource } from './octokit.js';

const TARBALL_ROUTE = 'GET /repos/{owner}/{repo}/tarball/{ref}';

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
 * Converts the binary response body into bytes.
 *
 * Octokit's `request` buffers binary responses as an `ArrayBuffer`; a custom or
 * test transport may hand back a `Uint8Array` (Node's `Buffer` is one). Anything
 * else means the response was not the archive we asked for, and is rejected by
 * the caller rather than guessed at.
 */
function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  if (data instanceof Uint8Array) {
    return data;
  }

  return null;
}

/**
 * Builds the `RepoTarballClient`.
 *
 * The transport is auth-less (see `src/github/octokit.ts`), so the installation
 * token is attached per request here. Guardrail #2: the token is never logged
 * and never attached to a thrown error.
 */
export function createRepoTarballClient(
  octokit: Octokit,
  authenticator: InstallationTokenSource,
): RepoTarballClient {
  return async (input): Promise<Uint8Array> => {
    const [owner, repo] = input.repoFullName.split('/');
    if (!owner || !repo) {
      throw new Error(`invalid repoFullName: ${input.repoFullName}`);
    }

    const { token } = await authenticator.installation(input.installationId);

    let response: { status: number; data: unknown };
    try {
      response = await octokit.request(TARBALL_ROUTE, {
        owner,
        repo,
        ref: input.ref,
        headers: { authorization: `token ${token}` },
      });
    } catch (error) {
      const status = httpStatusOf(error);
      const statusSuffix = status === undefined ? '' : ` with HTTP ${status}`;
      const message =
        `failed to download tarball for ${owner}/${repo} at ${input.ref}${statusSuffix}` +
        ': GitHub tarball request failed';

      // Deliberately no `cause`: Octokit's RequestError keeps the outgoing
      // request (including the Authorization header) on the error object, so
      // re-exposing it would leak the installation token into logs
      // (architecture guardrail #2).
      // eslint-disable-next-line preserve-caught-error -- a `cause` here would carry the token
      throw new Error(message);
    }

    const bytes = toBytes(response.data);
    if (bytes === null || bytes.length === 0) {
      const status = httpStatusOf(response);
      const statusSuffix = status === undefined ? '' : ` (HTTP ${status})`;
      throw new Error(
        `unexpected tarball response${statusSuffix} for ${owner}/${repo} at ${input.ref}` +
          ': expected a non-empty binary archive',
      );
    }

    return bytes;
  };
}
