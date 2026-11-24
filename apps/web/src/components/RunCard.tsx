'use client';

import type { RunRow } from '../lib/api';
import VerdictBadge from './VerdictBadge';

/**
 * One verification run: the PR it belongs to, the verdict, both sandbox
 * statuses, timing, the changed test files, and the Run A / Run B log excerpts.
 *
 * Logs live inside `<details>` elements so a long history stays scannable while
 * the raw output is still one click away.
 */

const STATUS_CHIP_CLASSES: Record<string, string> = {
  pass: 'border-green-500/30 bg-green-500/10 text-green-300',
  fail: 'border-red-500/30 bg-red-500/10 text-red-300',
  'import-error': 'border-blue-500/30 bg-blue-500/10 text-blue-300',
  'syntax-error': 'border-blue-500/30 bg-blue-500/10 text-blue-300',
  timeout: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  error: 'border-red-500/30 bg-red-500/10 text-red-300',
};

const FALLBACK_STATUS_CLASSES = 'border-neutral-500/30 bg-neutral-500/10 text-neutral-300';

function StatusChip({ run, status }: { run: 'A' | 'B'; status: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px] ${
        STATUS_CHIP_CLASSES[status] ?? FALLBACK_STATUS_CLASSES
      }`}
      title={`Run ${run} status`}
    >
      <span className="font-sans text-neutral-400">run {run}</span>
      {status}
    </span>
  );
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return '—';
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
    <details className="overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950/60">
      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-neutral-300 transition-colors hover:bg-neutral-900/60 hover:text-neutral-100">
        {label}
        {hasLog ? null : <span className="ml-2 font-normal text-neutral-500">(empty)</span>}
      </summary>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-neutral-800 px-3 py-2 text-xs leading-relaxed text-neutral-300">
        {hasLog ? log : emptyText}
      </pre>
    </details>
  );
}

export default function RunCard({ run }: { run: RunRow }) {
  return (
    <article className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-sm font-semibold text-neutral-100">PR #{run.prNumber}</span>
        <VerdictBadge verdict={run.verdict} />
        <StatusChip run="A" status={run.runAStatus} />
        <StatusChip run="B" status={run.runBStatus} />
        <span className="text-xs text-neutral-400">{formatDuration(run.durationMs)}</span>
        <span className="ml-auto text-xs text-neutral-400">
          {formatCreatedAt(run.createdAt)}
        </span>
      </header>

      <p className="mt-2 font-mono text-[11px] text-neutral-500">
        {shortSha(run.baseSha)} → {shortSha(run.headSha)}
      </p>

      <div className="mt-3">
        <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          Changed test files
        </h3>
        {run.changedTestFiles.length === 0 ? (
          <p className="mt-1 text-xs text-neutral-500">None recorded.</p>
        ) : (
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {run.changedTestFiles.map((file, index) => (
              <li
                key={`${file}-${String(index)}`}
                className="rounded bg-neutral-800/80 px-1.5 py-0.5 font-mono text-[11px] text-neutral-300"
              >
                {file}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-3 space-y-2">
        <LogDetails
          label="Run A log — base commit + changed tests (expected: fail)"
          log={run.runALog}
          emptyText="No log output was captured for Run A."
        />
        <LogDetails
          label="Run B log — head commit + changed tests (expected: pass)"
          log={run.runBLog}
          emptyText="No log output was captured for Run B."
        />
      </div>
    </article>
  );
}
