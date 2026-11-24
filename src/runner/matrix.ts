/**
 * Verdict matrix — Phase 3 pure differential policy.
 *
 * docs/architecture.md, "End-to-End Verification Pipeline" step 6:
 *
 * | Run A (Base + New Tests)   | Run B (Head + New Tests) | Verdict                    |
 * | :------------------------- | :----------------------- | :------------------------- |
 * | FAIL                       | PASS                     | Verified Fix / Valid Test  |
 * | PASS                       | PASS                     | Weak / Non-Reproducing Test|
 * | FAIL                       | FAIL                     | Broken Implementation      |
 * | SYNTAX / IMPORT ERROR      | PASS                     | New Symbol Test            |
 * | ERROR / TIMEOUT on either  | ANY                      | Sandbox / Env Setup Failure|
 *
 * Check-run conclusions follow the matrix's fourth column:
 * verified-fix → success, weak-test/broken-implementation → failure,
 * new-symbol/environment-failure → neutral.
 *
 * Plain text only: rich Markdown rendering is Phase 4 (`verdict-report.ts`).
 */

import type { RunStatus, SandboxRunOutcome, Verdict } from './types.js';

/** GitHub check-run conclusion for a verdict. */
export type CheckConclusion = 'success' | 'failure' | 'neutral';

/** Statuses that mean "the sandbox could not execute the run reliably". */
function isEnvironmentStatus(status: RunStatus): boolean {
  return status === 'timeout' || status === 'error';
}

/** Formats a millisecond duration as seconds with exactly one decimal, e.g. 1200 → "1.2s". */
function formatDurationSeconds(durationMs: number): string {
  const safeMs = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
  return `${(safeMs / 1000).toFixed(1)}s`;
}

/**
 * Maps Run A / Run B statuses to the verdict matrix.
 *
 * Error and timeout dominate: if either run never produced a trustworthy
 * result, no statement about the PR can be made (row 5).
 *
 * Every combination the matrix does not define — including PASS+FAIL, which
 * would mean base passes while head fails — falls back to
 * `environment-failure` (conservative: never claim a PR is verified or broken
 * from an output combination the architecture does not sanction).
 */
export function verdictFrom(a: SandboxRunOutcome, b: SandboxRunOutcome): Verdict {
  if (isEnvironmentStatus(a.status) || isEnvironmentStatus(b.status)) {
    return 'environment-failure';
  }

  // Row 1: the test failed on base and passes on head → it reproduces the change.
  if (a.status === 'fail' && b.status === 'pass') {
    return 'verified-fix';
  }
  // Row 2: the test never failed on base → it cannot verify anything.
  if (a.status === 'pass' && b.status === 'pass') {
    return 'weak-test';
  }
  // Row 3: head still fails its own new tests.
  if (a.status === 'fail' && b.status === 'fail') {
    return 'broken-implementation';
  }
  // Row 4: base cannot even import/parse the newly introduced symbol, head passes.
  if ((a.status === 'import-error' || a.status === 'syntax-error') && b.status === 'pass') {
    return 'new-symbol';
  }

  // Undefined by the matrix (e.g. pass+fail, import-error+fail): stay neutral.
  return 'environment-failure';
}

const CONCLUSION_BY_VERDICT: Record<Verdict, CheckConclusion> = {
  'verified-fix': 'success',
  'weak-test': 'failure',
  'broken-implementation': 'failure',
  'new-symbol': 'neutral',
  'environment-failure': 'neutral',
};

/** GitHub check-run conclusion for a verdict (matrix column 4). */
export function conclusionForVerdict(verdict: Verdict): CheckConclusion {
  return CONCLUSION_BY_VERDICT[verdict];
}

/**
 * Builds the plain-text check-run title and summary for a verdict.
 *
 * `durationMs` is the total wall-clock duration reported to GitHub; each run's
 * own duration is taken from the outcome that the summary talks about.
 */
export function describeVerdict(
  verdict: Verdict,
  a: SandboxRunOutcome,
  b: SandboxRunOutcome,
  durationMs: number,
): { title: string; summary: string } {
  const total = formatDurationSeconds(durationMs);

  switch (verdict) {
    case 'verified-fix':
      return {
        title: 'Differential verification passed',
        summary: `Run A (base + new tests) failed as expected; Run B (head + new tests) passed in ${formatDurationSeconds(b.durationMs)}. The new tests reproduce the PR change. Total: ${total}.`,
      };
    case 'weak-test':
      return {
        title: 'Weak or non-reproducing test detected',
        summary: `Run A (base + new tests) passed — the new tests did not fail on the base commit; Run B passed as well. The tests do not verify the PR change. Total: ${total}.`,
      };
    case 'broken-implementation':
      return {
        title: 'Implementation fails its own tests',
        summary: `Run A failed as expected, but Run B (head + new tests) also failed in ${formatDurationSeconds(b.durationMs)}. Total: ${total}.`,
      };
    case 'new-symbol':
      return {
        title: 'New feature test (base import/syntax error)',
        summary: `Run A failed with an import or syntax error (expected for newly introduced symbols), and Run B passed in ${formatDurationSeconds(b.durationMs)}. Total: ${total}.`,
      };
    case 'environment-failure':
      return {
        title: 'Sandbox environment failure',
        summary: `Run A/B could not be executed reliably (status: ${a.status}/${b.status}). This is not a verdict on the PR itself. Total: ${total}.`,
      };
  }
}
