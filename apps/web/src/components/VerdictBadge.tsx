'use client';

/**
 * Verdict pill for a verification run.
 *
 * The five verdict ids are the differential matrix's outcomes
 * (docs/architecture.md, "End-to-end Verification Pipeline", step 6). Colours
 * follow the matrix's check-run semantics: a verified fix is green, weak and
 * broken outcomes are warnings/failures, a new-symbol addition is neutral-blue,
 * and an environment failure is grey because no verdict about the PR exists.
 *
 * Unknown verdicts (a newer service, a failed run) still render — grey with the
 * raw string — so the dashboard never hides a record it does not understand.
 */

interface VerdictStyle {
  label: string;
  description: string;
  className: string;
}

const VERDICT_STYLES: Record<string, VerdictStyle> = {
  'verified-fix': {
    label: 'Verified fix',
    description:
      'The changed tests fail on the base commit and pass on the PR head — they verify the change.',
    className: 'border-green-500/30 bg-green-500/10 text-green-300',
  },
  'weak-test': {
    label: 'Weak test',
    description:
      'The changed tests pass on both the base commit and the PR head — they cannot verify the change.',
    className: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  },
  'broken-implementation': {
    label: 'Broken implementation',
    description:
      'The changed tests still fail on the PR head, so the implementation is incomplete.',
    className: 'border-red-500/30 bg-red-500/10 text-red-300',
  },
  'new-symbol': {
    label: 'New symbol',
    description:
      'The base commit cannot import or parse the new symbol; the PR head passes. Reported as neutral.',
    className: 'border-blue-500/30 bg-blue-500/10 text-blue-300',
  },
  'environment-failure': {
    label: 'Environment failure',
    description:
      'A sandbox run errored or timed out, so no verdict about the PR could be produced.',
    className: 'border-neutral-500/30 bg-neutral-500/10 text-neutral-300',
  },
};

const FALLBACK_CLASS = 'border-neutral-500/30 bg-neutral-500/10 text-neutral-300';

export default function VerdictBadge({ verdict }: { verdict: string }) {
  const style: VerdictStyle | undefined = VERDICT_STYLES[verdict];
  const label = style?.label ?? (verdict.length > 0 ? verdict : 'unknown verdict');

  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${
        style?.className ?? FALLBACK_CLASS
      }`}
      title={style?.description}
    >
      {label}
    </span>
  );
}
