/**
 * Integration-style tests for the HTTP boundary: the GitHub webhook receiver
 * and the dashboard JSON API.
 *
 * Everything runs in-process through `fastify.inject`: no network, no Redis,
 * no PostgreSQL, no GitHub. The queue, check-run, installation, and DB store
 * ports are vi.fn doubles, so each test can assert both the response and the
 * side effects (including their absence for rejected deliveries).
 */

import { createHmac } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthDeps } from './api/auth-routes.js';
import type { ApiDeps } from './api/routes.js';
import { buildApp } from './app.js';
import {
  encryptSession,
  OAUTH_STATE_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  type SessionUser,
} from './auth/session.js';
import type { RepositoryRow, RunHistorySummary, VerificationRunRow } from './db/types.js';
import type { AccessibleRepo, GitHubOAuthClient } from './github/user-auth.js';

const WEBHOOK_SECRET = 'test-secret';

/**
 * GitHub's canonical signed payload for these tests: sign the EXACT string that
 * is sent, never a re-serialization of the decoded object.
 */
const payload = JSON.stringify({
  action: 'opened',
  number: 7,
  pull_request: { number: 7, head: { sha: 'aaa111' }, base: { sha: 'bbb222' } },
  repository: { full_name: 'octocat/hello-world' },
  installation: { id: 42 },
});

/** `sha256=<hex>` the way GitHub computes it: HMAC over the raw UTF-8 bytes. */
function sign(body: string, secret: string = WEBHOOK_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

const enqueue = vi.fn(async (): Promise<{ jobId: string }> => ({ jobId: 'job-1' }));

/** Installation persistence double (webhook `installation` events). */
const upsertInstallation = vi.fn(async (): Promise<void> => {});
const removeInstallation = vi.fn(async (): Promise<void> => {});

/**
 * DB store doubles. `vi.fn()` is unparameterised on purpose: each test installs
 * the resolved value it needs, and the assertions below check call arguments.
 */
const ensureRepository = vi.fn();
const getRepository = vi.fn();
const listRepositories = vi.fn();
const updateRepositoryConfig = vi.fn();
const insertRun = vi.fn();
const listRuns = vi.fn();

/** The dashboard API dependency set under test. */
const api: ApiDeps = {
  repositories: { ensureRepository, getRepository, listRepositories, updateRepositoryConfig },
  runs: { insertRun, listRuns },
};

const REPO_ID = '11111111-1111-4111-8111-111111111111';
const UNKNOWN_REPO_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';

const repositoryRow: RepositoryRow = {
  id: REPO_ID,
  installationId: null,
  repoFullName: 'octocat/hello-world',
  language: 'node',
  testCommand: null,
  testFileGlobs: null,
  enabled: true,
  createdAt: new Date('2026-01-02T03:04:05.000Z'),
};

const runRow: VerificationRunRow = {
  id: RUN_ID,
  repositoryId: REPO_ID,
  prNumber: 7,
  baseSha: 'bbb222',
  headSha: 'aaa111',
  changedTestFiles: ['test/greeting.test.ts'],
  runAStatus: 'pass',
  runBStatus: 'fail',
  verdict: 'weak-test',
  durationMs: 1234,
  runALog: 'run a log',
  runBLog: 'run b log',
  createdAt: new Date('2026-01-03T04:05:06.000Z'),
};

const runSummary: RunHistorySummary = {
  runs: [runRow],
  totalRuns: 2,
  weakTestCount: 1,
  catchRate: 0.5,
};

/** The webhook app, also used to prove the API's unconfigured-database mode. */
let app: FastifyInstance;

/** The same app with the dashboard API stores injected. */
let apiApp: FastifyInstance;

interface PostOptions {
  body: string;
  event?: string;
  signature?: string;
}

function postWebhook(options: PostOptions) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.event !== undefined) {
    headers['x-github-event'] = options.event;
  }
  if (options.signature !== undefined) {
    headers['x-hub-signature-256'] = options.signature;
  }

  return app.inject({
    method: 'POST',
    url: '/webhooks/github',
    headers,
    payload: options.body,
  });
}

beforeAll(() => {
  app = buildApp({
    webhookSecret: WEBHOOK_SECRET,
    enqueuer: { enqueue },
    installations: { upsertInstallation, removeInstallation },
    // Keep test output free of per-request pino lines; the app's default level
    // is covered implicitly by buildApp's own defaulting.
    logLevel: 'silent',
  });

  apiApp = buildApp({
    webhookSecret: WEBHOOK_SECRET,
    enqueuer: { enqueue },
    api,
    logLevel: 'silent',
  });
});

beforeEach(() => {
  enqueue.mockClear();
  upsertInstallation.mockClear();
  removeInstallation.mockClear();
});

afterAll(async () => {
  await app.close();
  await apiApp.close();
});

describe('POST /webhooks/github', () => {
  it('acknowledges the durable queue job for an opened PR', async () => {
    const response = await postWebhook({
      event: 'pull_request',
      signature: sign(payload),
      body: payload,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ message: expect.stringContaining('job-1') });

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith({
      repoFullName: 'octocat/hello-world',
      prNumber: 7,
      installationId: 42,
      baseSha: 'bbb222',
      headSha: 'aaa111',
    });
  });

  it('returns a generic 500 when durable enqueue fails', async () => {
    enqueue.mockRejectedValueOnce(new Error('private queue details'));
    const response = await postWebhook({
      event: 'pull_request',
      signature: sign(payload),
      body: payload,
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ message: 'failed to enqueue verification job' });
  });

  it('rejects a signature computed with a different secret', async () => {
    const response = await postWebhook({
      event: 'pull_request',
      signature: sign(payload, 'some-other-secret'),
      body: payload,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ message: 'invalid webhook signature' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects a body tampered with after signing', async () => {
    // One character changed, still valid JSON: only the HMAC can catch it.
    const tampered = payload.replace('aaa111', 'aaa112');
    expect(tampered).not.toBe(payload);

    const response = await postWebhook({
      event: 'pull_request',
      signature: sign(payload),
      body: tampered,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ message: 'invalid webhook signature' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('answers a signed ping with pong', async () => {
    const pingPayload = JSON.stringify({ zen: 'Non-blocking design', hook_id: 1 });

    const response = await postWebhook({
      event: 'ping',
      signature: sign(pingPayload),
      body: pingPayload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ message: 'pong' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('ignores pull_request actions it does not verify', async () => {
    const closedPayload = payload.replace('"action":"opened"', '"action":"closed"');

    const response = await postWebhook({
      event: 'pull_request',
      signature: sign(closedPayload),
      body: closedPayload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ message: 'ignored pull_request closed' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('ignores deliveries without an x-github-event header', async () => {
    const response = await postWebhook({
      signature: sign(payload),
      body: payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ message: 'ignored unknown' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('acknowledges installation events without side effects', async () => {
    const installationPayload = JSON.stringify({
      action: 'created',
      installation: { id: 42, account: { login: 'octocat' } },
    });

    const response = await postWebhook({
      event: 'installation',
      signature: sign(installationPayload),
      body: installationPayload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ message: 'installation created acknowledged' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('persists the installation record for a signed installation created event', async () => {
    const installationPayload = JSON.stringify({
      action: 'created',
      installation: { id: 42, account: { login: 'octocat' } },
    });

    const response = await postWebhook({
      event: 'installation',
      signature: sign(installationPayload),
      body: installationPayload,
    });

    expect(response.statusCode).toBe(200);
    expect(upsertInstallation).toHaveBeenCalledTimes(1);
    expect(upsertInstallation).toHaveBeenCalledWith({
      githubInstallationId: 42,
      accountLogin: 'octocat',
    });
  });

  it('accepts payloads larger than the default 1 MiB body limit', async () => {
    // GitHub PR payloads carry the PR body and diff stats, so the webhook parser
    // opts into 5 MiB; this proves the larger limit is actually in force.
    const largePayload = JSON.stringify({
      action: 'opened',
      number: 7,
      pull_request: {
        number: 7,
        head: { sha: 'aaa111' },
        base: { sha: 'bbb222' },
        body: 'x'.repeat(2 * 1024 * 1024),
      },
      repository: { full_name: 'octocat/hello-world' },
      installation: { id: 42 },
    });
    expect(Buffer.byteLength(largePayload, 'utf8')).toBeGreaterThan(1024 * 1024);

    const response = await postWebhook({
      event: 'pull_request',
      signature: sign(largePayload),
      body: largePayload,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ message: expect.stringContaining('job-1') });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('returns 400 for malformed JSON even when the signature matches the bytes', async () => {
    const malformed = 'not-json';

    const response = await postWebhook({
      event: 'ping',
      signature: sign(malformed),
      body: malformed,
    });

    expect(response.statusCode).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('hashes the raw UTF-8 bytes of a multi-byte body', async () => {
    const unicodePayload = JSON.stringify({ zen: 'héllo', hook_id: 1 });
    // Proves the payload really contains multi-byte characters: byte length
    // differs from UTF-16 string length.
    expect(Buffer.byteLength(unicodePayload, 'utf8')).toBeGreaterThan(unicodePayload.length);

    const response = await postWebhook({
      event: 'ping',
      signature: sign(unicodePayload),
      body: unicodePayload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ message: 'pong' });
  });

  it('rejects deliveries that bypass the JSON parser (no raw body captured)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'text/plain',
        'x-github-event': 'ping',
        'x-hub-signature-256': sign(payload),
      },
      payload: payload,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ message: 'invalid webhook signature' });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('GET /healthz', () => {
  it('reports ok', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});

describe('dashboard API', () => {
  beforeEach(() => {
    // Reset call history and re-install the default store behaviour; individual
    // tests override it with `mockResolvedValueOnce`.
    vi.clearAllMocks();
    listRepositories.mockResolvedValue([repositoryRow]);
    getRepository.mockResolvedValue(repositoryRow);
    updateRepositoryConfig.mockResolvedValue(repositoryRow);
    listRuns.mockResolvedValue(runSummary);
  });

  describe('GET /api/repos', () => {
    it('lists repositories for the dashboard', async () => {
      const response = await apiApp.inject({ method: 'GET', url: '/api/repos' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        repos: [{ ...repositoryRow, createdAt: repositoryRow.createdAt.toISOString() }],
      });
      expect(listRepositories).toHaveBeenCalledTimes(1);
    });

    it('answers 500 when the store fails (errors propagate to the app)', async () => {
      listRepositories.mockRejectedValueOnce(new Error('connection refused'));

      const response = await apiApp.inject({ method: 'GET', url: '/api/repos' });

      expect(response.statusCode).toBe(500);
    });
  });

  describe('GET /api/repos/:id/runs', () => {
    it('returns the repository, run history, and weak-test catch rate', async () => {
      const response = await apiApp.inject({
        method: 'GET',
        url: `/api/repos/${REPO_ID}/runs`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        repository: { ...repositoryRow, createdAt: repositoryRow.createdAt.toISOString() },
        runs: [{ ...runRow, createdAt: runRow.createdAt.toISOString() }],
        totalRuns: 2,
        weakTestCount: 1,
        catchRate: 0.5,
      });
      expect(getRepository).toHaveBeenCalledWith(REPO_ID);
      // No `?limit=`: the documented default page size applies.
      expect(listRuns).toHaveBeenCalledWith(REPO_ID, 50);
    });

    it('answers 404 for an unknown repository', async () => {
      getRepository.mockResolvedValueOnce(null);

      const response = await apiApp.inject({
        method: 'GET',
        url: `/api/repos/${UNKNOWN_REPO_ID}/runs`,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ message: 'repository not found' });
      expect(listRuns).not.toHaveBeenCalled();
    });

    it('rejects a malformed repository id without touching the store', async () => {
      const response = await apiApp.inject({
        method: 'GET',
        url: '/api/repos/not-a-uuid/runs',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ message: 'invalid repository id' });
      expect(getRepository).not.toHaveBeenCalled();
      expect(listRuns).not.toHaveBeenCalled();
    });

    it('rejects a non-numeric limit', async () => {
      const response = await apiApp.inject({
        method: 'GET',
        url: `/api/repos/${REPO_ID}/runs?limit=abc`,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ message: 'invalid limit' });
      expect(listRuns).not.toHaveBeenCalled();
    });

    it('clamps a limit above the maximum to 200', async () => {
      const response = await apiApp.inject({
        method: 'GET',
        url: `/api/repos/${REPO_ID}/runs?limit=500`,
      });

      expect(response.statusCode).toBe(200);
      expect(listRuns).toHaveBeenCalledWith(REPO_ID, 200);
    });
  });

  describe('PATCH /api/repos/:id/config', () => {
    it('applies overrides and returns the updated repository', async () => {
      const overrides = {
        testCommand: 'npx vitest run {file}',
        testFileGlobs: ['test/**/*.test.ts'],
        enabled: false,
      };
      const updatedRow: RepositoryRow = { ...repositoryRow, ...overrides };
      updateRepositoryConfig.mockResolvedValueOnce(updatedRow);

      const response = await apiApp.inject({
        method: 'PATCH',
        url: `/api/repos/${REPO_ID}/config`,
        payload: overrides,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        repository: { ...updatedRow, createdAt: updatedRow.createdAt.toISOString() },
      });
      expect(updateRepositoryConfig).toHaveBeenCalledTimes(1);
      expect(updateRepositoryConfig).toHaveBeenCalledWith(REPO_ID, overrides);
    });

    it('answers 404 for an unknown repository', async () => {
      updateRepositoryConfig.mockResolvedValueOnce(null);

      const response = await apiApp.inject({
        method: 'PATCH',
        url: `/api/repos/${UNKNOWN_REPO_ID}/config`,
        payload: { enabled: false },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ message: 'repository not found' });
    });

    it('rejects an invalid body before reaching the store', async () => {
      const response = await apiApp.inject({
        method: 'PATCH',
        url: `/api/repos/${REPO_ID}/config`,
        payload: { enabled: 'yes' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toEqual(expect.stringContaining('enabled'));
      expect(updateRepositoryConfig).not.toHaveBeenCalled();
    });

    it('rejects a malformed repository id before validating the body', async () => {
      const response = await apiApp.inject({
        method: 'PATCH',
        url: '/api/repos/not-a-uuid/config',
        payload: { enabled: false },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ message: 'invalid repository id' });
      expect(updateRepositoryConfig).not.toHaveBeenCalled();
    });

    it('clears an override when a field is explicitly null', async () => {
      updateRepositoryConfig.mockResolvedValueOnce({ ...repositoryRow, testCommand: null });

      const response = await apiApp.inject({
        method: 'PATCH',
        url: `/api/repos/${REPO_ID}/config`,
        payload: { testCommand: null },
      });

      expect(response.statusCode).toBe(200);
      expect(updateRepositoryConfig).toHaveBeenCalledWith(REPO_ID, { testCommand: null });

      // `null` must survive as an explicit value: the store reads presence to
      // decide between "clear the override" and "leave it untouched".
      const sentConfig = updateRepositoryConfig.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(Object.hasOwn(sentConfig, 'testCommand')).toBe(true);
      expect(sentConfig.testCommand).toBeNull();
    });
  });

  describe('when the database is not configured', () => {
    it('answers 503 on every /api route instead of pretending', async () => {
      // `app` was built without `api` (and without `installations`), which is
      // exactly the shape server.ts uses when DATABASE_URL is unset.
      const responses = [
        await app.inject({ method: 'GET', url: '/api/repos' }),
        await app.inject({ method: 'GET', url: `/api/repos/${REPO_ID}/runs` }),
        await app.inject({
          method: 'PATCH',
          url: `/api/repos/${REPO_ID}/config`,
          payload: { enabled: false },
        }),
      ];

      for (const response of responses) {
        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({
          message: 'database not configured (set DATABASE_URL)',
        });
      }
    });
  });
});

describe('GitHub OAuth and per-repo authorization', () => {
  const SESSION_SECRET = 'test-session-secret-at-least-16-chars';
  const PUBLIC_URL = 'https://diffprove.example.com';

  const testUser: SessionUser = {
    id: 101,
    login: 'octocat',
    avatarUrl: 'https://avatars.githubusercontent.com/u/101',
  };

  const accessibleRepoA: AccessibleRepo = {
    repoFullName: 'octocat/alpha-repo',
    installationId: 42,
    canWrite: false,
    languageHint: 'python',
  };

  const accessibleRepoB: AccessibleRepo = {
    repoFullName: 'octocat/hello-world',
    installationId: 42,
    canWrite: true,
    languageHint: 'node',
  };

  const alphaRepoRow: RepositoryRow = {
    ...repositoryRow,
    id: '44444444-4444-4444-8444-444444444444',
    repoFullName: 'octocat/alpha-repo',
    language: 'python',
  };

  const inaccessibleRepoRow: RepositoryRow = {
    ...repositoryRow,
    id: UNKNOWN_REPO_ID,
    repoFullName: 'stranger/private-repo',
  };

  const authorizeUrl = vi.fn(
    ({ state, redirectUri }: { state: string; redirectUri: string }) =>
      `https://github.com/login/oauth/authorize?client_id=cid&redirect_uri=${encodeURIComponent(
        redirectUri,
      )}&state=${encodeURIComponent(state)}`,
  );
  const exchangeCode = vi.fn<GitHubOAuthClient['exchangeCode']>();
  const fetchUser = vi.fn<GitHubOAuthClient['fetchUser']>();
  const listAccessibleRepos = vi.fn<GitHubOAuthClient['listAccessibleRepos']>();

  const auth: AuthDeps = {
    sessionSecret: SESSION_SECRET,
    githubOAuth: {
      authorizeUrl,
      exchangeCode,
      fetchUser,
      listAccessibleRepos,
    },
    publicUrl: PUBLIC_URL,
  };

  let oauthApp: FastifyInstance;

  function setCookieHeaders(raw: string | string[] | undefined): string[] {
    if (raw === undefined) {
      return [];
    }
    return Array.isArray(raw) ? raw : [raw];
  }

  function createSessionCookie(accessToken: string = 'ghu_test_token'): string {
    const token = encryptSession(
      {
        user: testUser,
        accessToken,
        exp: Date.now() + 60_000,
      },
      SESSION_SECRET,
    );
    return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`;
  }

  beforeAll(() => {
    oauthApp = buildApp({
      webhookSecret: WEBHOOK_SECRET,
      enqueuer: { enqueue },
      api,
      auth,
      logLevel: 'silent',
    });
  });

  afterAll(async () => {
    await oauthApp.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    exchangeCode.mockResolvedValue('ghu_fresh_token');
    fetchUser.mockResolvedValue(testUser);
    listAccessibleRepos.mockResolvedValue([accessibleRepoB, accessibleRepoA]);
    ensureRepository.mockImplementation(async ({ repoFullName }) =>
      repoFullName === alphaRepoRow.repoFullName ? alphaRepoRow : repositoryRow,
    );
    getRepository.mockResolvedValue(repositoryRow);
    updateRepositoryConfig.mockResolvedValue(repositoryRow);
    listRuns.mockResolvedValue(runSummary);
  });

  it('reports oauthEnabled: false on GET /api/auth/session when OAuth is disabled', async () => {
    const response = await apiApp.inject({ method: 'GET', url: '/api/auth/session' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ oauthEnabled: false, user: null });
  });

  it('returns 503 on /api/auth/login and /api/auth/callback when OAuth is disabled', async () => {
    const loginRes = await apiApp.inject({ method: 'GET', url: '/api/auth/login' });
    const callbackRes = await apiApp.inject({
      method: 'GET',
      url: '/api/auth/callback?code=abc&state=xyz',
    });

    expect(loginRes.statusCode).toBe(503);
    expect(loginRes.json()).toEqual({ message: 'GitHub OAuth is not configured' });
    expect(callbackRes.statusCode).toBe(503);
    expect(callbackRes.json()).toEqual({ message: 'GitHub OAuth is not configured' });
  });

  it('reports oauthEnabled: true and user null vs authenticated user on GET /api/auth/session', async () => {
    const anonRes = await oauthApp.inject({ method: 'GET', url: '/api/auth/session' });
    expect(anonRes.statusCode).toBe(200);
    expect(anonRes.json()).toEqual({ oauthEnabled: true, user: null });

    const authedRes = await oauthApp.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: createSessionCookie() },
    });
    expect(authedRes.statusCode).toBe(200);
    expect(authedRes.json()).toEqual({ oauthEnabled: true, user: testUser });
  });

  it('GET /api/auth/login sets signed state cookie and redirects 302 to GitHub with PUBLIC_URL callback', async () => {
    const response = await oauthApp.inject({ method: 'GET', url: '/api/auth/login' });

    expect(response.statusCode).toBe(302);
    const location = response.headers.location;
    expect(location).toBeDefined();

    const redirectTarget = new URL(location as string);
    expect(redirectTarget.origin).toBe('https://github.com');
    expect(redirectTarget.pathname).toBe('/login/oauth/authorize');
    expect(redirectTarget.searchParams.get('redirect_uri')).toBe(
      `${PUBLIC_URL}/api/auth/callback`,
    );
    const state = redirectTarget.searchParams.get('state');
    expect(state).toBeTruthy();

    const cookies = setCookieHeaders(response.headers['set-cookie']);
    const stateCookie = cookies.find((c) => c.startsWith(`${OAUTH_STATE_COOKIE_NAME}=`));
    expect(stateCookie).toBeDefined();
    expect(stateCookie).toContain('HttpOnly');
    expect(stateCookie).toContain('Secure');
    expect(stateCookie).toContain('SameSite=Lax');
  });

  it('GET /api/auth/callback rejects mismatched CSRF state and clears state cookie', async () => {
    const loginRes = await oauthApp.inject({ method: 'GET', url: '/api/auth/login' });
    const rawCookie = setCookieHeaders(loginRes.headers['set-cookie'])[0] as string;
    const cookiePair = rawCookie.split(';')[0] as string;

    const response = await oauthApp.inject({
      method: 'GET',
      url: '/api/auth/callback?code=oauth-code&state=wrong-state',
      headers: { cookie: cookiePair },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/?authError=invalid_oauth_state');
    expect(exchangeCode).not.toHaveBeenCalled();

    const clearedCookie = setCookieHeaders(response.headers['set-cookie']).find((c) =>
      c.startsWith(`${OAUTH_STATE_COOKIE_NAME}=`),
    );
    expect(clearedCookie).toContain('Max-Age=0');
  });

  it('GET /api/auth/callback exchanges code, fetches user, sets HttpOnly session cookie, and redirects to /', async () => {
    const loginRes = await oauthApp.inject({ method: 'GET', url: '/api/auth/login' });
    const redirectUrl = new URL(loginRes.headers.location as string);
    const state = redirectUrl.searchParams.get('state') as string;
    const rawStateCookie = setCookieHeaders(loginRes.headers['set-cookie'])[0] as string;
    const stateCookiePair = rawStateCookie.split(';')[0] as string;

    const callbackRes = await oauthApp.inject({
      method: 'GET',
      url: `/api/auth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
      headers: { cookie: stateCookiePair },
    });

    expect(callbackRes.statusCode).toBe(302);
    expect(callbackRes.headers.location).toBe('/');
    expect(exchangeCode).toHaveBeenCalledWith(
      'valid-code',
      `${PUBLIC_URL}/api/auth/callback`,
    );
    expect(fetchUser).toHaveBeenCalledWith('ghu_fresh_token');

    const cookies = setCookieHeaders(callbackRes.headers['set-cookie']);
    const clearedState = cookies.find((c) => c.startsWith(`${OAUTH_STATE_COOKIE_NAME}=`));
    const sessionCookie = cookies.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
    expect(clearedState).toContain('Max-Age=0');
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('Secure');
    expect(sessionCookie).toContain('SameSite=Lax');

    const sessionCookiePair = (sessionCookie as string).split(';')[0] as string;
    const sessionRes = await oauthApp.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: sessionCookiePair },
    });
    expect(sessionRes.statusCode).toBe(200);
    expect(sessionRes.json()).toEqual({ oauthEnabled: true, user: testUser });
  });

  it('GET /api/auth/callback redirects with oauth_exchange_failed when token exchange throws', async () => {
    const loginRes = await oauthApp.inject({ method: 'GET', url: '/api/auth/login' });
    const state = new URL(loginRes.headers.location as string).searchParams.get(
      'state',
    ) as string;
    const stateCookiePair = (setCookieHeaders(loginRes.headers['set-cookie'])[0] as string).split(
      ';',
    )[0] as string;
    exchangeCode.mockRejectedValueOnce(new Error('GitHub OAuth token exchange failed: HTTP 400'));

    const response = await oauthApp.inject({
      method: 'GET',
      url: `/api/auth/callback?code=bad-code&state=${encodeURIComponent(state)}`,
      headers: { cookie: stateCookiePair },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/?authError=oauth_exchange_failed');
  });

  it('POST /api/auth/logout clears the session cookie', async () => {
    const response = await oauthApp.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: createSessionCookie() },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });

    const cookies = setCookieHeaders(response.headers['set-cookie']);
    const clearedSession = cookies.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
    expect(clearedSession).toBeDefined();
    expect(clearedSession).toContain(`${SESSION_COOKIE_NAME}=;`);
    expect(clearedSession).toContain('Max-Age=0');
    expect(clearedSession).toContain('HttpOnly');
    expect(clearedSession).toContain('SameSite=Lax');
  });

  it('returns 401 on /api/repos, /api/repos/:id/runs, and PATCH /api/repos/:id/config when unauthenticated', async () => {
    const responses = [
      await oauthApp.inject({ method: 'GET', url: '/api/repos' }),
      await oauthApp.inject({ method: 'GET', url: `/api/repos/${REPO_ID}/runs` }),
      await oauthApp.inject({
        method: 'PATCH',
        url: `/api/repos/${REPO_ID}/config`,
        payload: { enabled: false },
      }),
    ];

    for (const response of responses) {
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ message: 'authentication required' });
    }
    expect(listRepositories).not.toHaveBeenCalled();
    expect(ensureRepository).not.toHaveBeenCalled();
    expect(getRepository).not.toHaveBeenCalled();
    expect(updateRepositoryConfig).not.toHaveBeenCalled();
  });

  it('GET /api/repos eagerly ensures accessible repos and excludes inaccessible ones', async () => {
    listRepositories.mockResolvedValueOnce([inaccessibleRepoRow, repositoryRow, alphaRepoRow]);

    const response = await oauthApp.inject({
      method: 'GET',
      url: '/api/repos',
      headers: { cookie: createSessionCookie('ghu_user_token') },
    });

    expect(response.statusCode).toBe(200);
    expect(listAccessibleRepos).toHaveBeenCalledWith('ghu_user_token');
    expect(listRepositories).not.toHaveBeenCalled();
    expect(ensureRepository).toHaveBeenCalledTimes(2);
    expect(ensureRepository).toHaveBeenCalledWith({
      repoFullName: 'octocat/hello-world',
      installationId: 42,
      language: 'node',
    });
    expect(ensureRepository).toHaveBeenCalledWith({
      repoFullName: 'octocat/alpha-repo',
      installationId: 42,
      language: 'python',
    });

    const body = response.json() as { repos: Array<{ repoFullName: string }> };
    expect(body.repos.map((r) => r.repoFullName)).toEqual([
      'octocat/alpha-repo',
      'octocat/hello-world',
    ]);
  });

  it('GET /api/repos/:id/runs returns 403 for an inaccessible repository and 200 when accessible', async () => {
    getRepository.mockResolvedValueOnce(inaccessibleRepoRow);

    const forbiddenRes = await oauthApp.inject({
      method: 'GET',
      url: `/api/repos/${UNKNOWN_REPO_ID}/runs`,
      headers: { cookie: createSessionCookie() },
    });
    expect(forbiddenRes.statusCode).toBe(403);
    expect(forbiddenRes.json()).toEqual({
      message: 'you do not have access to this repository',
    });
    expect(listRuns).not.toHaveBeenCalled();

    getRepository.mockResolvedValueOnce(repositoryRow);
    const okRes = await oauthApp.inject({
      method: 'GET',
      url: `/api/repos/${REPO_ID}/runs`,
      headers: { cookie: createSessionCookie() },
    });
    expect(okRes.statusCode).toBe(200);
    expect(listRuns).toHaveBeenCalledWith(REPO_ID, 50);
  });

  it('PATCH /api/repos/:id/config returns 403 when canWrite is false or inaccessible, and 200 when canWrite is true', async () => {
    getRepository.mockResolvedValueOnce(inaccessibleRepoRow);
    const noAccessRes = await oauthApp.inject({
      method: 'PATCH',
      url: `/api/repos/${UNKNOWN_REPO_ID}/config`,
      headers: { cookie: createSessionCookie() },
      payload: { enabled: false },
    });
    expect(noAccessRes.statusCode).toBe(403);
    expect(noAccessRes.json()).toEqual({
      message: 'you do not have access to this repository',
    });
    expect(updateRepositoryConfig).not.toHaveBeenCalled();

    getRepository.mockResolvedValueOnce(alphaRepoRow);
    const readOnlyRes = await oauthApp.inject({
      method: 'PATCH',
      url: `/api/repos/${alphaRepoRow.id}/config`,
      headers: { cookie: createSessionCookie() },
      payload: { enabled: false },
    });
    expect(readOnlyRes.statusCode).toBe(403);
    expect(readOnlyRes.json()).toEqual({
      message: 'write or admin permission required to update configuration',
    });
    expect(updateRepositoryConfig).not.toHaveBeenCalled();

    getRepository.mockResolvedValueOnce(repositoryRow);
    const updatedRow: RepositoryRow = { ...repositoryRow, enabled: false };
    updateRepositoryConfig.mockResolvedValueOnce(updatedRow);
    const writeRes = await oauthApp.inject({
      method: 'PATCH',
      url: `/api/repos/${REPO_ID}/config`,
      headers: { cookie: createSessionCookie() },
      payload: { enabled: false },
    });
    expect(writeRes.statusCode).toBe(200);
    expect(writeRes.json()).toEqual({
      repository: { ...updatedRow, createdAt: updatedRow.createdAt.toISOString() },
    });
    expect(updateRepositoryConfig).toHaveBeenCalledWith(REPO_ID, { enabled: false });
  });
});
