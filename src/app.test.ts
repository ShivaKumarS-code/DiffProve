/**
 * Integration-style tests for the webhook HTTP boundary.
 *
 * Everything runs in-process through `fastify.inject`: no network, no Redis,
 * no GitHub. The queue and check-run ports are vi.fn doubles, so each test can
 * assert both the response and the side effects (including their absence for
 * rejected deliveries).
 */

import { createHmac } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from './app.js';

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

let app: FastifyInstance;

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
    // Keep test output free of per-request pino lines; the app's default level
    // is covered implicitly by buildApp's own defaulting.
    logLevel: 'silent',
  });
});

beforeEach(() => {
  enqueue.mockClear();
  postQueuedCheckRun.mockClear();
});

afterAll(async () => {
  await app.close();
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
