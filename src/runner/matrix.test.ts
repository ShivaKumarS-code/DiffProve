import { describe, expect, it } from 'vitest';

import { summarizeCaseEvidence } from './case-evidence.js';
import { conclusionForVerdict, verdictFrom } from './matrix.js';
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

describe('verdictFrom — case evidence', () => {
  const mixed = summarizeCaseEvidence(
    [{ id: 'fixed', status: 'fail' }, { id: 'weak', status: 'pass' }],
    [{ id: 'fixed', status: 'pass' }, { id: 'weak', status: 'pass' }],
  );

  it('maps aggregate fail + pass with both kinds of evidence to mixed-test', () => {
    expect(verdictFrom(outcome('fail'), outcome('pass'), mixed)).toBe('mixed-test');
  });

  it('keeps the aggregate verdict if one transition count is zero or evidence is unavailable', () => {
    const nonReproducing = summarizeCaseEvidence(
      [{ id: 'not run', status: 'skipped' }, { id: 'weak', status: 'pass' }],
      [{ id: 'not run', status: 'pass' }, { id: 'weak', status: 'pass' }],
    );
    const reproducing = summarizeCaseEvidence(
      [{ id: 'fixed', status: 'fail' }],
      [{ id: 'fixed', status: 'pass' }, { id: 'unknown on base', status: 'pass' }],
    );
    for (const evidence of [nonReproducing, reproducing, null, undefined]) {
      expect(verdictFrom(outcome('fail'), outcome('pass'), evidence)).toBe('verified-fix');
    }
  });

  it('does not override new-feature, setup, weak-test or broken implementation outcomes', () => {
    expect(verdictFrom(outcome('import-error'), outcome('pass'), mixed)).toBe('new-symbol');
    expect(verdictFrom(outcome('timeout'), outcome('pass'), mixed)).toBe('environment-failure');
    expect(verdictFrom(outcome('pass'), outcome('pass'), mixed)).toBe('weak-test');
    expect(verdictFrom(outcome('fail'), outcome('fail'), mixed)).toBe('broken-implementation');
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
    ['mixed-test', 'failure'],
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
