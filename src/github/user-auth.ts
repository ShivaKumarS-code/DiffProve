/**
 * GitHub App User-to-Server OAuth client.
 *
 * Handles the browser OAuth flow (`authorizeUrl`, `exchangeCode`), user profile
 * lookup (`fetchUser`), and installation-scoped repository discovery
 * (`listAccessibleRepos`) with a short in-memory cache keyed by SHA-256 of the
 * access token.
 *
 * Guardrail #2: `clientSecret` and user `accessToken` values are never logged
 * and never attached (directly or via `cause`) to thrown errors.
 */

import { createHash } from 'node:crypto';

import type { Octokit } from '@octokit/core';

import type { SessionUser } from '../auth/session.js';
import { createOctokit } from './octokit.js';

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_ROUTE = 'GET /user';
const USER_INSTALLATIONS_ROUTE = 'GET /user/installations';
const USER_INSTALLATION_REPOS_ROUTE =
  'GET /user/installations/{installation_id}/repositories';
const PER_PAGE = 100;
const DEFAULT_CACHE_TTL_MS = 30_000;

export interface AccessibleRepo {
  repoFullName: string;
  installationId: number;
  canWrite: boolean;
  languageHint: 'python' | 'node' | null;
}

export interface GitHubOAuthClient {
  authorizeUrl(params: { state: string; redirectUri: string }): string;
  exchangeCode(code: string, redirectUri: string): Promise<string>;
  fetchUser(accessToken: string): Promise<SessionUser>;
  listAccessibleRepos(accessToken: string): Promise<AccessibleRepo[]>;
}

export type OAuthTokenFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface CreateGitHubOAuthClientOptions {
  clientId: string;
  clientSecret: string;
  octokit?: Octokit;
  tokenFetch?: OAuthTokenFetch;
  cacheTtlMs?: number;
}

interface CacheEntry {
  repos: AccessibleRepo[];
  expiresAt: number;
}

interface RawInstallation {
  id?: unknown;
}

interface RawRepo {
  full_name?: unknown;
  permissions?: {
    admin?: unknown;
    push?: unknown;
  } | null;
  language?: unknown;
}

function httpStatusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const candidate = error as { status?: unknown; response?: { status?: unknown } };
  const status = candidate.status ?? candidate.response?.status;

  return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
}

function hashToken(accessToken: string): string {
  return createHash('sha256').update(accessToken, 'utf8').digest('hex');
}

function toLanguageHint(language: unknown): 'python' | 'node' | null {
  if (typeof language !== 'string') {
    return null;
  }

  const normalized = language.trim().toLowerCase();
  if (normalized === 'python') {
    return 'python';
  }
  if (normalized === 'typescript' || normalized === 'javascript') {
    return 'node';
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Builds the GitHub App User OAuth client.
 */
export function createGitHubOAuthClient(
  opts: CreateGitHubOAuthClientOptions,
): GitHubOAuthClient {
  const octokit = opts.octokit ?? createOctokit();
  const tokenFetch: OAuthTokenFetch = opts.tokenFetch ?? fetch;
  const cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const repoCache = new Map<string, CacheEntry>();

  function pruneExpiredCache(nowMs: number): void {
    for (const [key, entry] of repoCache.entries()) {
      if (entry.expiresAt <= nowMs) {
        repoCache.delete(key);
      }
    }
  }

  async function requestWithUserToken(
    route: string,
    accessToken: string,
    params: Record<string, unknown>,
    failureContext: string,
  ): Promise<unknown> {
    try {
      const response = await octokit.request(route, {
        ...params,
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      });
      return response.data;
    } catch (error) {
      const status = httpStatusOf(error);
      const statusSuffix = status === undefined ? '' : ` with HTTP ${status}`;
      // Deliberately no `cause`: Octokit's RequestError retains outgoing
      // request headers (including `Authorization: Bearer ...`), which would
      // leak the user's OAuth token (architecture guardrail #2).
      // eslint-disable-next-line preserve-caught-error -- a `cause` here would carry the access token
      throw new Error(`${failureContext}${statusSuffix}`);
    }
  }

  return {
    authorizeUrl({ state, redirectUri }): string {
      const url = new URL(AUTHORIZE_URL);
      url.searchParams.set('client_id', opts.clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', state);
      return url.toString();
    },

    async exchangeCode(code: string, redirectUri: string): Promise<string> {
      let res: { ok: boolean; status: number; json(): Promise<unknown> };
      try {
        res = await tokenFetch(ACCESS_TOKEN_URL, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            client_id: opts.clientId,
            client_secret: opts.clientSecret,
            code,
            redirect_uri: redirectUri,
          }),
        });
      } catch {
        // Deliberately no `cause`: transport errors may attach the request body
        // containing `client_secret` (architecture guardrail #2).
        throw new Error('GitHub OAuth token exchange failed: request error');
      }

      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new Error(
          `GitHub OAuth token exchange failed: invalid response (HTTP ${res.status})`,
        );
      }

      const data = isObject(body) ? body : {};
      const errorCode =
        typeof data.error === 'string' && data.error.length > 0
          ? data.error
          : undefined;

      if (!res.ok || errorCode) {
        const detail = errorCode
          ? res.ok
            ? errorCode
            : `HTTP ${res.status} (${errorCode})`
          : `HTTP ${res.status}`;
        throw new Error(`GitHub OAuth token exchange failed: ${detail}`);
      }

      if (typeof data.access_token !== 'string' || data.access_token.length === 0) {
        throw new Error('GitHub OAuth token exchange failed: missing access_token');
      }

      return data.access_token;
    },

    async fetchUser(accessToken: string): Promise<SessionUser> {
      const data = await requestWithUserToken(
        USER_ROUTE,
        accessToken,
        {},
        'GitHub user lookup failed',
      );

      if (!isObject(data) || data.id === undefined || data.login === undefined) {
        throw new Error('GitHub user lookup failed: malformed user payload');
      }

      const id = Number(data.id);
      const login = String(data.login);
      if (!Number.isFinite(id) || login.length === 0) {
        throw new Error('GitHub user lookup failed: malformed user payload');
      }

      return {
        id,
        login,
        avatarUrl: typeof data.avatar_url === 'string' ? data.avatar_url : null,
      };
    },

    async listAccessibleRepos(accessToken: string): Promise<AccessibleRepo[]> {
      const nowMs = Date.now();
      const cacheKey = hashToken(accessToken);

      if (cacheTtlMs > 0) {
        const cached = repoCache.get(cacheKey);
        if (cached) {
          if (cached.expiresAt > nowMs) {
            return cached.repos.map((repo) => ({ ...repo }));
          }
          repoCache.delete(cacheKey);
        }
      }

      const installationIds: number[] = [];
      for (let page = 1; ; page += 1) {
        const data = await requestWithUserToken(
          USER_INSTALLATIONS_ROUTE,
          accessToken,
          { per_page: PER_PAGE, page },
          'GitHub user installations lookup failed',
        );

        const rawInstallations =
          isObject(data) && Array.isArray(data.installations)
            ? (data.installations as RawInstallation[])
            : [];

        for (const inst of rawInstallations) {
          if (typeof inst?.id === 'number' && Number.isFinite(inst.id)) {
            installationIds.push(inst.id);
          }
        }

        if (rawInstallations.length < PER_PAGE) {
          break;
        }
      }

      const byRepoFullName = new Map<string, AccessibleRepo>();
      for (const installationId of installationIds) {
        for (let page = 1; ; page += 1) {
          const data = await requestWithUserToken(
            USER_INSTALLATION_REPOS_ROUTE,
            accessToken,
            { installation_id: installationId, per_page: PER_PAGE, page },
            `GitHub installation ${installationId} repositories lookup failed`,
          );

          const rawRepos =
            isObject(data) && Array.isArray(data.repositories)
              ? (data.repositories as RawRepo[])
              : [];

          for (const rawRepo of rawRepos) {
            if (typeof rawRepo?.full_name !== 'string' || rawRepo.full_name.length === 0) {
              continue;
            }

            const entry: AccessibleRepo = {
              repoFullName: rawRepo.full_name,
              installationId,
              canWrite: Boolean(
                rawRepo.permissions?.admin || rawRepo.permissions?.push,
              ),
              languageHint: toLanguageHint(rawRepo.language),
            };

            const existing = byRepoFullName.get(entry.repoFullName);
            if (!existing || (!existing.canWrite && entry.canWrite)) {
              byRepoFullName.set(entry.repoFullName, entry);
            }
          }

          if (rawRepos.length < PER_PAGE) {
            break;
          }
        }
      }

      const repos = Array.from(byRepoFullName.values()).sort((a, b) =>
        a.repoFullName < b.repoFullName ? -1 : a.repoFullName > b.repoFullName ? 1 : 0,
      );

      if (cacheTtlMs > 0) {
        pruneExpiredCache(nowMs);
        repoCache.set(cacheKey, {
          repos,
          expiresAt: Date.now() + cacheTtlMs,
        });
      }

      return repos.map((repo) => ({ ...repo }));
    },
  };
}
