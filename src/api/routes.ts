/**
 * Dashboard JSON API: repository onboarding, verification history, and test
 * config overrides.
 *
 * These routes are the dashboard's contract from docs/architecture.md,
 * "API & Interface Contracts":
 *   - `GET /api/repos` — the repositories the "Web Dashboard" (Component
 *     Architecture & Stack) onboards and lists.
 *   - `GET /api/repos/:id/runs` — "Returns verification history and weak-test
 *     catch rate for the dashboard."
 *   - `PATCH /api/repos/:id/config` — "Overrides auto-detected `test_command`
 *     or `test_file_globs`." Also carries `enabled` so the dashboard can pause a
 *     repository without deleting it.
 *
 * `DATABASE_URL` is optional (architecture, "Run History DB" plus the note in
 * `db/types.ts`): without a pool there are no stores to inject, so every route
 * answers 503 instead of pretending the repository has no history. The
 * dashboard renders that as its "database not configured" prompt.
 *
 * Store failures are deliberately not caught here. Fastify's default error
 * handler turns an escaping error into a 500, which is the honest answer for a
 * database outage; only domain outcomes (malformed uuid, unknown repository,
 * invalid body) are mapped to 400/404.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import type { RepositoryStore, VerificationRunStore } from '../db/types.js';

export interface ApiDeps {
  repositories: RepositoryStore;
  runs: VerificationRunStore;
}

/** No `DATABASE_URL`: the dashboard's "connect a database" state. */
const DATABASE_NOT_CONFIGURED_STATUS = 503;

const BAD_REQUEST_STATUS = 400;
const NOT_FOUND_STATUS = 404;

/** `GET /api/repos/:id/runs` default page size (matches the store's default). */
const DEFAULT_RUN_LIMIT = 50;

/** Upper bound on one page of history: keeps a dashboard query bounded. */
const MAX_RUN_LIMIT = 200;

const MIN_RUN_LIMIT = 1;

/**
 * Same shape the stores use to reject non-uuid ids before PostgreSQL would
 * raise 22P02 (see `db/repositories.ts`), so an id typo is a clean 400 here.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PATCH body contract: every field optional, and an explicit `null` clears an
 * override (the store distinguishes "absent" from "null", which is why neither
 * `null` nor `undefined` may be collapsed by the schema).
 */
const configPatchSchema = z.object({
  testCommand: z.string().nullable().optional(),
  testFileGlobs: z.array(z.string()).nullable().optional(),
  enabled: z.boolean().optional(),
});

function databaseNotConfigured(reply: FastifyReply): FastifyReply {
  return reply
    .code(DATABASE_NOT_CONFIGURED_STATUS)
    .send({ message: 'database not configured (set DATABASE_URL)' });
}

/**
 * Parses `?limit=`: absent means the default, a non-numeric (or non-integer or
 * empty) value is rejected, and in-range integers are clamped to 1..200 so a
 * huge value cannot make the dashboard ask for an unbounded page.
 * Returns null when the value is not a number at all.
 */
function parseLimit(raw: unknown): number | null {
  if (raw === undefined) {
    return DEFAULT_RUN_LIMIT;
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    return null;
  }

  const value = Number(raw);
  if (!Number.isInteger(value)) {
    return null;
  }

  return Math.min(MAX_RUN_LIMIT, Math.max(MIN_RUN_LIMIT, value));
}

/**
 * Short human summary from a zod error: first issue only, e.g.
 * `enabled: Invalid input: expected boolean, received string` — the dashboard
 * shows it beside the config form.
 */
function summarizeValidationError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) {
    return 'invalid request body';
  }
  const path = issue.path.map((segment) => String(segment)).join('.');
  return path === '' ? issue.message : `${path}: ${issue.message}`;
}

export function registerApiRoutes(app: FastifyInstance, deps: ApiDeps | null): void {
  app.get('/api/repos', async (_request, reply) => {
    // Copy into a local so the null check narrows the captured dependency.
    const stores = deps;
    if (stores === null) {
      return databaseNotConfigured(reply);
    }

    return { repos: await stores.repositories.listRepositories() };
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/repos/:id/runs',
    async (request, reply) => {
      const stores = deps;
      if (stores === null) {
        return databaseNotConfigured(reply);
      }

      const { id } = request.params;
      if (!UUID_PATTERN.test(id)) {
        return reply.code(BAD_REQUEST_STATUS).send({ message: 'invalid repository id' });
      }

      const limit = parseLimit(request.query.limit);
      if (limit === null) {
        return reply.code(BAD_REQUEST_STATUS).send({ message: 'invalid limit' });
      }

      const repository = await stores.repositories.getRepository(id);
      if (repository === null) {
        return reply.code(NOT_FOUND_STATUS).send({ message: 'repository not found' });
      }

      // Spread the summary (`runs`, `totalRuns`, `weakTestCount`, `catchRate`)
      // so the dashboard receives the whole history contract in one response.
      return { repository, ...(await stores.runs.listRuns(id, limit)) };
    },
  );

  app.patch<{ Params: { id: string }; Body: unknown }>(
    '/api/repos/:id/config',
    async (request, reply) => {
      const stores = deps;
      if (stores === null) {
        return databaseNotConfigured(reply);
      }

      const { id } = request.params;
      if (!UUID_PATTERN.test(id)) {
        return reply.code(BAD_REQUEST_STATUS).send({ message: 'invalid repository id' });
      }

      const parsed = configPatchSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(BAD_REQUEST_STATUS)
          .send({ message: summarizeValidationError(parsed.error) });
      }

      const repository = await stores.repositories.updateRepositoryConfig(id, parsed.data);
      if (repository === null) {
        return reply.code(NOT_FOUND_STATUS).send({ message: 'repository not found' });
      }

      return { repository };
    },
  );
}
