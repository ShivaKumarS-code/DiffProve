import { describe, expect, it } from 'vitest';

import { parseWebhookEvent } from './events.js';

/**
 * Trimmed but realistic GitHub `pull_request` delivery. Extra fields that
 * DiffProve does not consume are deliberately kept to prove the schema
 * tolerates them (GitHub adds fields over time; rejecting them would drop
 * every future event).
 */
const openedPayload = {
  action: 'opened',
  number: 7,
  pull_request: {
    number: 7,
    title: 'Fix crash',
    state: 'open',
    draft: false,
    head: { sha: 'aaa111', ref: 'fix-crash', repo: { full_name: 'octocat/hello-world' } },
    base: { sha: 'bbb222', ref: 'main' },
  },
  repository: {
    id: 1296269,
    full_name: 'octocat/hello-world',
    private: false,
    owner: { login: 'octocat' },
  },
  installation: { id: 42, node_id: 'MDIzOkludGVncmF0aW9u' },
  sender: { login: 'octocat', id: 583231, type: 'User' },
};

describe('parseWebhookEvent', () => {
  describe('pull_request', () => {
    it('maps a full opened event and ignores unknown fields', () => {
      expect(parseWebhookEvent('pull_request', openedPayload)).toEqual({
        kind: 'pull_request',
        action: 'opened',
        prNumber: 7,
        repoFullName: 'octocat/hello-world',
        installationId: 42,
        baseSha: 'bbb222',
        headSha: 'aaa111',
      });
    });

    it('passes the action through for synchronize', () => {
      const payload = {
        ...openedPayload,
        action: 'synchronize',
        pull_request: {
          ...openedPayload.pull_request,
          head: { sha: 'ccc333' },
          base: { sha: 'ddd444' },
        },
      };

      expect(parseWebhookEvent('pull_request', payload)).toEqual({
        kind: 'pull_request',
        action: 'synchronize',
        prNumber: 7,
        repoFullName: 'octocat/hello-world',
        installationId: 42,
        baseSha: 'ddd444',
        headSha: 'ccc333',
      });
    });

    it('defaults installationId to null when installation is absent', () => {
      const payload = {
        action: 'reopened',
        number: 7,
        pull_request: { number: 7, head: { sha: 'aaa111' }, base: { sha: 'bbb222' } },
        repository: { full_name: 'octocat/hello-world' },
      };

      expect(parseWebhookEvent('pull_request', payload)).toEqual({
        kind: 'pull_request',
        action: 'reopened',
        prNumber: 7,
        repoFullName: 'octocat/hello-world',
        installationId: null,
        baseSha: 'bbb222',
        headSha: 'aaa111',
      });
    });

    it('defaults installationId to null when installation is explicitly null', () => {
      const payload = { ...openedPayload, installation: null };

      expect(parseWebhookEvent('pull_request', payload)).toEqual({
        kind: 'pull_request',
        action: 'opened',
        prNumber: 7,
        repoFullName: 'octocat/hello-world',
        installationId: null,
        baseSha: 'bbb222',
        headSha: 'aaa111',
      });
    });

    it('reports an invalid result when pull_request.head.sha is missing', () => {
      const payload = {
        action: 'opened',
        number: 7,
        pull_request: { number: 7, head: {}, base: { sha: 'bbb222' } },
        repository: { full_name: 'octocat/hello-world' },
        installation: { id: 42 },
      };

      const parsed = parseWebhookEvent('pull_request', payload);

      expect(parsed.kind).toBe('invalid');
      if (parsed.kind !== 'invalid') {
        throw new Error('expected invalid');
      }
      expect(parsed.event).toBe('pull_request');
      expect(parsed.reason).toContain('pull_request.head.sha');
      expect(parsed.reason.length).toBeGreaterThan('pull_request.head.sha'.length);
    });

    it('reports an invalid result when the PR number is not a positive integer', () => {
      const payload = {
        action: 'opened',
        number: 7,
        pull_request: { number: 0, head: { sha: 'aaa111' }, base: { sha: 'bbb222' } },
        repository: { full_name: 'octocat/hello-world' },
        installation: { id: 42 },
      };

      const parsed = parseWebhookEvent('pull_request', payload);

      expect(parsed.kind).toBe('invalid');
      if (parsed.kind !== 'invalid') {
        throw new Error('expected invalid');
      }
      expect(parsed.reason).toContain('pull_request.number');
    });

    it('reports an invalid result for a non-object payload', () => {
      const parsed = parseWebhookEvent('pull_request', null);

      expect(parsed).toMatchObject({ kind: 'invalid', event: 'pull_request' });
      if (parsed.kind !== 'invalid') {
        throw new Error('expected invalid');
      }
      expect(parsed.reason.toLowerCase()).toContain('expected object');
    });
  });

  describe('installation', () => {
    it('maps a created installation with account login', () => {
      const payload = {
        action: 'created',
        installation: {
          id: 42,
          account: { login: 'octocat', id: 583231, type: 'User' },
          app_id: 1234,
          target_type: 'User',
        },
        repositories: [{ id: 1296269, full_name: 'octocat/hello-world' }],
        sender: { login: 'octocat' },
      };

      expect(parseWebhookEvent('installation', payload)).toEqual({
        kind: 'installation',
        action: 'created',
        installationId: 42,
        accountLogin: 'octocat',
      });
    });

    it('maps an installation without account login to accountLogin null', () => {
      const payload = { action: 'deleted', installation: { id: 42 } };

      expect(parseWebhookEvent('installation', payload)).toEqual({
        kind: 'installation',
        action: 'deleted',
        installationId: 42,
        accountLogin: null,
      });
    });

    it('reports an invalid result when installation.id is missing', () => {
      const payload = { action: 'created', installation: { account: { login: 'octocat' } } };

      const parsed = parseWebhookEvent('installation', payload);

      expect(parsed.kind).toBe('invalid');
      if (parsed.kind !== 'invalid') {
        throw new Error('expected invalid');
      }
      expect(parsed.event).toBe('installation');
      expect(parsed.reason).toContain('installation.id');
    });
  });

  describe('other events', () => {
    it('maps ping deliveries to the ping variant', () => {
      expect(parseWebhookEvent('ping', { zen: 'Keep it logically awesome.', hook_id: 1 })).toEqual({
        kind: 'ping',
      });
    });

    it('reports an invalid result for a ping whose payload is not an object', () => {
      expect(parseWebhookEvent('ping', 'not-an-object')).toMatchObject({
        kind: 'invalid',
        event: 'ping',
      });
    });

    it('treats unknown events as unhandled', () => {
      expect(parseWebhookEvent('fork', { forkee: {} })).toEqual({
        kind: 'unhandled',
        event: 'fork',
      });
    });

    it('treats a missing X-GitHub-Event header as unhandled with event "unknown"', () => {
      expect(parseWebhookEvent(undefined, openedPayload)).toEqual({
        kind: 'unhandled',
        event: 'unknown',
      });
    });

    it('never throws on hostile input', () => {
      expect(() => parseWebhookEvent('pull_request', undefined)).not.toThrow();
      expect(() => parseWebhookEvent('installation', [])).not.toThrow();
      expect(() => parseWebhookEvent('push', Symbol('weird'))).not.toThrow();
    });
  });
});
