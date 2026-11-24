/**
 * Structured Markdown verdict report — Phase 4 reporting.
 *
 * docs/architecture.md, "End-to-End Verification Pipeline" step 6: the worker
 * completes the GitHub Check Run with a structured Markdown summary and clipped
 * stdout/stderr excerpts from Run A and Run B. GitHub renders the check run's
 * `output.summary` (and its `output.title`) as Markdown, so this renderer is
 * where the verdict matrix becomes something a PR author can read.
 *
 * Everything below is pure: no I/O, and no exception path. Reporting a verdict
 * must never fail the worker — a non-finite duration or an exotic log excerpt
 * degrades to readable text, never to a thrown error or a broken code fence.
 */

import type { SandboxRunOutcome, Verdict } from './types.js';

/** Values the report needs that are not part of the Run A / Run B outcomes. */
export interface VerdictReportContext {
  repoFullName: string;
  prNumber: number;
  /** Total wall-clock time of both runs, reported in the footer. */
  durationMs: number;
}

/**
 * Opening verdict statement (summary block 1): the policy conclusion in one
 * line, phrased for a PR author rather than for the matrix table.
 */
const LEAD_BY_VERDICT: Record<Verdict, string> = {
  'verified-fix':
    '**Verified fix** — Run A failed on the base commit as expected and Run B passes on head. The new tests genuinely reproduce the PR change.',
  'weak-test':
    '**Weak or non-reproducing test** — the new tests pass on the base commit too, so they do not verify the PR change.',
  'broken-implementation':
    '**Broken implementation** — the PR still fails its own new tests on head.',
  'new-symbol':
    '**New feature test** — Run A fails with an import or syntax error, which is expected when a PR introduces a new symbol, and Run B passes. Annotated as neutral rather than a failure.',
  'environment-failure':
    '**Sandbox environment failure** — the runs could not be executed reliably. This is not a verdict on the PR itself.',
};

/**
 * Check-run titles. Wording is unchanged from Phase 3 so the PR checks UI
 * stays consistent across the Phase 4 upgrade.
 */
const TITLE_BY_VERDICT: Record<Verdict, string> = {
  'verified-fix': 'Differential verification passed',
  'weak-test': 'Weak or non-reproducing test detected',
  'broken-implementation': 'Implementation fails its own tests',
  'new-symbol': 'New feature test (base import/syntax error)',
  'environment-failure': 'Sandbox environment failure',
};

/** The verdict's human name, used as the matrix table row's third column. */
const NAME_BY_VERDICT: Record<Verdict, string> = {
  'verified-fix': 'Verified fix',
  'weak-test': 'Weak / non-reproducing test',
  'broken-implementation': 'Broken implementation',
  'new-symbol': 'New feature test',
  'environment-failure': 'Sandbox environment failure',
};

const RUN_A_HEADING = 'Run A — base + new tests';
const RUN_B_HEADING = 'Run B — head + new tests';

/** Formats milliseconds as seconds with exactly one decimal, e.g. 400 → "0.4s". */
function formatSeconds(durationMs: number): string {
  const safeMs = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
  return `${(safeMs / 1000).toFixed(1)}s`;
}

/** Renders a run's exit code as `exit <n>`, or `no exit code` when unknown. */
function formatExitCode(exitCode: number | null): string {
  return exitCode === null || !Number.isFinite(exitCode) ? 'no exit code' : `exit ${exitCode}`;
}

/**
 * Neutralises code-fence delimiters inside a log excerpt.
 *
 * Logs routinely contain the three-backtick fence marker itself (a nested
 * Markdown example, a diff, a snapshot). Emitted verbatim it would close our
 * fence early, let the rest of the excerpt become live Markdown and hide the
 * real failure behind arbitrary formatting. Each "```" is rewritten as
 * "`<zero-width space>``": the reader still sees three backticks, but no run of
 * three backticks remains for a Markdown parser to treat as a fence.
 */
function escapeFenceBreakers(logExcerpt: string): string {
  return logExcerpt.split('```').join('`\u200b``');
}

/**
 * Renders one run's log excerpt: a collapsed `<details>` element containing a
 * fenced block, or a plain placeholder when nothing was captured.
 */
function renderExcerpt(logExcerpt: string): string {
  if (logExcerpt.length === 0) {
    return '_No output captured._';
  }

  return [
    '<details><summary>stdout / stderr excerpt</summary>',
    '',
    '```',
    escapeFenceBreakers(logExcerpt),
    '```',
    '',
    '</details>',
  ].join('\n');
}

/** Renders one run section: heading, status line, and its log excerpt. */
function renderRun(heading: string, outcome: SandboxRunOutcome): string {
  const statusLine =
    `Status: **${outcome.status}** · ${formatExitCode(outcome.exitCode)}` +
    ` · ${formatSeconds(outcome.durationMs)}`;

  return `### ${heading}\n\n${statusLine}\n\n${renderExcerpt(outcome.logExcerpt)}`;
}

/**
 * Builds the Markdown check-run title and summary for a verdict.
 *
 * The summary has exactly five blocks, in this order:
 *   1. the verdict statement (bold lead),
 *   2. the fired matrix row as a one-row table,
 *   3. Run A's heading, status line and log excerpt,
 *   4. Run B's heading, status line and log excerpt,
 *   5. a provenance footer (PR, repo, total duration).
 */
export function buildVerdictReport(
  verdict: Verdict,
  a: SandboxRunOutcome,
  b: SandboxRunOutcome,
  ctx: VerdictReportContext,
): { title: string; summary: string } {
  const matrixRow = [
    '| Run A (base + new tests) | Run B (head + new tests) | Verdict |',
    '| :--- | :--- | :--- |',
    `| ${a.status} | ${b.status} | ${NAME_BY_VERDICT[verdict]} |`,
  ].join('\n');

  const footer = `PR #${ctx.prNumber} · ${ctx.repoFullName} · total ${formatSeconds(ctx.durationMs)}`;

  return {
    title: TITLE_BY_VERDICT[verdict],
    summary: [
      LEAD_BY_VERDICT[verdict],
      matrixRow,
      renderRun(RUN_A_HEADING, a),
      renderRun(RUN_B_HEADING, b),
      footer,
    ].join('\n\n'),
  };
}
