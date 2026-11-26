'use client';

import type { RunRow } from '../lib/api';
import VerdictBadge from './VerdictBadge';

/**
 * One verification run rendered as a flat ledger entry: the PR it belongs to,
 * the verdict, both sandbox statuses, timing, the changed test files, and the
 * Run A / Run B log excerpts.
 *
 * Logs live inside `<details>` elements so a long history stays scannable while
 * the raw output is still one click away.
 */

const STATUS_TEXT_CLASSES: Record<string, string> = {
  pass: 'text-emerald-700',
  fail: 'text-red-700',
  'import-error': 'text-blue-700',
  'syntax-error': 'text-blue-700',
  timeout: 'text-amber-700',
  error: 'text-red-700',
};

const FALLBACK_STATUS_TEXT_CLASS = 'text-[var(--ink-muted)]';

function RunStatusLabel({ run, status }: { run: 'A' | 'B'; status: string }) {
  return (
    <span className="text-[var(--ink-muted)]" title={`Run ${run} status`}>
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
    <details className="overflow-hidden rounded-md bg-[var(--bg-recessed)]">
      <summary className="cursor-pointer select-none px-3 py-2 text-[0.8125rem] font-medium text-[var(--ink-primary)] transition-colors duration-150">
        {label}
        {hasLog ? null : (
          <span className="ml-2 font-normal text-[var(--ink-muted)]">(empty)</span>
        )}
      </summary>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-[var(--border-hairline)] px-3 py-2.5 font-mono text-[0.8125rem] leading-relaxed text-[var(--ink-primary)]">
        {hasLog ? log : emptyText}
      </pre>
    </details>
  );
}

export default function RunCard({ run }: { run: RunRow }) {
  return (
    <article className="px-5 py-5">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-[0.9375rem] font-semibold text-[var(--ink-primary)] tabular-nums">
            PR #{run.prNumber}
          </span>
          <VerdictBadge verdict={run.verdict} />
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem]">
            <RunStatusLabel run="A" status={run.runAStatus} />
            <span className="text-[var(--ink-muted)]" aria-hidden="true">
              vs
            </span>
            <RunStatusLabel run="B" status={run.runBStatus} />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.8125rem] text-[var(--ink-muted)] tabular-nums">
          <span>{formatDuration(run.durationMs)}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={run.createdAt}>{formatCreatedAt(run.createdAt)}</time>
        </div>
      </header>

      <div className="mt-2.5 flex flex-col gap-1.5 text-[0.8125rem]">
        <p className="font-mono text-[0.8125rem] text-[var(--ink-muted)] tabular-nums">
          {shortSha(run.baseSha)} -&gt; {shortSha(run.headSha)}
        </p>

        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="font-medium text-[var(--ink-muted)]">Changed test files:</span>
          {run.changedTestFiles.length === 0 ? (
            <span className="text-[var(--ink-muted)]">None recorded.</span>
          ) : (
            <ul className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 font-mono text-[0.8125rem] text-[var(--ink-primary)]">
              {run.changedTestFiles.map((file, index) => (
                <li key={`${file}-${String(index)}`} className="break-all">
                  {file}
                  {index < run.changedTestFiles.length - 1 ? (
                    <span className="text-[var(--ink-muted)]" aria-hidden="true">
                      ,
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="mt-3.5 grid gap-3 border-t border-[var(--border-hairline)] pt-3 md:grid-cols-2">
        <LogDetails
          label="Run A log (base + changed tests, expected: fail)"
          log={run.runALog}
          emptyText="No log output was captured for Run A."
        />
        <LogDetails
          label="Run B log (head + changed tests, expected: pass)"
          log={run.runBLog}
          emptyText="No log output was captured for Run B."
        />
      </div>
    </article>
  );
}
