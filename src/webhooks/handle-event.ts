/**
 * Dispatches a parsed GitHub webhook to the application's ports.
 *
 * This is the seam between HTTP concerns (signature verification, parsing,
 * status codes) and infrastructure concerns (queue, database persistence).
 * It has no knowledge of Fastify, BullMQ, Octokit, or Postgres so
 * it can be unit-tested with fakes.
 */

import type { InstallationStore } from '../db/types.js';
import type { Enqueuer, Logger, VerificationJob } from '../domain.js';
import type { ParsedWebhook } from './events.js';

export interface WebhookDeps {
  enqueuer: Enqueuer;
  /**
   * Installation lifecycle persistence (`installations` table, architecture
   * "Core Data Model"). Null when PostgreSQL is not configured: installation
   * events are then only acknowledged and logged.
   */
  installations: InstallationStore | null;
  logger: Logger;
}

export interface WebhookResult {
  statusCode: number;
  message: string;
}

type PullRequestEvent = Extract<ParsedWebhook, { kind: 'pull_request' }>;
type InstallationEvent = Extract<ParsedWebhook, { kind: 'installation' }>;

/** PR actions that require differential verification (architecture, Phase 1). */
const SUPPORTED_PR_ACTIONS: ReadonlySet<string> = new Set(['opened', 'synchronize', 'reopened']);

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Which `installations` row mutation an installation action implies.
 *
 * `created` and `new_permissions_accepted` describe an installation that exists,
 * so both upsert (idempotent across GitHub redeliveries); `deleted` removes the
 * row. `suspend` / `unsuspend` (and anything newer GitHub adds) keep it: the
 * installation still exists, only its state changed.
 */
function installationWriteFor(action: string): 'upsert' | 'remove' | null {
  if (action === 'created' || action === 'new_permissions_accepted') {
    return 'upsert';
  }
  if (action === 'deleted') {
    return 'remove';
  }
  return null;
}

async function handlePullRequestEvent(
  event: PullRequestEvent,
  deps: WebhookDeps,
): Promise<WebhookResult> {
  if (!SUPPORTED_PR_ACTIONS.has(event.action)) {
    return { statusCode: 200, message: `ignored pull_request ${event.action}` };
  }

  if (event.installationId === null) {
    deps.logger.warn(
      `pull_request ${event.action} for ${event.repoFullName}#${event.prNumber} has no installation id; skipping`,
    );
    return {
      statusCode: 200,
      message: 'ignored: pull request event without installation context',
    };
  }

  const job: VerificationJob = {
    repoFullName: event.repoFullName,
    prNumber: event.prNumber,
    installationId: event.installationId,
    baseSha: event.baseSha,
    headSha: event.headSha,
  };

  // The durable job is the acknowledgement boundary. Only its worker may
  // create/update a check run, even if the job has already started by now.
  try {
    const { jobId } = await deps.enqueuer.enqueue(job);
    return { statusCode: 202, message: `queued verification job ${jobId}` };
  } catch (error) {
    deps.logger.error(
      `failed to enqueue verification job for ${event.repoFullName}#${event.prNumber}@${event.headSha}: ${describeError(error)}`,
    );
    return { statusCode: 500, message: 'failed to enqueue verification job' };
  }
}

/**
 * Persists an installation lifecycle event (`installations` table).
 *
 * Always answers 200; the failure branch below explains why persistence errors
 * are logged instead of surfacing to GitHub.
 */
async function handleInstallationEvent(
  event: InstallationEvent,
  deps: WebhookDeps,
): Promise<WebhookResult> {
  const message = `installation ${event.action} acknowledged`;
  const write = installationWriteFor(event.action);
  const installations = deps.installations;

  if (write === null) {
    // suspend / unsuspend (or an action GitHub adds later) carry no row change.
    deps.logger.info(`${message} (no persistence for ${event.action})`);
    return { statusCode: 200, message };
  }

  if (installations === null) {
    // Phase 1 behavior without a database: acknowledge and log only.
    deps.logger.info(`${message} (persistence disabled: DATABASE_URL is not set)`);
    return { statusCode: 200, message };
  }

  try {
    if (write === 'upsert') {
      await installations.upsertInstallation({
        githubInstallationId: event.installationId,
        accountLogin: event.accountLogin,
      });
    } else {
      await installations.removeInstallation(event.installationId);
    }
  } catch (error) {
    // Installation rows are an optimization for the dashboard:
    // `ensureRepository` resolves installations lazily, so a failed upsert (or
    // delete) must not make GitHub retry the whole webhook delivery. Log it and
    // keep the 200.
    deps.logger.error(
      `failed to persist installation ${event.action} for installation ${event.installationId}: ${describeError(error)}`,
    );
    return { statusCode: 200, message };
  }

  deps.logger.info(`${message} (installation row ${write === 'upsert' ? 'upserted' : 'removed'})`);
  return { statusCode: 200, message };
}

export async function handleWebhookEvent(
  parsed: ParsedWebhook,
  deps: WebhookDeps,
): Promise<WebhookResult> {
  switch (parsed.kind) {
    case 'ping':
      return { statusCode: 200, message: 'pong' };

    case 'installation':
      return handleInstallationEvent(parsed, deps);

    case 'unhandled':
      return { statusCode: 200, message: `ignored ${parsed.event}` };

    case 'invalid':
      return { statusCode: 400, message: parsed.reason };

    case 'pull_request':
      return handlePullRequestEvent(parsed, deps);
  }
}
