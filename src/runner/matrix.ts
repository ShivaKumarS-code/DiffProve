/**
 * Verdict matrix — Phase 3 pure differential policy.
 *
 * docs/architecture.md, "End-to-End Verification Pipeline" step 6:
 *
 * | Run A (Base + New Tests)   | Run B (Head + New Tests) | Verdict                    |
 * | :------------------------- | :----------------------- | :------------------------- |
 * | FAIL                       | PASS                     | Verified Fix or Mixed Tests |
 * | PASS                       | PASS                     | Weak / Non-Reproducing Test|
 * | FAIL                       | FAIL                     | Broken Implementation      |
 * | SYNTAX / IMPORT ERROR      | PASS                     | New Symbol Test            |
 * | ERROR / TIMEOUT on either  | ANY                      | Sandbox / Env Setup Failure|
 *
 * Check-run conclusions follow the matrix's fourth column:
 * verified-fix → success, mixed-test/weak-test/broken-implementation → failure,
 * new-symbol/environment-failure → neutral.
 *
 * Plain policy only: the Markdown check-run report is built in
 * `src/runner/report.ts` from the verdict and the two run outcomes.
 */

import type { CaseEvidence } from './case-evidence.js';
import type { RunStatus, SandboxRunOutcome, Verdict } from './types.js';

/** GitHub check-run conclusion for a verdict. */
export type CheckConclusion = 'success' | 'failure' | 'neutral';

/** Statuses that mean "the sandbox could not execute the run reliably". */
function isEnvironmentStatus(status: RunStatus): boolean {
  return status === 'timeout' || status === 'error';
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
export function verdictFrom(
  a: SandboxRunOutcome,
  b: SandboxRunOutcome,
  evidence?: CaseEvidence | null,
): Verdict {
  if (isEnvironmentStatus(a.status) || isEnvironmentStatus(b.status)) {
    return 'environment-failure';
  }

  // Row 1: the aggregate changed from fail to pass. If we can also prove
  // that some cases already passed on base, do not mark the whole check green.
  if (a.status === 'fail' && b.status === 'pass') {
    if (evidence && evidence.reproducing > 0 && evidence.nonReproducing > 0) {
      return 'mixed-test';
    }
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
  'mixed-test': 'failure',
  'weak-test': 'failure',
  'broken-implementation': 'failure',
  'new-symbol': 'neutral',
  'environment-failure': 'neutral',
};

/** GitHub check-run conclusion for a verdict (matrix column 4). */
export function conclusionForVerdict(verdict: Verdict): CheckConclusion {
  return CONCLUSION_BY_VERDICT[verdict];
}
