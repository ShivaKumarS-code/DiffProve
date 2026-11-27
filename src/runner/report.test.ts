import { describe, expect, it } from 'vitest';

import { summarizeCaseEvidence, type CaseEvidence } from './case-evidence.js';
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
  ['mixed-test', 'Mixed reproducing and non-reproducing tests'],
  ['weak-test', 'Weak or non-reproducing test detected'],
  ['broken-implementation', 'Implementation fails its own tests'],
  ['new-symbol', 'New feature test (base import/syntax error)'],
  ['environment-failure', 'Sandbox environment failure'],
];

const LEADS: ReadonlyArray<readonly [Verdict, string]> = [
  [
    'verified-fix',
    '**Verified fix** — the targeted run failed on base and passed on head. The aggregate result does not verify every test case independently.',
  ],
  [
    'mixed-test',
    '**Mixed test evidence** — some cases failed on base and passed on head, while others passed on both.',
  ],
  [
    'weak-test',
    '**Weak or non-reproducing test** — the targeted run passed on both base and head, so it did not demonstrate a failure on base.',
  ],
  ['broken-implementation', '**Broken implementation** — the targeted run still fails on head.'],
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
  ['mixed-test', 'fail', 'pass', 'Mixed test evidence'],
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

describe('buildVerdictReport — test case evidence', () => {
  it('distinguishes unavailable evidence from a legacy report', () => {
    const a = outcome('fail');
    const b = outcome('pass');
    const old = buildVerdictReport('verified-fix', a, b, CONTEXT);
    expect(old.summary).not.toContain('### Test case evidence');
    expect(old.summary).toContain('aggregate result does not verify every test case independently');

    const attempted = buildVerdictReport('verified-fix', a, b, { ...CONTEXT, caseEvidence: null });
    expect(attempted.summary).toContain('Individual test case evidence is unavailable');
    expect(attempted.summary).not.toContain('| Test case | Base | Head |');
  });

  it('includes both transition counts and renders unknown/skipped states', () => {
    const caseEvidence: CaseEvidence = {
      reproducing: 1,
      nonReproducing: 1,
      totalCases: 3,
      cases: [
        { id: 'undetermined test', base: 'skipped', head: 'unknown' },
        { id: 'fixed test', base: 'fail', head: 'pass' },
        { id: 'weak test', base: 'pass', head: 'pass' },
      ],
    };
    const { summary } = buildVerdictReport('mixed-test', outcome('fail'), outcome('pass'), {
      ...CONTEXT,
      caseEvidence,
    });
    expect(summary).toContain('Reproducing (fail → pass): **1**');
    expect(summary).toContain('Non-reproducing (pass → pass): **1**');
    expect(summary).toContain('Total case identities: **3**');
    expect(summary).toContain('all tests run in the targeted test files, not just cases edited by the PR');
    expect(summary).toContain('| fixed test | fail | pass |');
    expect(summary).toContain('| weak test | pass | pass |');
    expect(summary).toContain('| undetermined test | skipped | unknown |');
    expect(summary.indexOf('| undetermined test')).toBeLessThan(summary.indexOf('| fixed test'));
  });

  it.each(['pass', 'fail'] as const)('keeps both transitions at the Markdown cap with 25 base %s cases', (majority) => {
    const minority = majority === 'pass' ? 'fail' : 'pass';
    const base = [
      { id: 'a skipped', status: 'skipped' as const },
      { id: 'b unknown', status: 'unknown' as const },
      ...Array.from({ length: 25 }, (_, index) => ({
        id: `common case ${String(index).padStart(2, '0')}`,
        status: majority,
      })),
      { id: 'z rare case', status: minority } as const,
    ];
    const head = base.map(({ id }) => ({ id, status: 'pass' as const }));
    const caseEvidence = summarizeCaseEvidence(base, head);
    expect(caseEvidence?.cases).toHaveLength(28);
    const { summary } = buildVerdictReport('mixed-test', outcome('fail'), outcome('pass'), {
      ...CONTEXT,
      caseEvidence,
    });
    const detailRows = summary.split('\n').filter((line) => /^\| (?:common case|z rare case) /.test(line));
    expect(detailRows).toHaveLength(20);
    expect(detailRows[0]).toBe(`| common case 00 | ${majority} | pass |`);
    expect(detailRows.at(-1)).toBe(`| z rare case | ${minority} | pass |`);
    expect(summary).not.toContain('| a skipped |');
    expect(summary).not.toContain('| b unknown |');
    expect(summary).toContain('_Showing 20 of 28 case identities._');
  });

  it('escapes hostile identifiers and clips the table more tightly than stored evidence', () => {
    const hostile = '`|<script>&\\\n@owner \u202E[click](https://evil.example) ';
    const caseEvidence: CaseEvidence = {
      reproducing: 5,
      nonReproducing: 65,
      totalCases: 120,
      cases: [
        { id: `${hostile}${'✌'.repeat(512)}DO_NOT_SHOW`, base: 'pass', head: 'pass' },
        ...Array.from({ length: 99 }, (_, i) => ({
          id: `case ${i + 2} ${'|'.repeat(512)}`,
          base: 'fail' as const,
          head: 'pass' as const,
        })),
      ],
    };
    const { summary } = buildVerdictReport(
      'mixed-test',
      outcome('fail', { logExcerpt: '🌊'.repeat(2000) }),
      outcome('pass', { logExcerpt: '🌊'.repeat(2000) }),
      { ...CONTEXT, caseEvidence },
    );
    expect(summary).toContain('&#96;&#124;&#60;script&#62;&#38;&#92; &#64;owner');
    expect(summary).not.toContain('<script>');
    expect(summary).not.toContain('@owner');
    expect(summary).not.toContain('https://evil.example');
    expect(summary).not.toContain('\u202E');
    expect(summary).not.toContain('DO_NOT_SHOW');
    expect(summary).not.toContain('| case 21 ');
    expect(summary).toContain('_Showing 20 of 120 case identities._');
    expect(summary).toContain('Total case identities: **120**');
    expect(Buffer.byteLength(summary)).toBeLessThan(65_535);
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
