'use client';

/**
 * Verdict indicator for a verification run in the ledger.
 *
 * The verdict ids are the differential matrix's outcomes
 * (docs/architecture.md, "End-to-End Verification Pipeline", step 6). Colours
 * follow the matrix's check-run semantics: a verified fix is emerald; weak,
 * mixed, and broken outcomes are amber/orange/red; a new-symbol addition is
 * neutral-blue; environment failure is slate because no PR verdict exists.
 *
 * Unknown verdicts (a newer service, a failed run) still render, slate with the
 * raw string, so the dashboard never hides a record it does not understand.
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
      'The changed tests fail on the merge base with the test patch and pass on the exact PR head.',
    className: 'border-emerald-400/35 bg-emerald-500/15 text-emerald-200',
  },
  'weak-test': {
    label: 'Weak test',
    description:
      'The changed tests pass on both the patched merge base and the exact PR head, so they do not verify the change.',
    className: 'border-amber-400/35 bg-amber-500/15 text-amber-200',
  },
  'mixed-test': {
    label: 'Mixed test evidence',
    description:
      'Some cases fail on the merge base and pass on the PR head; others pass on both. The GitHub check fails.',
    className: 'border-orange-400/35 bg-orange-500/15 text-orange-200',
  },
  'broken-implementation': {
    label: 'Broken implementation',
    description:
      'The changed tests still fail on the PR head, so the implementation is incomplete.',
    className: 'border-rose-400/35 bg-rose-500/15 text-rose-200',
  },
  'new-symbol': {
    label: 'New symbol',
    description:
      'The base commit cannot import or parse the new symbol; the PR head passes. Reported as neutral.',
    className: 'border-indigo-400/40 bg-indigo-500/20 text-indigo-200',
  },
  'environment-failure': {
    label: 'Environment failure',
    description:
      'A sandbox run errored or timed out, so no verdict about the PR could be produced.',
    className: 'border-white/15 bg-white/[0.08] text-slate-300',
  },
};

const FALLBACK_CLASS = 'border-white/15 bg-white/[0.08] text-slate-300';

export default function VerdictBadge({ verdict }: { verdict: string }) {
  const style: VerdictStyle | undefined = VERDICT_STYLES[verdict];
  const label = style?.label ?? (verdict.length > 0 ? verdict : 'unknown verdict');

  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-[0.8125rem] leading-snug font-medium tabular-nums ${
        style?.className ?? FALLBACK_CLASS
      }`}
      title={style?.description}
    >
      {label}
    </span>
  );
}
