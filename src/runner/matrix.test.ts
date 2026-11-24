import { describe, expect, it } from 'vitest';

import { conclusionForVerdict, describeVerdict, verdictFrom } from './matrix.js';
import type { RunStatus, SandboxRunOutcome, Verdict } from './types.js';

/** Classified outcome with a plausible exit code for the status. */
function outcome(status: RunStatus, durationMs = 0): SandboxRunOutcome {
  return {
    status,
    exitCode: status === 'pass' ? 0 : 1,
    durationMs,
    logExcerpt: '',
  };
}

describe('verdictFrom — documented matrix rows', () => {
  it('maps FAIL + PASS to verified-fix', () => {
    expect(verdictFrom(outcome('fail'), outcome('pass'))).toBe('verified-fix');
  });

  it('maps PASS + PASS to weak-test', () => {
    expect(verdictFrom(outcome('pass'), outcome('pass'))).toBe('weak-test');
  });

  it('maps FAIL + FAIL to broken-implementation', () => {
    expect(verdictFrom(outcome('fail'), outcome('fail'))).toBe('broken-implementation');
  });

  it('maps import-error + PASS to new-symbol', () => {
    expect(verdictFrom(outcome('import-error'), outcome('pass'))).toBe('new-symbol');
  });

  it('maps syntax-error + PASS to new-symbol', () => {
    expect(verdictFrom(outcome('syntax-error'), outcome('pass'))).toBe('new-symbol');
  });
});

describe('verdictFrom — timeout/error dominate any combination', () => {
  it('maps timeout on Run A to environment-failure', () => {
    expect(verdictFrom(outcome('timeout'), outcome('pass'))).toBe('environment-failure');
    expect(verdictFrom(outcome('timeout'), outcome('fail'))).toBe('environment-failure');
  });

  it('maps timeout on Run B to environment-failure', () => {
    expect(verdictFrom(outcome('fail'), outcome('timeout'))).toBe('environment-failure');
    expect(verdictFrom(outcome('pass'), outcome('timeout'))).toBe('environment-failure');
  });

  it('maps error on Run A to environment-failure', () => {
    expect(verdictFrom(outcome('error'), outcome('pass'))).toBe('environment-failure');
    expect(verdictFrom(outcome('error'), outcome('fail'))).toBe('environment-failure');
  });

  it('maps error on Run B to environment-failure', () => {
    expect(verdictFrom(outcome('fail'), outcome('error'))).toBe('environment-failure');
    expect(verdictFrom(outcome('pass'), outcome('error'))).toBe('environment-failure');
  });

  it('maps error + timeout to environment-failure', () => {
    expect(verdictFrom(outcome('error'), outcome('timeout'))).toBe('environment-failure');
    expect(verdictFrom(outcome('timeout'), outcome('error'))).toBe('environment-failure');
  });
});

describe('verdictFrom — undefined combinations stay conservative', () => {
  it('maps PASS + FAIL to environment-failure', () => {
    expect(verdictFrom(outcome('pass'), outcome('fail'))).toBe('environment-failure');
  });

  it('maps import-error + FAIL to environment-failure', () => {
    expect(verdictFrom(outcome('import-error'), outcome('fail'))).toBe('environment-failure');
  });

  it('maps syntax-error + FAIL to environment-failure', () => {
    expect(verdictFrom(outcome('syntax-error'), outcome('fail'))).toBe('environment-failure');
  });

  it('maps import-error + import-error to environment-failure', () => {
    expect(verdictFrom(outcome('import-error'), outcome('import-error'))).toBe(
      'environment-failure',
    );
  });

  it('maps pass + syntax-error to environment-failure', () => {
    expect(verdictFrom(outcome('pass'), outcome('syntax-error'))).toBe('environment-failure');
  });
});

describe('conclusionForVerdict', () => {
  const CASES: ReadonlyArray<readonly [Verdict, 'success' | 'failure' | 'neutral']> = [
    ['verified-fix', 'success'],
    ['weak-test', 'failure'],
    ['broken-implementation', 'failure'],
    ['new-symbol', 'neutral'],
    ['environment-failure', 'neutral'],
  ];

  it('maps every verdict to its matrix conclusion', () => {
    for (const [verdict, conclusion] of CASES) {
      expect(conclusionForVerdict(verdict)).toBe(conclusion);
    }
  });
});

describe('describeVerdict — titles and summaries', () => {
  it('describes verified-fix with Run B and total durations', () => {
    expect(describeVerdict('verified-fix', outcome('fail', 800), outcome('pass', 1200), 2500)).toEqual(
      {
        title: 'Differential verification passed',
        summary:
          'Run A (base + new tests) failed as expected; Run B (head + new tests) passed in 1.2s. The new tests reproduce the PR change. Total: 2.5s.',
      },
    );
  });

  it('describes weak-test with the total duration', () => {
    expect(
      describeVerdict('weak-test', outcome('pass', 1000), outcome('pass', 1200), 2500),
    ).toEqual({
      title: 'Weak or non-reproducing test detected',
      summary:
        'Run A (base + new tests) passed — the new tests did not fail on the base commit; Run B passed as well. The tests do not verify the PR change. Total: 2.5s.',
    });
  });

  it('describes broken-implementation with Run B and total durations', () => {
    expect(
      describeVerdict('broken-implementation', outcome('fail', 700), outcome('fail', 3000), 5000),
    ).toEqual({
      title: 'Implementation fails its own tests',
      summary:
        'Run A failed as expected, but Run B (head + new tests) also failed in 3.0s. Total: 5.0s.',
    });
  });

  it('describes new-symbol with Run B and total durations', () => {
    expect(
      describeVerdict('new-symbol', outcome('import-error', 600), outcome('pass', 500), 1000),
    ).toEqual({
      title: 'New feature test (base import/syntax error)',
      summary:
        'Run A failed with an import or syntax error (expected for newly introduced symbols), and Run B passed in 0.5s. Total: 1.0s.',
    });
  });

  it('describes environment-failure with both statuses', () => {
    expect(
      describeVerdict('environment-failure', outcome('timeout'), outcome('fail'), 2500),
    ).toEqual({
      title: 'Sandbox environment failure',
      summary:
        'Run A/B could not be executed reliably (status: timeout/fail). This is not a verdict on the PR itself. Total: 2.5s.',
    });
  });

  it('rounds durations to one decimal of a second', () => {
    const { summary } = describeVerdict(
      'verified-fix',
      outcome('fail', 0),
      outcome('pass', 1499),
      1049,
    );
    expect(summary).toContain('passed in 1.5s');
    expect(summary).toContain('Total: 1.0s');
  });

  it('renders zero durations as 0.0s rather than NaN', () => {
    const { summary } = describeVerdict('verified-fix', outcome('fail', 0), outcome('pass', 0), 0);
    expect(summary).toContain('passed in 0.0s');
    expect(summary).toContain('Total: 0.0s');
    expect(summary).not.toContain('NaN');
  });
});
