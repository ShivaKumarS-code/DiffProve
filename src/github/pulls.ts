/**
 * Fetches the unified PR diff and its merge base for a single verification job.
 *
 * Contract (docs/architecture.md, "End-to-End Verification Pipeline", step 2):
 * the worker calls `GET /repos/{owner}/{repo}/compare/{base}...{head}` for
 * merge-base metadata (JSON) and the patch (`application/vnd.github.diff`).
 * Both requests pin the job's two commits, so a later push to the PR cannot
 * change what the job verifies.
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

/** Reads the full commit SHA that GitHub used as the three-dot diff's base. */
function readMergeBaseSha(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null || !('merge_base_commit' in data)) {
    return undefined;
  }
  const commit = data.merge_base_commit;
  if (typeof commit !== 'object' || commit === null || !('sha' in commit)) {
    return undefined;
  }
  const sha = commit.sha;
  return typeof sha === 'string' && /^[0-9a-f]{40}$/i.test(sha) ? sha : undefined;
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
  return async (input: PrDiffRequest) => {
    const [owner, repo] = input.repoFullName.split('/');
    if (!owner || !repo) {
      throw new Error(`invalid repoFullName: ${input.repoFullName}`);
    }

    const { token } = await authenticator.installation(input.installationId);
    const basehead = `${input.baseSha}...${input.headSha}`;

    // Octokit's response type describes JSON even for the diff media type.
    // Validate both response bodies at the transport boundary.
    async function fetchCompare(format: 'json' | 'diff'): Promise<{ status: number; data: unknown }> {
      try {
        return await octokit.request(COMPARE_ROUTE, {
          owner,
          repo,
          basehead,
          // Only the merge-base metadata is needed from JSON, not the commits.
          ...(format === 'json' ? { per_page: 1 } : {}),
          headers: {
            accept: `application/vnd.github.${format}`,
            authorization: `token ${token}`,
          },
        });
      } catch (error) {
        const status = httpStatusOf(error);
        const statusSuffix = status === undefined ? '' : ` with HTTP ${status}`;
        const message =
          `failed to fetch PR compare ${format} for ${owner}/${repo} (${basehead})${statusSuffix}` +
          ': GitHub compare request failed';

        // Deliberately no `cause`: Octokit's RequestError keeps the outgoing
        // request (including the Authorization header) on the error object, so
        // re-exposing it would leak the installation token into logs.
        // eslint-disable-next-line preserve-caught-error -- a `cause` here would carry the token
        throw new Error(message);
      }
    }

    const metadata = await fetchCompare('json');
    const mergeBaseSha = readMergeBaseSha(metadata.data);
    if (mergeBaseSha === undefined) {
      throw new Error(
        `GitHub compare returned an invalid merge_base_commit.sha (HTTP ${metadata.status}) ` +
          `for ${owner}/${repo} (${basehead})`,
      );
    }

    const response = await fetchCompare('diff');
    if (typeof response.data !== 'string') {
      const status = httpStatusOf(response);
      const statusSuffix = status === undefined ? '' : ` (HTTP ${status})`;
      throw new Error(
        `GitHub compare returned a non-diff body${statusSuffix} for ${owner}/${repo}`,
      );
    }

    return { diff: response.data, mergeBaseSha };
  };
}
