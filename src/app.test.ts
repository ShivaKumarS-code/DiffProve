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

import type { ApiDeps } from './api/routes.js';
import { buildApp } from './app.js';
import type { RepositoryRow, RunHistorySummary, VerificationRunRow } from './db/types.js';

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
const postQueuedCheckRun = vi.fn(async (): Promise<void> => {});

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
    checkPoster: { postQueuedCheckRun },
    installations: { upsertInstallation, removeInstallation },
    // Keep test output free of per-request pino lines; the app's default level
    // is covered implicitly by buildApp's own defaulting.
    logLevel: 'silent',
  });

  apiApp = buildApp({
    webhookSecret: WEBHOOK_SECRET,
    enqueuer: { enqueue },
    checkPoster: { postQueuedCheckRun },
    api,
    logLevel: 'silent',
  });
});

beforeEach(() => {
  enqueue.mockClear();
  postQueuedCheckRun.mockClear();
  upsertInstallation.mockClear();
  removeInstallation.mockClear();
});

afterAll(async () => {
  await app.close();
  await apiApp.close();
});

describe('POST /webhooks/github', () => {
  it('enqueues the verification job and posts the queued check run for an opened PR', async () => {
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

    expect(postQueuedCheckRun).toHaveBeenCalledTimes(1);
    expect(postQueuedCheckRun).toHaveBeenCalledWith({
      repoFullName: 'octocat/hello-world',
      headSha: 'aaa111',
      installationId: 42,
    });
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
    expect(postQueuedCheckRun).not.toHaveBeenCalled();
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
    expect(postQueuedCheckRun).not.toHaveBeenCalled();
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
    expect(postQueuedCheckRun).not.toHaveBeenCalled();
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
    expect(postQueuedCheckRun).not.toHaveBeenCalled();
  });

  it('ignores deliveries without an x-github-event header', async () => {
    const response = await postWebhook({
      signature: sign(payload),
      body: payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ message: 'ignored unknown' });
    expect(enqueue).not.toHaveBeenCalled();
    expect(postQueuedCheckRun).not.toHaveBeenCalled();
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
    expect(postQueuedCheckRun).not.toHaveBeenCalled();
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
    expect(postQueuedCheckRun).toHaveBeenCalledTimes(1);
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
    expect(postQueuedCheckRun).not.toHaveBeenCalled();
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
    expect(postQueuedCheckRun).not.toHaveBeenCalled();
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
