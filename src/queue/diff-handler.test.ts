import { describe, expect, it, vi } from 'vitest';

import type { Logger, VerificationJob } from '../domain.js';
import { DEFAULT_TEST_GLOBS } from '../diff/types.js';
import type { CheckRunReporter, PrDiffClient } from '../diff/types.js';
import { createDiffSplittingHandler, NO_TEST_CHANGES_TITLE } from './diff-handler.js';

/**
 * Fixtures are byte-exact unified-diff shapes (same style as the parser and
 * splitter tests), so the REAL `splitDiff` classifies them exactly the way it
 * classifies a GitHub `.diff` payload. Only the ports are faked.
 */
const IMPL_ONLY_DIFF = [
  'diff --git a/src/app.py b/src/app.py',
  'index 1111111..2222222 100644',
  '--- a/src/app.py',
  '+++ b/src/app.py',
  '@@ -1,3 +1,3 @@',
  ' def main():',
  '-    return 1',
  '+    return 2',
  '',
].join('\n');

const MIXED_DIFF = IMPL_ONLY_DIFF + [
  'diff --git a/tests/test_new.py b/tests/test_new.py',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/tests/test_new.py',
  '@@ -0,0 +1,2 @@',
  '+def test_new():',
  '+    assert True',
  '',
].join('\n');

const DELETED_TEST_DIFF = [
  'diff --git a/tests/test_old.py b/tests/test_old.py',
  'deleted file mode 100644',
  'index 8888888..0000000',
  '--- a/tests/test_old.py',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-def test_old():',
  '-    assert False',
  '',
].join('\n');

const EMPTY_DIFF = '';

const JOB: VerificationJob = {
  repoFullName: 'octocat/hello-world',
  prNumber: 7,
  installationId: 42,
  baseSha: 'base123',
  headSha: 'head456',
};

/** Builds the handler with fakes for all three injected ports. */
function buildHarness() {
  const prDiff = vi.fn<PrDiffClient>();
  const reportNoTestChanges = vi.fn<CheckRunReporter['reportNoTestChanges']>();
  const info = vi.fn<Logger['info']>();
  const warn = vi.fn<Logger['warn']>();
  const error = vi.fn<Logger['error']>();

  const handler = createDiffSplittingHandler({
    prDiff,
    checkRuns: { reportNoTestChanges },
    logger: { info, warn, error },
  });

  return { handler, prDiff, reportNoTestChanges, info, warn, error };
}

/** Recorded messages of a fake logger method, in call order. */
function messagesOf(mock: { mock: { calls: readonly (readonly string[])[] } }): string[] {
  return mock.mock.calls.map((call) => call[0] ?? '');
}

/** The first message a fake logger method recorded. */
function firstMessage(mock: { mock: { calls: readonly (readonly string[])[] } }): string {
  return messagesOf(mock)[0] ?? '';
}

describe('createDiffSplittingHandler — implementation-only diff', () => {
  it('fetches the sha-pinned diff and reports one neutral check run', async () => {
    const harness = buildHarness();
    harness.prDiff.mockResolvedValue(IMPL_ONLY_DIFF);

    await expect(harness.handler(JOB)).resolves.toBeUndefined();

    expect(harness.prDiff).toHaveBeenCalledTimes(1);
    expect(harness.prDiff).toHaveBeenCalledWith({
      repoFullName: 'octocat/hello-world',
      baseSha: 'base123',
      headSha: 'head456',
      installationId: 42,
    });

    expect(harness.reportNoTestChanges).toHaveBeenCalledTimes(1);
    expect(harness.reportNoTestChanges).toHaveBeenCalledWith({
      repoFullName: 'octocat/hello-world',
      headSha: 'head456',
      installationId: 42,
      title: NO_TEST_CHANGES_TITLE,
      summary: expect.stringContaining('1 changed file(s)'),
    });

    expect(harness.warn).not.toHaveBeenCalled();
    expect(harness.error).not.toHaveBeenCalled();
  });

  it('explains the skip with every default test glob in the summary', async () => {
    const harness = buildHarness();
    harness.prDiff.mockResolvedValue(IMPL_ONLY_DIFF);

    await harness.handler(JOB);

    const report = harness.reportNoTestChanges.mock.calls[0]?.[0];
    expect(report).toBeDefined();
    const summary = report?.summary ?? '';

    // Exact wording required by docs/architecture.md (pipeline step 2).
    expect(summary).toBe(
      `1 changed file(s), none matching the test file globs (${DEFAULT_TEST_GLOBS.join(', ')}). ` +
        'Differential verification skipped: no new or modified tests to verify.',
    );

    for (const glob of ['test_*.py', '*_test.py', '*.test.ts', '*.spec.ts']) {
      expect(summary).toContain(glob);
    }
  });

  it('logs the receive line, the split counts, and the neutral report', async () => {
    const harness = buildHarness();
    harness.prDiff.mockResolvedValue(IMPL_ONLY_DIFF);

    await harness.handler(JOB);

    const logged = messagesOf(harness.info);
    expect(
      logged.some(
        (message) =>
          message.includes('verification job received') &&
          message.includes('repo=octocat/hello-world') &&
          message.includes('pr=7') &&
          message.includes('head=head456') &&
          message.includes('(diff splitter)'),
      ),
    ).toBe(true);
    expect(logged.some((message) => message.includes('split: 1 file(s) changed'))).toBe(true);
    expect(
      logged.some(
        (message) =>
          message.includes('reported neutral check run (no test changes)') &&
          message.includes('octocat/hello-world#7'),
      ),
    ).toBe(true);
  });
});

describe('createDiffSplittingHandler — mixed diff (test changes)', () => {
  it('defers to the Phase 3 sandbox runner without touching the check run', async () => {
    const harness = buildHarness();
    harness.prDiff.mockResolvedValue(MIXED_DIFF);

    await expect(harness.handler(JOB)).resolves.toBeUndefined();

    expect(harness.prDiff).toHaveBeenCalledTimes(1);
    // The check run stays `queued` from Phase 1: no verdict was computed here.
    expect(harness.reportNoTestChanges).not.toHaveBeenCalled();
    expect(harness.error).not.toHaveBeenCalled();

    const logged = messagesOf(harness.info);
    expect(
      logged.some(
        (message) =>
          message.includes('deferred to Phase 3 sandbox runner') &&
          message.includes('tests/test_new.py'),
      ),
    ).toBe(true);
    expect(
      logged.some((message) =>
        message.includes('split: 2 file(s) changed, 1 test file(s), 1 runnable: tests/test_new.py'),
      ),
    ).toBe(true);
  });
});

describe('createDiffSplittingHandler — deleted test file', () => {
  it('is a test change worth deferring, but is not runnable at head', async () => {
    const harness = buildHarness();
    harness.prDiff.mockResolvedValue(DELETED_TEST_DIFF);

    await expect(harness.handler(JOB)).resolves.toBeUndefined();

    expect(harness.reportNoTestChanges).not.toHaveBeenCalled();

    const logged = messagesOf(harness.info);
    expect(
      logged.some(
        (message) =>
          message.includes('deferred to Phase 3 sandbox runner') &&
          message.includes('tests/test_old.py'),
      ),
    ).toBe(true);
    expect(
      logged.some((message) =>
        message.includes('split: 1 file(s) changed, 1 test file(s), 0 runnable: tests/test_old.py'),
      ),
    ).toBe(true);
  });
});

describe('createDiffSplittingHandler — empty diff', () => {
  it('takes the short-circuit: nothing changed means nothing to verify', async () => {
    const harness = buildHarness();
    harness.prDiff.mockResolvedValue(EMPTY_DIFF);

    await expect(harness.handler(JOB)).resolves.toBeUndefined();

    expect(harness.reportNoTestChanges).toHaveBeenCalledTimes(1);
    const report = harness.reportNoTestChanges.mock.calls[0]?.[0];
    expect(report?.summary).toContain('0 changed file(s)');
    expect(
      messagesOf(harness.info).some((message) =>
        message.includes('split: 0 file(s) changed, 0 test file(s), 0 runnable: (none)'),
      ),
    ).toBe(true);
  });
});

describe('createDiffSplittingHandler — diff fetch failure', () => {
  it('logs and rethrows so BullMQ retries the job', async () => {
    const harness = buildHarness();
    const failure = new Error(
      'failed to fetch PR diff for octocat/hello-world (base123...head456) with HTTP 502',
    );
    harness.prDiff.mockRejectedValue(failure);

    const outcome = harness.handler(JOB);
    await expect(outcome).rejects.toBe(failure);
    await expect(outcome).rejects.toThrow('HTTP 502');

    expect(harness.error).toHaveBeenCalledTimes(1);
    expect(firstMessage(harness.error)).toContain('failed to fetch PR diff');
    expect(firstMessage(harness.error)).toContain('HTTP 502');
    expect(harness.reportNoTestChanges).not.toHaveBeenCalled();
  });
});

describe('createDiffSplittingHandler — check-run report failure', () => {
  it('logs and rethrows: an idempotent retry is preferred over a stuck queued run', async () => {
    const harness = buildHarness();
    const failure = new Error('failed to report neutral check run: HTTP 500');
    harness.prDiff.mockResolvedValue(IMPL_ONLY_DIFF);
    harness.reportNoTestChanges.mockRejectedValue(failure);

    await expect(harness.handler(JOB)).rejects.toBe(failure);

    expect(harness.error).toHaveBeenCalledTimes(1);
    expect(firstMessage(harness.error)).toContain('failed to report neutral check run');
    expect(firstMessage(harness.error)).toContain('HTTP 500');

    // The success log must not claim a report that failed.
    expect(
      messagesOf(harness.info).some((message) =>
        message.includes('reported neutral check run (no test changes)'),
      ),
    ).toBe(false);
  });
});

describe('createDiffSplittingHandler — missing installation id', () => {
  it('warns and touches no port: no installation token means no diff fetch is possible', async () => {
    const harness = buildHarness();

    await expect(harness.handler({ ...JOB, installationId: null })).resolves.toBeUndefined();

    expect(harness.prDiff).not.toHaveBeenCalled();
    expect(harness.reportNoTestChanges).not.toHaveBeenCalled();
    expect(harness.error).not.toHaveBeenCalled();

    expect(harness.warn).toHaveBeenCalledTimes(1);
    const warning = firstMessage(harness.warn);
    expect(warning).toContain('octocat/hello-world');
    expect(warning).toContain('pr=7');
    expect(warning.toLowerCase()).toContain('installation');

    // It must not look like a received-and-processed job.
    expect(
      messagesOf(harness.info).some((message) => message.includes('verification job received')),
    ).toBe(false);
  });
});
