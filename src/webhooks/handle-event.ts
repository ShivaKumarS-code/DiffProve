/**
 * Dispatches a parsed GitHub webhook to the application's ports.
 *
 * This is the seam between HTTP concerns (signature verification, parsing,
 * status codes) and infrastructure concerns (queue, GitHub checks). It has no
 * knowledge of Fastify, BullMQ, or Octokit so it can be unit-tested with fakes.
 */

import type {
  CheckRunInput,
  CheckRunPoster,
  Enqueuer,
  Logger,
  VerificationJob,
} from '../domain.js';
import type { ParsedWebhook } from './events.js';

export interface WebhookDeps {
  enqueuer: Enqueuer;
  checkPoster: CheckRunPoster;
  logger: Logger;
}

export interface WebhookResult {
  statusCode: number;
  message: string;
}

type PullRequestEvent = Extract<ParsedWebhook, { kind: 'pull_request' }>;

/** PR actions that require differential verification (architecture, Phase 1). */
const SUPPORTED_PR_ACTIONS: ReadonlySet<string> = new Set(['opened', 'synchronize', 'reopened']);

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

  // Ordering rationale: the job is the durable record of the request, so
  // enqueue it first and only then create the visible `queued` check run.
  // Returning 500 on either failure makes GitHub retry the webhook delivery,
  // and per-(repo, PR, head-sha) job-id dedupe upstream makes those retries
  // safe: a duplicate delivery re-uses the same job instead of running twice.
  let jobId: string;
  try {
    const enqueueResult = await deps.enqueuer.enqueue(job);
    jobId = enqueueResult.jobId;
  } catch (error) {
    deps.logger.error(
      `failed to enqueue verification job for ${event.repoFullName}#${event.prNumber}@${event.headSha}: ${describeError(error)}`,
    );
    // Do not post the check run: the job never landed, so a check run would
    // promise verification that will never happen.
    return { statusCode: 500, message: 'failed to enqueue verification job' };
  }

  const checkRunInput: CheckRunInput = {
    repoFullName: event.repoFullName,
    headSha: event.headSha,
    installationId: event.installationId,
  };
  try {
    await deps.checkPoster.postQueuedCheckRun(checkRunInput);
  } catch (error) {
    deps.logger.error(
      `verification job ${jobId} enqueued but queued check run creation failed for ${event.repoFullName}#${event.prNumber}@${event.headSha}: ${describeError(error)}`,
    );
    // Return 500 anyway: GitHub retries, and the deduped job id keeps the
    // retry from creating a second verification run.
    return {
      statusCode: 500,
      message: 'verification job enqueued but check run creation failed',
    };
  }

  return { statusCode: 202, message: `queued verification job ${jobId}` };
}

export async function handleWebhookEvent(
  parsed: ParsedWebhook,
  deps: WebhookDeps,
): Promise<WebhookResult> {
  switch (parsed.kind) {
    case 'ping':
      return { statusCode: 200, message: 'pong' };

    case 'installation':
      deps.logger.info(
        `installation ${parsed.action} acknowledged (persistence lands with the DB phase)`,
      );
      return { statusCode: 200, message: `installation ${parsed.action} acknowledged` };

    case 'unhandled':
      return { statusCode: 200, message: `ignored ${parsed.event}` };

    case 'invalid':
      return { statusCode: 400, message: parsed.reason };

    case 'pull_request':
      return handlePullRequestEvent(parsed, deps);
  }
}
