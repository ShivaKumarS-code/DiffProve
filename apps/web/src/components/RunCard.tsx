'use client';

import type { CaseEvidence, RunRow } from '../lib/api';
import VerdictBadge from './VerdictBadge';

/**
 * One verification run rendered as a flat ledger entry: the PR it belongs to,
 * the verdict, both sandbox statuses, timing, the changed test files, and the
 * Run A / Run B log excerpts and any recorded case evidence.
 *
 * Logs live inside `<details>` elements so a long history stays scannable while
 * the raw output is still one click away.
 */

const STATUS_TEXT_CLASSES: Record<string, string> = {
  pass: 'text-emerald-300',
  fail: 'text-rose-300',
  'import-error': 'text-indigo-300',
  'syntax-error': 'text-indigo-300',
  timeout: 'text-amber-300',
  error: 'text-rose-300',
  skipped: 'text-slate-400',
  unknown: 'text-slate-400',
};

const FALLBACK_STATUS_TEXT_CLASS = 'text-slate-300';

function RunStatusLabel({ run, status }: { run: 'A' | 'B'; status: string }) {
  return (
    <span className="text-slate-400" title={`Run ${run} status`}>
      Run {run}:{' '}
      <span
        className={`font-mono font-medium ${
          STATUS_TEXT_CLASSES[status] ?? FALLBACK_STATUS_TEXT_CLASS
        }`}
      >
        {status}
      </span>
    </span>
  );
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return '-';
  }
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function formatCreatedAt(createdAt: string): string {
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime()) ? createdAt : date.toLocaleString();
}

function shortSha(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

function LogDetails({
  label,
  log,
  emptyText,
}: {
  label: string;
  log: string;
  emptyText: string;
}) {
  const hasLog = log.trim().length > 0;

  return (
    <details className="overflow-hidden rounded-xl border border-white/10 bg-[#060814]/85">
      <summary className="cursor-pointer select-none px-3.5 py-2.5 text-[0.8125rem] font-medium text-slate-200 transition-colors duration-150 hover:bg-white/[0.04] hover:text-white">
        {label}
        {hasLog ? null : (
          <span className="ml-2 font-normal text-slate-400">(empty)</span>
        )}
      </summary>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-white/10 px-3.5 py-3 font-mono text-[0.8125rem] leading-relaxed text-slate-200">
        {hasLog ? log : emptyText}
      </pre>
    </details>
  );
}

function CaseEvidenceDetails({ evidence }: { evidence: CaseEvidence }) {
  const { reproducing, nonReproducing, totalCases, cases } = evidence;
  return (
    <details className="mt-3.5 overflow-hidden rounded-xl border border-white/10 bg-[#060814]/85">
      <summary className="cursor-pointer select-none px-3.5 py-2.5 text-[0.8125rem] font-medium text-slate-200 hover:bg-white/[0.04] hover:text-white">
        Case evidence:{' '}
        <span className="font-normal tabular-nums text-slate-300">
          {reproducing} reproducing · {nonReproducing} non-reproducing · {totalCases} total
        </span>
      </summary>
      <div className="space-y-2 border-t border-white/10 px-3.5 py-3 text-[0.8125rem]">
        <p className="text-slate-400">
          Reported by the runs targeting changed test files. May not cover every edited case.
        </p>
        {cases.length === 0 ? null : (
          <ul className="divide-y divide-white/10">
            {cases.map(({ id, base, head }, index) => (
              <li key={index} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5">
                <bdi className="break-all font-mono text-slate-200">{id}</bdi>
                <span className="flex gap-2 whitespace-nowrap">
                  <RunStatusLabel run="A" status={base} />
                  <span className="text-slate-400" aria-hidden="true">
                    →
                  </span>
                  <RunStatusLabel run="B" status={head} />
                </span>
              </li>
            ))}
          </ul>
        )}
        {cases.length < totalCases ? (
          <p className="text-slate-400">Showing {cases.length} of {totalCases} cases.</p>
        ) : null}
      </div>
    </details>
  );
}

export default function RunCard({ run }: { run: RunRow }) {
  return (
    <article className="px-5 py-5 sm:px-6 transition-colors duration-150 hover:bg-white/[0.025]">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-[0.9375rem] font-semibold text-white tabular-nums">
            PR #{run.prNumber}
          </span>
          <VerdictBadge verdict={run.verdict} />
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem]">
            <RunStatusLabel run="A" status={run.runAStatus} />
            <span className="text-slate-400" aria-hidden="true">
              vs
            </span>
            <RunStatusLabel run="B" status={run.runBStatus} />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.8125rem] text-slate-400 tabular-nums">
          <span>{formatDuration(run.durationMs)}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={run.createdAt}>{formatCreatedAt(run.createdAt)}</time>
        </div>
      </header>

      <div className="mt-2.5 flex flex-col gap-1.5 text-[0.8125rem]">
        <p className="font-mono text-[0.8125rem] text-slate-400 tabular-nums">
          {shortSha(run.baseSha)} -&gt; {shortSha(run.headSha)}
        </p>

        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="font-medium text-slate-400">Changed test files:</span>
          {run.changedTestFiles.length === 0 ? (
            <span className="text-slate-400">None recorded.</span>
          ) : (
            <ul className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 font-mono text-[0.8125rem] text-slate-200">
              {run.changedTestFiles.map((file, index) => (
                <li key={`${file}-${String(index)}`} className="break-all">
                  {file}
                  {index < run.changedTestFiles.length - 1 ? (
                    <span className="text-slate-400" aria-hidden="true">
                      ,
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {run.caseEvidence ? <CaseEvidenceDetails evidence={run.caseEvidence} /> : null}

      <div className="mt-3.5 grid gap-3 border-t border-white/10 pt-3 md:grid-cols-2">
        <LogDetails
          label="Run A log (merge base + test patch, expected: fail)"
          log={run.runALog}
          emptyText="No log output was captured for Run A."
        />
        <LogDetails
          label="Run B log (exact PR head, expected: pass)"
          log={run.runBLog}
          emptyText="No log output was captured for Run B."
        />
      </div>
    </article>
  );
}
