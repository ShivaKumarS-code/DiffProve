import { describe, expect, it } from 'vitest';

import { buildVerdictReport } from './report.js';
import type { RunStatus, SandboxRunOutcome, Verdict } from './types.js';

const CONTEXT = {
  repoFullName: 'octocat/hello-world',
  prNumber: 7,
  durationMs: 2500,
};

/** Classified outcome; only the fields the renderer reads are varied. */
function outcome(status: RunStatus, overrides: Partial<SandboxRunOutcome> = {}): SandboxRunOutcome {
  return {
    status,
    exitCode: status === 'pass' ? 0 : 1,
    durationMs: 400,
    logExcerpt: '',
    ...overrides,
  };
}

/** Counts the summary lines that are exactly a code fence. */
function fenceLineCount(summary: string): number {
  return summary.split('\n').filter((line) => line === '```').length;
}

/** The exact block expected for one run's non-empty log excerpt. */
function detailsBlock(logExcerpt: string): string {
  return [
    '<details><summary>stdout / stderr excerpt</summary>',
    '',
    '```',
    logExcerpt,
    '```',
    '',
    '</details>',
  ].join('\n');
}

const TITLES: ReadonlyArray<readonly [Verdict, string]> = [
  ['verified-fix', 'Differential verification passed'],
  ['weak-test', 'Weak or non-reproducing test detected'],
  ['broken-implementation', 'Implementation fails its own tests'],
  ['new-symbol', 'New feature test (base import/syntax error)'],
  ['environment-failure', 'Sandbox environment failure'],
];

const LEADS: ReadonlyArray<readonly [Verdict, string]> = [
  [
    'verified-fix',
    '**Verified fix** — Run A failed on the base commit as expected and Run B passes on head. The new tests genuinely reproduce the PR change.',
  ],
  [
    'weak-test',
    '**Weak or non-reproducing test** — the new tests pass on the base commit too, so they do not verify the PR change.',
  ],
  ['broken-implementation', '**Broken implementation** — the PR still fails its own new tests on head.'],
  [
    'new-symbol',
    '**New feature test** — Run A fails with an import or syntax error, which is expected when a PR introduces a new symbol, and Run B passes. Annotated as neutral rather than a failure.',
  ],
  [
    'environment-failure',
    '**Sandbox environment failure** — the runs could not be executed reliably. This is not a verdict on the PR itself.',
  ],
];

const MATRIX_ROWS: ReadonlyArray<readonly [Verdict, RunStatus, RunStatus, string]> = [
  ['verified-fix', 'fail', 'pass', 'Verified fix'],
  ['weak-test', 'pass', 'pass', 'Weak / non-reproducing test'],
  ['broken-implementation', 'fail', 'fail', 'Broken implementation'],
  ['new-symbol', 'import-error', 'pass', 'New feature test'],
  ['environment-failure', 'timeout', 'pass', 'Sandbox environment failure'],
];

describe('buildVerdictReport — title', () => {
  it('keeps the Phase 3 check-run title for every verdict', () => {
    for (const [verdict, title] of TITLES) {
      const report = buildVerdictReport(verdict, outcome('fail'), outcome('pass'), CONTEXT);
      expect(report.title).toBe(title);
    }
  });
});

describe('buildVerdictReport — verdict statement', () => {
  it('opens the summary with the bold verdict lead for every verdict', () => {
    for (const [verdict, lead] of LEADS) {
      const { summary } = buildVerdictReport(verdict, outcome('fail'), outcome('pass'), CONTEXT);
      expect(summary.startsWith(lead)).toBe(true);
    }
  });

  it('keeps the five summary blocks in the documented order', () => {
    const a = outcome('fail', { logExcerpt: 'run a log' });
    const b = outcome('pass', { logExcerpt: 'run b log' });
    const { summary } = buildVerdictReport('verified-fix', a, b, CONTEXT);

    const markers = [
      '**Verified fix**',
      '| Run A (base + new tests) | Run B (head + new tests) | Verdict |',
      '### Run A — base + new tests',
      '### Run B — head + new tests',
      'PR #7',
    ].map((marker) => summary.indexOf(marker));

    expect(markers.every((index) => index >= 0)).toBe(true);
    expect(markers).toEqual([...markers].sort((left, right) => left - right));
  });
});

describe('buildVerdictReport — matrix table', () => {
  it('renders the fired matrix combination as a one-row table', () => {
    for (const [verdict, aStatus, bStatus, name] of MATRIX_ROWS) {
      const { summary } = buildVerdictReport(verdict, outcome(aStatus), outcome(bStatus), CONTEXT);

      expect(summary).toContain(
        '| Run A (base + new tests) | Run B (head + new tests) | Verdict |',
      );
      expect(summary).toContain(`| ${aStatus} | ${bStatus} | ${name} |`);
    }
  });

  it('renders the FAIL + PASS row for a verified fix', () => {
    const { summary } = buildVerdictReport('verified-fix', outcome('fail'), outcome('pass'), CONTEXT);

    expect(summary).toContain('| fail | pass | Verified fix |');
  });
});

describe('buildVerdictReport — Run A / Run B sections', () => {
  it('renders both headings with each log excerpt verbatim inside a details element', () => {
    const aLog = 'FAILED tests/test_total.py::test_total - AssertionError: 3 != 4';
    const bLog = '1 passed in 0.42s';
    const a = outcome('fail', { logExcerpt: aLog });
    const b = outcome('pass', { logExcerpt: bLog });

    const { summary } = buildVerdictReport('verified-fix', a, b, CONTEXT);

    expect(summary).toContain('### Run A — base + new tests');
    expect(summary).toContain('### Run B — head + new tests');
    expect(summary).toContain(detailsBlock(aLog));
    expect(summary).toContain(detailsBlock(bLog));
  });

  it('renders a status line with the run status, exit code and duration', () => {
    const a = outcome('fail', { exitCode: 1, durationMs: 400 });
    const b = outcome('pass', { exitCode: 0, durationMs: 1200 });

    const { summary } = buildVerdictReport('verified-fix', a, b, {
      ...CONTEXT,
      durationMs: 1600,
    });

    expect(summary).toContain('Status: **fail** · exit 1 · 0.4s');
    expect(summary).toContain('Status: **pass** · exit 0 · 1.2s');
  });

  it('renders a null exit code as "no exit code"', () => {
    const a = outcome('timeout', { exitCode: null, durationMs: 30000 });
    const b = outcome('error', { exitCode: null, durationMs: 100 });

    const { summary } = buildVerdictReport('environment-failure', a, b, {
      ...CONTEXT,
      durationMs: 30100,
    });

    expect(summary).toContain('Status: **timeout** · no exit code · 30.0s');
    expect(summary).toContain('Status: **error** · no exit code · 0.1s');
    expect(summary).not.toContain('exit null');
  });

  it('renders an empty excerpt as a placeholder instead of a details block', () => {
    const { summary } = buildVerdictReport('weak-test', outcome('pass'), outcome('pass'), CONTEXT);

    expect(summary.match(/_No output captured\._/g)).toHaveLength(2);
    expect(summary).not.toContain('<details>');
    expect(fenceLineCount(summary)).toBe(0);
  });

  it('renders non-finite durations as 0.0s rather than NaN', () => {
    const a = outcome('fail', { durationMs: Number.NaN });
    const b = outcome('pass', { durationMs: Number.NEGATIVE_INFINITY });

    const { summary } = buildVerdictReport('verified-fix', a, b, {
      ...CONTEXT,
      durationMs: Number.NaN,
    });

    expect(summary).not.toContain('NaN');
    expect(summary).toContain('Status: **fail** · exit 1 · 0.0s');
    expect(summary).toContain('total 0.0s');
  });
});

describe('buildVerdictReport — fence safety', () => {
  it('neutralises backtick fences embedded in a log excerpt', () => {
    const hostile = 'before\n```\nconst total = 4;\n```\nafter';
    const { summary } = buildVerdictReport(
      'broken-implementation',
      outcome('fail', { logExcerpt: hostile }),
      outcome('fail', { logExcerpt: hostile }),
      CONTEXT,
    );

    // Only our two openers and two closers survive: the excerpt's own fence
    // lines are neutralised, so the rendered Markdown cannot be broken out of.
    expect(fenceLineCount(summary)).toBe(4);
    expect(summary.match(/<details><summary>stdout \/ stderr excerpt<\/summary>/g)).toHaveLength(2);
    expect(summary.match(/<\/details>/g)).toHaveLength(2);
    expect(summary).not.toContain('```\nconst total = 4;');
    expect(summary).toContain('`\u200b``\nconst total = 4;');
  });

  it('keeps simple multi-word excerpts readable and verbatim', () => {
    const log = 'E   AssertionError: assert 3 == 4\nE     +  where 4 = total(2)';
    const { summary } = buildVerdictReport(
      'broken-implementation',
      outcome('fail', { logExcerpt: log }),
      outcome('fail', { logExcerpt: log }),
      CONTEXT,
    );

    expect(summary).toContain(detailsBlock(log));
  });
});

describe('buildVerdictReport — footer', () => {
  it('reports the PR number, repo and total duration', () => {
    const { summary } = buildVerdictReport('verified-fix', outcome('fail'), outcome('pass'), CONTEXT);

    expect(summary).toContain('PR #7');
    expect(summary).toContain('octocat/hello-world');
    expect(summary).toContain('total 2.5s');
    expect(summary.trimEnd().endsWith('PR #7 · octocat/hello-world · total 2.5s')).toBe(true);
  });
});

describe('buildVerdictReport — robustness', () => {
  it('never throws, even for hostile durations and excerpts', () => {
    const hostile = outcome('error', {
      exitCode: Number.NaN,
      durationMs: Number.POSITIVE_INFINITY,
      logExcerpt: '```\r\n\tweird \u0000 output\n```',
    });

    expect(() => buildVerdictReport('environment-failure', hostile, hostile, {
      repoFullName: 'octocat/hello-world',
      prNumber: 7,
      durationMs: Number.NaN,
    })).not.toThrow();
  });
});
