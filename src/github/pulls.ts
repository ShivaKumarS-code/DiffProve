/**
 * Fetches the unified PR diff for a single verification job.
 *
 * Contract (docs/architecture.md, "End-to-End Verification Pipeline", step 2):
 * the worker pulls the PR diff through
 * `GET /repos/{owner}/{repo}/compare/{base}...{head}` negotiated as
 * `application/vnd.github.diff`. The range is sha-pinned to the job's two
 * commits, so a push to the PR after the job was queued cannot change what the
 * job verifies.
 */

import type { Octokit } from '@octokit/core';

import type { PrDiffClient, PrDiffRequest } from '../diff/types.js';
import type { InstallationTokenSource } from './octokit.js';

const COMPARE_ROUTE = 'GET /repos/{owner}/{repo}/compare/{basehead}';

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
 * Builds the `PrDiffClient`.
 *
 * The transport is auth-less (see `src/github/octokit.ts`), so the installation
 * token is attached per request here. Guardrail #2: the token is never logged
 * and never attached to a thrown error.
 */
export function createPrDiffClient(
  octokit: Octokit,
  authenticator: InstallationTokenSource,
): PrDiffClient {
  return async (input: PrDiffRequest): Promise<string> => {
    const [owner, repo] = input.repoFullName.split('/');
    if (!owner || !repo) {
      throw new Error(`invalid repoFullName: ${input.repoFullName}`);
    }

    const { token } = await authenticator.installation(input.installationId);
    const basehead = `${input.baseSha}...${input.headSha}`;

    // Octokit's route types describe the JSON representation, but the `accept`
    // header below makes GitHub answer with the raw diff, so the body is
    // deliberately treated as `unknown` until the runtime guard proves it is a
    // string.
    let response: { status: number; data: unknown };
    try {
      response = await octokit.request(COMPARE_ROUTE, {
        owner,
        repo,
        basehead,
        headers: {
          accept: 'application/vnd.github.diff',
          authorization: `token ${token}`,
        },
      });
    } catch (error) {
      const status = httpStatusOf(error);
      const statusSuffix = status === undefined ? '' : ` with HTTP ${status}`;
      const message =
        `failed to fetch PR diff for ${owner}/${repo} (${basehead})${statusSuffix}` +
        ': GitHub compare request failed';

      // Deliberately no `cause`: Octokit's RequestError keeps the outgoing
      // request (including the Authorization header) on the error object, so
      // re-exposing it would leak the installation token into logs
      // (architecture guardrail #2).
      // eslint-disable-next-line preserve-caught-error -- a `cause` here would carry the token
      throw new Error(message);
    }

    if (typeof response.data !== 'string') {
      const status = httpStatusOf(response);
      const statusSuffix = status === undefined ? '' : ` (HTTP ${status})`;
      throw new Error(
        `GitHub compare returned a non-diff body${statusSuffix} for ${owner}/${repo}`,
      );
    }

    return response.data;
  };
}
