/**
 * Webhook payload parsing for the GitHub App endpoint.
 *
 * GitHub delivers arbitrary, evolving JSON with a huge number of extra
 * fields. This module does the smallest possible validation needed to build a
 * `VerificationJob` / installation acknowledgement, and maps every failure to
 * a `ParsedWebhook` variant instead of throwing, so the HTTP layer can answer
 * GitHub with a deterministic status code.
 */

import { z } from 'zod';

export type ParsedWebhook =
  | {
      kind: 'pull_request';
      action: string;
      prNumber: number;
      repoFullName: string;
      installationId: number | null;
      baseSha: string;
      headSha: string;
    }
  | { kind: 'installation'; action: string; installationId: number; accountLogin: string | null }
  | { kind: 'ping' }
  | { kind: 'unhandled'; event: string }
  | { kind: 'invalid'; event: string; reason: string };

/**
 * Only the fields DiffProve actually consumes are described. Zod objects strip
 * unknown keys by default (they do not reject them), which is required here:
 * GitHub payloads carry dozens of fields we must tolerate.
 */
const pullRequestPayloadSchema = z.object({
  action: z.string(),
  pull_request: z.object({
    number: z.number().int().positive(),
    head: z.object({ sha: z.string() }),
    base: z.object({ sha: z.string() }),
  }),
  repository: z.object({ full_name: z.string() }),
  // `installation` is optional (and nullable, since some deliveries send
  // `null` instead of omitting the key).
  installation: z.object({ id: z.number() }).nullish(),
});

const installationPayloadSchema = z.object({
  action: z.string(),
  installation: z.object({
    id: z.number(),
    account: z.object({ login: z.string() }).nullish(),
  }),
});

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Short human summary from a zod error: first issue only, e.g.
 * `pull_request.head.sha: expected string`.
 */
function summarizeValidationError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) {
    return 'payload failed validation';
  }
  const path = issue.path.map((segment) => String(segment)).join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

function parseKnownEvent(event: string | undefined, payload: unknown): ParsedWebhook {
  if (event === 'pull_request') {
    const result = pullRequestPayloadSchema.safeParse(payload);
    if (!result.success) {
      return { kind: 'invalid', event, reason: summarizeValidationError(result.error) };
    }
    const { action, pull_request: pullRequest, repository, installation } = result.data;
    return {
      kind: 'pull_request',
      action,
      prNumber: pullRequest.number,
      repoFullName: repository.full_name,
      installationId: installation?.id ?? null,
      baseSha: pullRequest.base.sha,
      headSha: pullRequest.head.sha,
    };
  }

  if (event === 'installation') {
    const result = installationPayloadSchema.safeParse(payload);
    if (!result.success) {
      return { kind: 'invalid', event, reason: summarizeValidationError(result.error) };
    }
    return {
      kind: 'installation',
      action: result.data.action,
      installationId: result.data.installation.id,
      accountLogin: result.data.installation.account?.login ?? null,
    };
  }

  if (event === 'ping') {
    // GitHub's ping payload is `{ zen, hook_id, hook, repository?, sender }`;
    // only object-ness is relevant to us.
    return isObject(payload)
      ? { kind: 'ping' }
      : { kind: 'invalid', event, reason: 'payload: expected an object' };
  }

  return { kind: 'unhandled', event: event ?? 'unknown' };
}

/**
 * Parses a webhook delivery into a `ParsedWebhook`. Never throws: malformed
 * input becomes an `invalid` (or `unhandled`) result.
 */
export function parseWebhookEvent(event: string | undefined, payload: unknown): ParsedWebhook {
  try {
    return parseKnownEvent(event, payload);
  } catch (error) {
    // Defensive: zod's `safeParse` does not throw, but this function is the
    // webhook boundary and must not take the server down.
    const reason = error instanceof Error ? error.message : String(error);
    return { kind: 'invalid', event: event ?? 'unknown', reason };
  }
}
