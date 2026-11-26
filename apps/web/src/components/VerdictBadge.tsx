'use client';

/**
 * Verdict indicator for a verification run in the ledger.
 *
 * The five verdict ids are the differential matrix's outcomes
 * (docs/architecture.md, "End-to-End Verification Pipeline", step 6). Colours
 * follow the matrix's check-run semantics: a verified fix is emerald, weak and
 * broken outcomes are amber/red, a new-symbol addition is neutral-blue, and an
 * environment failure is slate because no verdict about the PR exists.
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
      'The changed tests fail on the base commit and pass on the PR head, so they verify the change.',
    className: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  },
  'weak-test': {
    label: 'Weak test',
    description:
      'The changed tests pass on both the base commit and the PR head, so they cannot verify the change.',
    className: 'border-amber-300 bg-amber-50 text-amber-900',
  },
  'broken-implementation': {
    label: 'Broken implementation',
    description:
      'The changed tests still fail on the PR head, so the implementation is incomplete.',
    className: 'border-red-300 bg-red-50 text-red-900',
  },
  'new-symbol': {
    label: 'New symbol',
    description:
      'The base commit cannot import or parse the new symbol; the PR head passes. Reported as neutral.',
    className: 'border-blue-300 bg-blue-50 text-blue-900',
  },
  'environment-failure': {
    label: 'Environment failure',
    description:
      'A sandbox run errored or timed out, so no verdict about the PR could be produced.',
    className: 'border-slate-300 bg-slate-100 text-slate-700',
  },
};

const FALLBACK_CLASS = 'border-slate-300 bg-slate-100 text-slate-700';

export default function VerdictBadge({ verdict }: { verdict: string }) {
  const style: VerdictStyle | undefined = VERDICT_STYLES[verdict];
  const label = style?.label ?? (verdict.length > 0 ? verdict : 'unknown verdict');

  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-md border px-2 py-0.5 text-[0.8125rem] leading-snug font-medium tabular-nums ${
        style?.className ?? FALLBACK_CLASS
      }`}
      title={style?.description}
    >
      {label}
    </span>
  );
}
