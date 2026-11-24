import { describe, expect, it, vi } from 'vitest';

import type { InstallationStore } from '../db/types.js';
import type { ParsedWebhook } from './events.js';
import { handleWebhookEvent, type WebhookDeps } from './handle-event.js';

type PullRequestEvent = Extract<ParsedWebhook, { kind: 'pull_request' }>;

const basePullRequest: PullRequestEvent = {
  kind: 'pull_request',
  action: 'opened',
  prNumber: 7,
  repoFullName: 'octocat/hello-world',
  installationId: 42,
  baseSha: 'bbb222',
  headSha: 'aaa111',
};

function prEvent(overrides: Partial<PullRequestEvent> = {}): PullRequestEvent {
  return { ...basePullRequest, ...overrides };
}

interface SetupOptions {
  /** Job id the fake queue returns. Defaults to 'job-1'. */
  jobId?: string;
  enqueueError?: Error;
  checkRunError?: Error;
  /** Pass `true` to simulate an environment without PostgreSQL configured. */
  withoutInstallations?: boolean;
  upsertError?: Error;
  removeError?: Error;
}

/**
 * Fake ports that record the order in which side effects happen, so tests can
 * prove the job is enqueued before the check run is created.
 */
function setup(options: SetupOptions = {}) {
  const calls: string[] = [];

  const enqueue = vi.fn(async (): Promise<{ jobId: string }> => {
    calls.push('enqueue');
    if (options.enqueueError) {
      throw options.enqueueError;
    }
    return { jobId: options.jobId ?? 'job-1' };
  });

  const postQueuedCheckRun = vi.fn(async (): Promise<void> => {
    calls.push('postQueuedCheckRun');
    if (options.checkRunError) {
      throw options.checkRunError;
    }
  });

  const upsertInstallation = vi.fn<InstallationStore['upsertInstallation']>(
    async (): Promise<void> => {
      calls.push('upsertInstallation');
      if (options.upsertError) {
        throw options.upsertError;
      }
    },
  );

  const removeInstallation = vi.fn<InstallationStore['removeInstallation']>(
    async (): Promise<void> => {
      calls.push('removeInstallation');
      if (options.removeError) {
        throw options.removeError;
      }
    },
  );

  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const deps: WebhookDeps = {
    enqueuer: { enqueue },
    checkPoster: { postQueuedCheckRun },
    installations: options.withoutInstallations
      ? null
      : { upsertInstallation, removeInstallation },
    logger,
  };

  return {
    calls,
    enqueue,
    postQueuedCheckRun,
    upsertInstallation,
    removeInstallation,
    logger,
    deps,
  };
}

describe('handleWebhookEvent', () => {
  describe('pull_request', () => {
    it('enqueues the job and then posts the queued check run on opened', async () => {
      const { calls, enqueue, postQueuedCheckRun, deps } = setup();

      const result = await handleWebhookEvent(prEvent(), deps);

      expect(result).toEqual({ statusCode: 202, message: 'queued verification job job-1' });
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
      // The job is the durable record, so it must be enqueued BEFORE the check
      // run is created.
      expect(calls).toEqual(['enqueue', 'postQueuedCheckRun']);
    });

    it.each(['synchronize', 'reopened'])(
      'queues %s events with the same flow',
      async (action) => {
        const { calls, deps } = setup({ jobId: 'job-9' });

        const result = await handleWebhookEvent(prEvent({ action }), deps);

        expect(result).toEqual({ statusCode: 202, message: 'queued verification job job-9' });
        expect(calls).toEqual(['enqueue', 'postQueuedCheckRun']);
      },
    );

    it('ignores unsupported actions without side effects', async () => {
      const { calls, enqueue, postQueuedCheckRun, logger, deps } = setup();

      const result = await handleWebhookEvent(prEvent({ action: 'closed' }), deps);

      expect(result).toEqual({ statusCode: 200, message: 'ignored pull_request closed' });
      expect(enqueue).not.toHaveBeenCalled();
      expect(postQueuedCheckRun).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    });

    it('ignores pull requests without installation context and warns', async () => {
      const { calls, enqueue, postQueuedCheckRun, logger, deps } = setup();

      const result = await handleWebhookEvent(prEvent({ installationId: null }), deps);

      expect(result).toEqual({
        statusCode: 200,
        message: 'ignored: pull request event without installation context',
      });
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(enqueue).not.toHaveBeenCalled();
      expect(postQueuedCheckRun).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    });

    it('returns 500 without posting a check run when enqueueing fails', async () => {
      const { calls, enqueue, postQueuedCheckRun, logger, deps } = setup({
        enqueueError: new Error('redis unavailable'),
      });

      const result = await handleWebhookEvent(prEvent(), deps);

      expect(result).toEqual({ statusCode: 500, message: 'failed to enqueue verification job' });
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(postQueuedCheckRun).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(calls).toEqual(['enqueue']);
    });

    it('returns 500 when the check run fails after the job was enqueued', async () => {
      const { calls, enqueue, postQueuedCheckRun, logger, deps } = setup({
        checkRunError: new Error('octokit 502'),
      });

      const result = await handleWebhookEvent(prEvent(), deps);

      expect(result).toEqual({
        statusCode: 500,
        message: 'verification job enqueued but check run creation failed',
      });
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(postQueuedCheckRun).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(calls).toEqual(['enqueue', 'postQueuedCheckRun']);
    });
  });

  describe('other events', () => {
    it('answers ping with 200 pong', async () => {
      const { enqueue, postQueuedCheckRun, logger, deps } = setup();

      const result = await handleWebhookEvent({ kind: 'ping' }, deps);

      expect(result).toEqual({ statusCode: 200, message: 'pong' });
      expect(enqueue).not.toHaveBeenCalled();
      expect(postQueuedCheckRun).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
    });

    describe('installation', () => {
      it('upserts the installation on created and answers 200', async () => {
        const { enqueue, postQueuedCheckRun, upsertInstallation, removeInstallation, deps } =
          setup();

        const result = await handleWebhookEvent(
          { kind: 'installation', action: 'created', installationId: 42, accountLogin: 'octocat' },
          deps,
        );

        expect(result).toEqual({ statusCode: 200, message: 'installation created acknowledged' });
        expect(upsertInstallation).toHaveBeenCalledTimes(1);
        expect(upsertInstallation).toHaveBeenCalledWith({
          githubInstallationId: 42,
          accountLogin: 'octocat',
        });
        expect(removeInstallation).not.toHaveBeenCalled();
        // An installation event never touches the verification queue or checks.
        expect(enqueue).not.toHaveBeenCalled();
        expect(postQueuedCheckRun).not.toHaveBeenCalled();
      });

      it('upserts on new_permissions_accepted, including a missing account login', async () => {
        const { upsertInstallation, deps } = setup();

        const result = await handleWebhookEvent(
          {
            kind: 'installation',
            action: 'new_permissions_accepted',
            installationId: 42,
            accountLogin: null,
          },
          deps,
        );

        expect(result).toEqual({
          statusCode: 200,
          message: 'installation new_permissions_accepted acknowledged',
        });
        expect(upsertInstallation).toHaveBeenCalledWith({
          githubInstallationId: 42,
          accountLogin: null,
        });
      });

      it('removes the installation on deleted', async () => {
        const { upsertInstallation, removeInstallation, deps } = setup();

        const result = await handleWebhookEvent(
          { kind: 'installation', action: 'deleted', installationId: 42, accountLogin: 'octocat' },
          deps,
        );

        expect(result).toEqual({ statusCode: 200, message: 'installation deleted acknowledged' });
        expect(removeInstallation).toHaveBeenCalledTimes(1);
        expect(removeInstallation).toHaveBeenCalledWith(42);
        expect(upsertInstallation).not.toHaveBeenCalled();
      });

      it('acknowledges suspend and unsuspend without touching the store', async () => {
        const { upsertInstallation, removeInstallation, logger, deps } = setup();

        for (const action of ['suspend', 'unsuspend']) {
          const result = await handleWebhookEvent(
            {
              kind: 'installation',
              action,
              installationId: 42,
              accountLogin: 'octocat',
            },
            deps,
          );

          expect(result).toEqual({
            statusCode: 200,
            message: `installation ${action} acknowledged`,
          });
        }

        expect(upsertInstallation).not.toHaveBeenCalled();
        expect(removeInstallation).not.toHaveBeenCalled();
        expect(logger.info).toHaveBeenCalledTimes(2);
        expect(logger.error).not.toHaveBeenCalled();
      });

      it('keeps the log-only behavior when no store is configured', async () => {
        const { upsertInstallation, removeInstallation, logger, deps } = setup({
          withoutInstallations: true,
        });

        const result = await handleWebhookEvent(
          { kind: 'installation', action: 'created', installationId: 42, accountLogin: 'octocat' },
          deps,
        );

        expect(result).toEqual({ statusCode: 200, message: 'installation created acknowledged' });
        expect(upsertInstallation).not.toHaveBeenCalled();
        expect(removeInstallation).not.toHaveBeenCalled();
        expect(logger.info).toHaveBeenCalledTimes(1);
        expect(logger.error).not.toHaveBeenCalled();
      });

      it('still answers 200 and logs when the upsert fails', async () => {
        const { upsertInstallation, logger, deps } = setup({
          upsertError: new Error('postgres unavailable'),
        });

        const result = await handleWebhookEvent(
          { kind: 'installation', action: 'created', installationId: 42, accountLogin: 'octocat' },
          deps,
        );

        // Installation rows are an optimization: GitHub must not retry the
        // delivery because the database was briefly unavailable.
        expect(result).toEqual({ statusCode: 200, message: 'installation created acknowledged' });
        expect(upsertInstallation).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalledTimes(1);
        const logged = String(logger.error.mock.calls[0]?.[0] ?? '');
        expect(logged).toContain('failed to persist installation created');
        expect(logged).toContain('42');
        expect(logged).toContain('postgres unavailable');
      });

      it('still answers 200 when the delete fails', async () => {
        const { removeInstallation, logger, deps } = setup({
          removeError: new Error('postgres unavailable'),
        });

        const result = await handleWebhookEvent(
          { kind: 'installation', action: 'deleted', installationId: 42, accountLogin: 'octocat' },
          deps,
        );

        expect(result).toEqual({ statusCode: 200, message: 'installation deleted acknowledged' });
        expect(removeInstallation).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalledTimes(1);
      });
    });

    it('ignores unhandled events', async () => {
      const { enqueue, postQueuedCheckRun, deps } = setup();

      const result = await handleWebhookEvent({ kind: 'unhandled', event: 'fork' }, deps);

      expect(result).toEqual({ statusCode: 200, message: 'ignored fork' });
      expect(enqueue).not.toHaveBeenCalled();
      expect(postQueuedCheckRun).not.toHaveBeenCalled();
    });

    it('returns 400 with the parse reason for invalid payloads', async () => {
      const { enqueue, postQueuedCheckRun, deps } = setup();

      const result = await handleWebhookEvent(
        { kind: 'invalid', event: 'pull_request', reason: 'pull_request.head.sha: expected string' },
        deps,
      );

      expect(result).toEqual({
        statusCode: 400,
        message: 'pull_request.head.sha: expected string',
      });
      expect(enqueue).not.toHaveBeenCalled();
      expect(postQueuedCheckRun).not.toHaveBeenCalled();
    });
  });
});
