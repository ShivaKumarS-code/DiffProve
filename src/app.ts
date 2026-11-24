/**
 * Fastify application factory for the DiffProve GitHub App webhook receiver.
 *
 * Everything infrastructure-shaped is injected (ports from `domain.ts`), so this
 * module can be built and exercised without Redis, GitHub, or real App
 * credentials. It deliberately knows nothing about `process.env`: wiring real
 * dependencies is the entrypoint's job (src/server.ts).
 *
 * The one subtlety worth reading twice is the JSON content-type parser: GitHub
 * signs the *raw request bytes*, so they must be captured before JSON parsing
 * and hashed exactly as received (architecture, "API & Interface Contracts" —
 * `POST /webhooks/github` verifies HMAC and dispatches queue jobs).
 */

import Fastify, { type FastifyInstance } from 'fastify';

import { registerApiRoutes, type ApiDeps } from './api/routes.js';
import type { InstallationStore } from './db/types.js';
import type { CheckRunPoster, Enqueuer } from './domain.js';
import { parseWebhookEvent } from './webhooks/events.js';
import { handleWebhookEvent } from './webhooks/handle-event.js';
import { verifyWebhookSignature } from './webhooks/verify-signature.js';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Raw request bytes as received on the wire, captured by the JSON
     * content-type parser registered in `buildApp`. Needed because HMAC
     * verification must hash the exact bytes GitHub signed, and re-serializing
     * `request.body` would change them.
     */
    rawBody?: Buffer;
  }
}

export interface AppDeps {
  webhookSecret: string;
  enqueuer: Enqueuer;
  checkPoster: CheckRunPoster;
  /**
   * Dashboard API stores (`GET /api/repos`, `GET /api/repos/:id/runs`,
   * `PATCH /api/repos/:id/config`). Omitted or null when `DATABASE_URL` is not
   * configured, in which case those routes answer 503 instead of pretending
   * (architecture, "API & Interface Contracts").
   */
  api?: ApiDeps | null;
  /**
   * Installation persistence for `installation` webhook events. Omitted or
   * null when the database is not configured; the webhook handler degrades to
   * acknowledgement-only behavior.
   */
  installations?: InstallationStore | null;
  /** Pino log level; default 'info'. */
  logLevel?: string;
}

/**
 * GitHub `pull_request` payloads (with full PR bodies, labels, and diff stats)
 * routinely exceed Fastify's 1 MiB default, so the webhook parser opts into a
 * larger limit while every other route keeps the default.
 */
const WEBHOOK_BODY_LIMIT = 5 * 1024 * 1024;

/** Fastify's documented way to control a content-type parser failure status. */
const BAD_REQUEST_STATUS = 400;

/** Status returned for a delivery whose HMAC cannot be verified. */
const UNAUTHORIZED_STATUS = 401;

/** Status returned when an unexpected failure escapes the handler. */
const INTERNAL_ERROR_STATUS = 500;

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: { level: deps.logLevel ?? 'info' } });

  // Replace Fastify's default JSON parser (the default is overridable; a
  // previously customised one would throw FST_ERR_CTP_ALREADY_PRESENT) with one
  // that keeps the raw bytes on the request before decoding.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: WEBHOOK_BODY_LIMIT },
    (request, body, done) => {
      // `parseAs: 'buffer'` makes this a Buffer at runtime; the guard keeps the
      // raw bytes correct (and the code type-safe) if Fastify's parser mode ever
      // changes to `'string'`.
      const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
      request.rawBody = rawBody;

      try {
        done(null, JSON.parse(rawBody.toString('utf8')) as unknown);
      } catch {
        // Malformed JSON is a client error, not a server fault: Fastify's error
        // handler reads `statusCode` off the parser error, so without it this
        // would surface as a 500. The error deliberately carries a fixed
        // message instead of the SyntaxError text, which quotes body bytes.
        done(
          Object.assign(new Error('body is not valid JSON'), {
            statusCode: BAD_REQUEST_STATUS,
          }),
        );
      }
    },
  );

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.post('/webhooks/github', async (request, reply) => {
    // GitHub's signature header and event name; Fastify lowercases header names.
    // Both are normalised to `string | undefined` because duplicate headers
    // arrive as arrays, which are never meaningful here.
    const signatureHeader = request.headers['x-hub-signature-256'];
    const signature = typeof signatureHeader === 'string' ? signatureHeader : undefined;
    const rawBody = request.rawBody;

    // Defence in depth: `rawBody` is always set for `application/json`, but a
    // delivery that bypassed the parser (unexpected content type) must never be
    // allowed through unverified. Nothing about the delivery is logged here —
    // the payload is unverified, untrusted, and may contain secrets.
    if (
      rawBody === undefined ||
      !verifyWebhookSignature(rawBody, signature, deps.webhookSecret)
    ) {
      return reply.code(UNAUTHORIZED_STATUS).send({ message: 'invalid webhook signature' });
    }

    const eventHeader = request.headers['x-github-event'];
    const event = typeof eventHeader === 'string' ? eventHeader : undefined;
    const parsed = parseWebhookEvent(event, request.body);

    try {
      const result = await handleWebhookEvent(parsed, {
        enqueuer: deps.enqueuer,
        checkPoster: deps.checkPoster,
        installations: deps.installations ?? null,
        logger: app.log,
      });

      return reply.code(result.statusCode).send({ message: result.message });
    } catch (error) {
      // handleWebhookEvent is documented not to throw, but this is the HTTP
      // boundary: an escaping error must become a controlled 500 rather than an
      // unhandled rejection. Log the message only (no payload, no stack data
      // that could include request details).
      app.log.error(
        `unhandled error while processing webhook: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return reply.code(INTERNAL_ERROR_STATUS).send({ message: 'internal error' });
    }
  });

  // Dashboard API (docs/architecture.md, "API & Interface Contracts":
  // `GET /api/repos/:id/runs` and `PATCH /api/repos/:id/config`). A null dep
  // means persistence is not configured and each route answers 503.
  registerApiRoutes(app, deps.api ?? null);

  return app;
}
