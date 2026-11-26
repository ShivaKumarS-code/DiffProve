import type { Octokit } from '@octokit/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createGitHubOAuthClient,
  type OAuthTokenFetch,
} from './user-auth.js';

const CLIENT_ID = 'Iv1.testclientid';
const CLIENT_SECRET = 'super-secret-oauth-client-secret-value';
const ACCESS_TOKEN = 'ghu_secretUserOAuthToken987654321';
const OTHER_ACCESS_TOKEN = 'ghu_anotherUserOAuthToken111222333';

function makeClient(options?: {
  cacheTtlMs?: number;
  tokenFetch?: OAuthTokenFetch;
}) {
  const request = vi.fn();
  const octokit = { request } as unknown as Octokit;
  const tokenFetch =
    options?.tokenFetch ??
    (vi.fn() as unknown as OAuthTokenFetch);

  const client = createGitHubOAuthClient({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    octokit,
    tokenFetch,
    cacheTtlMs: options?.cacheTtlMs,
  });

  return { client, request, tokenFetch: tokenFetch as unknown as ReturnType<typeof vi.fn> };
}

describe('createGitHubOAuthClient', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('authorizeUrl', () => {
    it('builds the GitHub authorize URL without a scope override', () => {
      const { client } = makeClient();
      const result = client.authorizeUrl({
        state: 'csrf-nonce-123',
        redirectUri: 'https://app.diffprove.dev/auth/callback',
      });

      const parsed = new URL(result);
      expect(parsed.origin + parsed.pathname).toBe(
        'https://github.com/login/oauth/authorize',
      );
      expect(parsed.searchParams.get('client_id')).toBe(CLIENT_ID);
      expect(parsed.searchParams.get('redirect_uri')).toBe(
        'https://app.diffprove.dev/auth/callback',
      );
      expect(parsed.searchParams.get('state')).toBe('csrf-nonce-123');
      expect(parsed.searchParams.has('scope')).toBe(false);
    });
  });

  describe('exchangeCode', () => {
    it('exchanges an authorization code for a user access token', async () => {
      const { client, tokenFetch } = makeClient();
      tokenFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ access_token: ACCESS_TOKEN, token_type: 'bearer' }),
      });

      const token = await client.exchangeCode(
        'oauth-code-abc',
        'https://app.diffprove.dev/auth/callback',
      );

      expect(token).toBe(ACCESS_TOKEN);
      expect(tokenFetch).toHaveBeenCalledTimes(1);
      const [url, init] = tokenFetch.mock.calls[0] as [
        string,
        { method: string; headers: Record<string, string>; body: string },
      ];
      expect(url).toBe('https://github.com/login/oauth/access_token');
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual({
        Accept: 'application/json',
        'Content-Type': 'application/json',
      });
      expect(JSON.parse(init.body)).toEqual({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: 'oauth-code-abc',
        redirect_uri: 'https://app.diffprove.dev/auth/callback',
      });
    });

    it('throws a clean error without leaking clientSecret on OAuth error or non-OK response', async () => {
      const { client, tokenFetch } = makeClient();

      tokenFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          error: 'bad_verification_code',
          error_description: 'The code passed is incorrect or expired.',
        }),
      });

      let thrown: unknown;
      try {
        await client.exchangeCode('expired-code', 'https://app.diffprove.dev/cb');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe(
        'GitHub OAuth token exchange failed: bad_verification_code',
      );
      expect((thrown as Error).message).not.toContain(CLIENT_SECRET);
      expect((thrown as Error).cause).toBeUndefined();

      tokenFetch.mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: async () => ({}),
      });
      await expect(
        client.exchangeCode('code', 'https://app.diffprove.dev/cb'),
      ).rejects.toThrow('GitHub OAuth token exchange failed: HTTP 502');

      tokenFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ token_type: 'bearer' }),
      });
      await expect(
        client.exchangeCode('code', 'https://app.diffprove.dev/cb'),
      ).rejects.toThrow('GitHub OAuth token exchange failed: missing access_token');

      tokenFetch.mockRejectedValueOnce(
        new Error(`request failed with body client_secret=${CLIENT_SECRET}`),
      );
      let networkErr: unknown;
      try {
        await client.exchangeCode('code', 'https://app.diffprove.dev/cb');
      } catch (err) {
        networkErr = err;
      }
      expect(networkErr).toBeInstanceOf(Error);
      expect((networkErr as Error).message).not.toContain(CLIENT_SECRET);
      expect((networkErr as Error).cause).toBeUndefined();
    });
  });

  describe('fetchUser', () => {
    it('fetches and normalizes the authenticated GitHub user', async () => {
      const { client, request } = makeClient();
      request.mockResolvedValueOnce({
        status: 200,
        data: {
          id: 101,
          login: 'octocat',
          avatar_url: 'https://avatars.githubusercontent.com/u/101',
        },
      });

      const user = await client.fetchUser(ACCESS_TOKEN);
      expect(user).toEqual({
        id: 101,
        login: 'octocat',
        avatarUrl: 'https://avatars.githubusercontent.com/u/101',
      });
      expect(request).toHaveBeenCalledWith('GET /user', {
        headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
      });

      request.mockResolvedValueOnce({
        status: 200,
        data: { id: 102, login: 'hubot', avatar_url: null },
      });
      await expect(client.fetchUser(ACCESS_TOKEN)).resolves.toEqual({
        id: 102,
        login: 'hubot',
        avatarUrl: null,
      });
    });

    it('wraps Octokit errors without cause and never leaks accessToken', async () => {
      const { client, request } = makeClient();
      request.mockRejectedValueOnce(
        Object.assign(new Error(`Unauthorized Bearer ${ACCESS_TOKEN}`), {
          status: 401,
          request: {
            headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
          },
        }),
      );

      let thrown: unknown;
      try {
        await client.fetchUser(ACCESS_TOKEN);
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain('HTTP 401');
      expect((thrown as Error).message).not.toContain(ACCESS_TOKEN);
      expect((thrown as Error).cause).toBeUndefined();
    });
  });

  describe('listAccessibleRepos', () => {
    it('paginates installations and repos, maps permissions and languages, deduplicates, and sorts', async () => {
      const { client, request } = makeClient();

      const page1Installations = Array.from({ length: 100 }, (_, i) => ({
        id: 1000 + i,
      }));
      const page1ReposFor1000 = Array.from({ length: 100 }, (_, i) => ({
        full_name: `org/repo-${String(i).padStart(3, '0')}`,
        permissions: { admin: i === 0, push: i === 1, pull: true },
        language: i === 0 ? 'Python' : i === 1 ? 'TypeScript' : 'Go',
      }));

      request.mockImplementation(
        async (route: string, params: Record<string, unknown>) => {
          if (route === 'GET /user/installations') {
            if (params.page === 1) {
              return { status: 200, data: { installations: page1Installations } };
            }
            return { status: 200, data: { installations: [{ id: 2000 }] } };
          }

          if (route === 'GET /user/installations/{installation_id}/repositories') {
            if (params.installation_id === 1000 && params.page === 1) {
              return { status: 200, data: { repositories: page1ReposFor1000 } };
            }
            if (params.installation_id === 1000 && params.page === 2) {
              return {
                status: 200,
                data: {
                  repositories: [
                    {
                      full_name: 'alpha/js-app',
                      permissions: { push: true },
                      language: 'JavaScript',
                    },
                    {
                      full_name: 'alpha/duplicate-repo',
                      permissions: { pull: true },
                      language: 'python',
                    },
                  ],
                },
              };
            }
            if (params.installation_id === 2000) {
              return {
                status: 200,
                data: {
                  repositories: [
                    {
                      full_name: 'alpha/duplicate-repo',
                      permissions: { admin: true },
                      language: 'Python',
                    },
                  ],
                },
              };
            }
            return { status: 200, data: { repositories: [] } };
          }

          throw new Error(`Unexpected route: ${route}`);
        },
      );

      const repos = await client.listAccessibleRepos(ACCESS_TOKEN);

      // 100 from page 1 + 2 from page 2 (one duplicated and upgraded via inst 2000) = 102
      expect(repos).toHaveLength(102);

      // Sorted lexicographically by repoFullName
      expect(repos[0]).toEqual({
        repoFullName: 'alpha/duplicate-repo',
        installationId: 2000,
        canWrite: true,
        languageHint: 'python',
      });
      expect(repos[1]).toEqual({
        repoFullName: 'alpha/js-app',
        installationId: 1000,
        canWrite: true,
        languageHint: 'node',
      });

      const repo0 = repos.find((r) => r.repoFullName === 'org/repo-000');
      const repo1 = repos.find((r) => r.repoFullName === 'org/repo-001');
      const repo2 = repos.find((r) => r.repoFullName === 'org/repo-002');
      expect(repo0).toEqual({
        repoFullName: 'org/repo-000',
        installationId: 1000,
        canWrite: true,
        languageHint: 'python',
      });
      expect(repo1).toEqual({
        repoFullName: 'org/repo-001',
        installationId: 1000,
        canWrite: true,
        languageHint: 'node',
      });
      expect(repo2).toEqual({
        repoFullName: 'org/repo-002',
        installationId: 1000,
        canWrite: false,
        languageHint: null,
      });

      // Verify pagination calls & Bearer header
      expect(request).toHaveBeenCalledWith('GET /user/installations', {
        per_page: 100,
        page: 1,
        headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
      });
      expect(request).toHaveBeenCalledWith('GET /user/installations', {
        per_page: 100,
        page: 2,
        headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
      });
      expect(request).toHaveBeenCalledWith(
        'GET /user/installations/{installation_id}/repositories',
        {
          installation_id: 1000,
          per_page: 100,
          page: 2,
          headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
        },
      );
    });

    it('caches results for 30 seconds per hashed access token and refreshes after expiry', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

      const { client, request } = makeClient();
      request.mockImplementation(async (route: string) => {
        if (route === 'GET /user/installations') {
          return { status: 200, data: { installations: [{ id: 1 }] } };
        }
        return {
          status: 200,
          data: {
            repositories: [
              {
                full_name: 'octocat/hello-world',
                permissions: { push: true },
                language: 'TypeScript',
              },
            ],
          },
        };
      });

      const first = await client.listAccessibleRepos(ACCESS_TOKEN);
      expect(first).toHaveLength(1);
      expect(request).toHaveBeenCalledTimes(2);

      // Within 30s TTL -> served from cache
      vi.advanceTimersByTime(29_999);
      const second = await client.listAccessibleRepos(ACCESS_TOKEN);
      expect(second).toEqual(first);
      expect(request).toHaveBeenCalledTimes(2);

      // Different user token -> separate cache entry
      await client.listAccessibleRepos(OTHER_ACCESS_TOKEN);
      expect(request).toHaveBeenCalledTimes(4);

      // Past 30s TTL -> cache expires and re-fetches
      vi.advanceTimersByTime(1);
      await client.listAccessibleRepos(ACCESS_TOKEN);
      expect(request).toHaveBeenCalledTimes(6);
    });

    it('wraps Octokit errors during repo listing without leaking accessToken or cause', async () => {
      const { client, request } = makeClient();
      request.mockRejectedValueOnce(
        Object.assign(new Error(`Forbidden for Bearer ${ACCESS_TOKEN}`), {
          status: 403,
          request: {
            headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
          },
        }),
      );

      let thrown: unknown;
      try {
        await client.listAccessibleRepos(ACCESS_TOKEN);
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain('HTTP 403');
      expect((thrown as Error).message).not.toContain(ACCESS_TOKEN);
      expect((thrown as Error).cause).toBeUndefined();
    });
  });
});
