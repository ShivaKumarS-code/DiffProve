'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import RepoConfigForm from '../../../components/RepoConfigForm';
import RunCard from '../../../components/RunCard';
import {
  getRepoRuns,
  toApiError,
  type ApiError,
  type RepoRunsResponse,
  type RunRow,
} from '../../../lib/api';

/**
 * Repository detail: verification history, the weak-test catch rate, and the
 * editable test configuration.
 *
 * The dynamic `id` is read with `useParams()` inside a client component, which
 * avoids Next 15's async `params` prop entirely.
 */

/** Shown when the service answers 503 because it has no `DATABASE_URL`. */
const DATABASE_HINT =
  'Start Postgres (`docker compose up -d postgres`) and set DATABASE_URL on the service.';

const SPECTRUM_TICK_COUNT = 36;

const VERDICT_FILTER_OPTIONS = [
  { value: 'all', label: 'All verdicts' },
  { value: 'verified-fix', label: 'Verified fix' },
  { value: 'weak-test', label: 'Weak test' },
  { value: 'mixed-test', label: 'Mixed test evidence' },
  { value: 'broken-implementation', label: 'Broken implementation' },
  { value: 'new-symbol', label: 'New symbol' },
  { value: 'environment-failure', label: 'Environment failure' },
] as const;

const VERDICT_LABELS: Record<string, string> = {
  'verified-fix': 'Verified fix',
  'weak-test': 'Weak test',
  'mixed-test': 'Mixed test evidence',
  'broken-implementation': 'Broken implementation',
  'new-symbol': 'New symbol',
  'environment-failure': 'Environment failure',
};

function languageLabel(language: RepoRunsResponse['repository']['language']): string {
  if (language === 'python') {
    return 'Python · pytest';
  }
  if (language === 'node') {
    return 'Node · vitest / jest';
  }
  return 'Unknown language';
}

/** `null` catch rate means "no runs yet", which must not render as 0%. */
function formatCatchRate(catchRate: number | null): string {
  return catchRate === null ? '-' : `${(catchRate * 100).toFixed(1)}%`;
}

function verdictLabel(verdict: string | undefined): string {
  if (verdict === undefined || verdict.length === 0) {
    return 'None yet';
  }
  return VERDICT_LABELS[verdict] ?? verdict;
}

/**
 * Maps recorded verification runs onto 36 proportional spectrum ticks.
 * Returns `null` entries when no runs exist so the bar renders dormant ticks.
 */
function buildSpectrumTicks(runs: RunRow[]): Array<string | null> {
  if (runs.length === 0) {
    return Array<null>(SPECTRUM_TICK_COUNT).fill(null);
  }

  let brokenCount = 0;
  let mixedCount = 0;
  let weakCount = 0;
  let neutralCount = 0;
  let verifiedCount = 0;

  for (const run of runs) {
    if (run.verdict === 'broken-implementation') {
      brokenCount += 1;
    } else if (run.verdict === 'mixed-test') {
      mixedCount += 1;
    } else if (run.verdict === 'weak-test') {
      weakCount += 1;
    } else if (run.verdict === 'verified-fix') {
      verifiedCount += 1;
    } else {
      neutralCount += 1;
    }
  }

  const buckets = [
    { color: '#fb7185', count: brokenCount },
    { color: '#fb923c', count: mixedCount },
    { color: '#fbbf24', count: weakCount },
    { color: '#818cf8', count: neutralCount },
    { color: '#34d399', count: verifiedCount },
  ].filter((bucket) => bucket.count > 0);

  const total = runs.length;
  const exact = buckets.map((bucket) => (bucket.count / total) * SPECTRUM_TICK_COUNT);
  const counts = exact.map((value) => Math.floor(value));
  const remaining = SPECTRUM_TICK_COUNT - counts.reduce((sum, count) => sum + count, 0);

  const remainders = exact
    .map((value, index) => ({ index, remainder: value - counts[index] }))
    .sort((a, b) => b.remainder - a.remainder);

  for (let index = 0; index < remaining; index += 1) {
    counts[remainders[index % remainders.length].index] += 1;
  }

  // Keep every present verdict category visible with at least one tick.
  for (let index = 0; index < counts.length; index += 1) {
    if (counts[index] === 0) {
      let donorIndex = 0;
      for (let candidate = 1; candidate < counts.length; candidate += 1) {
        if (counts[candidate] > counts[donorIndex]) {
          donorIndex = candidate;
        }
      }
      if (counts[donorIndex] > 1) {
        counts[donorIndex] -= 1;
        counts[index] = 1;
      }
    }
  }

  const ticks: Array<string | null> = [];
  for (let index = 0; index < buckets.length; index += 1) {
    for (let tick = 0; tick < counts[index]; tick += 1) {
      ticks.push(buckets[index].color);
    }
  }
  return ticks;
}

function DetailSkeleton() {
  return (
    <div role="status" className="space-y-6">
      <span className="sr-only">Loading repository...</span>
      <div className="space-y-3">
        <div className="h-4 w-32 animate-pulse rounded bg-white/10" />
        <div className="h-9 w-72 animate-pulse rounded bg-white/10" />
        <div className="h-4 w-56 animate-pulse rounded bg-white/10" />
      </div>

      <div className="glass-panel rounded-2xl p-6 sm:p-7">
        <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_320px] md:items-center">
          <div className="space-y-3">
            <div className="h-4 w-36 animate-pulse rounded bg-white/10" />
            <div className="h-14 w-32 animate-pulse rounded bg-white/10" />
          </div>
          <div className="space-y-3">
            {[0, 1, 2, 3].map((row) => (
              <div key={row} className="flex items-center justify-between gap-4">
                <div className="h-4 w-28 animate-pulse rounded bg-white/10" />
                <div className="h-4 w-16 animate-pulse rounded bg-white/10" />
              </div>
            ))}
          </div>
        </div>
        <div className="mt-6 border-t border-white/10 pt-5">
          <div className="h-4 w-full animate-pulse rounded bg-white/10" />
          <div className="mt-3 h-4 w-48 animate-pulse rounded bg-white/10" />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
        <div className="glass-panel h-64 animate-pulse rounded-2xl" />
        <div className="glass-panel h-80 animate-pulse rounded-2xl" />
      </div>
    </div>
  );
}

function LoadError({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  const databaseNotConfigured = error.message.includes('database not configured');

  return (
    <div
      role="alert"
      className="rounded-2xl border border-red-400/30 bg-red-950/35 p-5 backdrop-blur-md"
    >
      <p className="text-[0.875rem] font-semibold text-red-200">
        Could not load this repository
      </p>
      <p className="mt-1 break-words text-[0.875rem] text-red-100/90">{error.message}</p>

      {databaseNotConfigured ? (
        <p className="mt-3 rounded-xl border border-red-400/20 bg-[#060813]/80 px-3.5 py-2.5 text-[0.8125rem] text-slate-200">
          Setup: {DATABASE_HINT}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onRetry}
          className="rounded-xl border border-red-300/30 bg-red-500/15 px-3.5 py-1.5 text-[0.8125rem] font-medium text-red-100 transition-colors duration-150 hover:bg-red-500/25"
        >
          Retry
        </button>
        <Link
          href="/"
          className="text-[0.8125rem] font-medium text-indigo-300 transition-colors duration-150 hover:text-white"
        >
          &lt;- All repositories
        </Link>
      </div>
    </div>
  );
}

function NotFound({ repositoryId }: { repositoryId: string }) {
  return (
    <div className="glass-panel space-y-3 rounded-2xl p-6">
      <h1 className="text-[1.5rem] font-bold tracking-[-0.02em] text-white">
        Repository not found.
      </h1>
      <p className="text-[0.875rem] text-slate-300">
        No repository with id{' '}
        <span className="font-mono text-white">{repositoryId}</span> is registered with this
        DiffProve installation.
      </p>
      <Link
        href="/"
        className="inline-flex text-[0.8125rem] font-medium text-indigo-300 transition-colors duration-150 hover:text-white"
      >
        &lt;- All repositories
      </Link>
    </div>
  );
}

function SignInGate() {
  return (
    <section aria-label="Sign in required" className="glass-panel rounded-2xl p-6 sm:p-8">
      <h2 className="text-[1.125rem] font-semibold tracking-tight text-white">
        Sign in to view this repository
      </h2>
      <p className="mt-2 max-w-[65ch] text-[0.9375rem] text-slate-300">
        DiffProve scopes dashboard history and configuration to the GitHub repositories you have
        access to.
      </p>
      <div className="mt-5">
        <a
          href="/api/auth/login"
          className="inline-flex items-center rounded-xl bg-[#4f6bff] px-4 py-2.5 text-[0.875rem] font-medium text-white shadow-[0_0_24px_rgba(79,107,255,0.3)] transition-colors duration-150 hover:bg-[#6780ff]"
        >
          Sign in with GitHub
        </a>
      </div>
    </section>
  );
}

function AccessDenied() {
  return (
    <section aria-label="Access denied" className="glass-panel space-y-3 rounded-2xl p-6">
      <h1 className="text-[1.5rem] font-bold tracking-[-0.02em] text-white">Access denied</h1>
      <p className="max-w-[65ch] text-[0.9375rem] text-slate-300">
        You need access to this repository&apos;s GitHub App installation to view its verification
        history and configuration.
      </p>
      <Link
        href="/"
        className="inline-flex text-[0.8125rem] font-medium text-indigo-300 transition-colors duration-150 hover:text-white"
      >
        &lt;- Back to repositories
      </Link>
    </section>
  );
}

export default function RepoDetailPage() {
  const params = useParams();
  const repositoryId = typeof params.id === 'string' ? params.id : '';

  const [data, setData] = useState<RepoRunsResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [verdictFilter, setVerdictFilter] = useState<string>('all');

  const load = useCallback(async (): Promise<void> => {
    if (repositoryId.length === 0) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      setData(await getRepoRuns(repositoryId));
    } catch (caught) {
      const apiError = toApiError(caught);
      if (apiError.status === 401 || apiError.status === 403) {
        setData(null);
      }
      // Keep previously loaded data visible for transient errors; the banner
      // explains the failure on its own (e.g. a refresh after saving config).
      setError(apiError);
    } finally {
      setLoading(false);
    }
  }, [repositoryId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Refresh the whole page after a successful config save.
  const handleSaved = useCallback((): void => {
    void load();
  }, [load]);

  if (loading && data === null) {
    return <DetailSkeleton />;
  }

  if (data === null) {
    if (error === null) {
      return <p className="text-[0.875rem] text-slate-300">Loading repository...</p>;
    }
    if (error.status === 401) {
      return <SignInGate />;
    }
    if (error.status === 403) {
      return <AccessDenied />;
    }
    if (error.status === 404) {
      return <NotFound repositoryId={repositoryId} />;
    }
    return <LoadError error={error} onRetry={() => void load()} />;
  }

  const repository = data.repository;
  const verifiedCount = data.runs.filter((run) => run.verdict === 'verified-fix').length;
  const spectrumTicks = buildSpectrumTicks(data.runs);
  const filteredRuns =
    verdictFilter === 'all'
      ? data.runs
      : data.runs.filter((run) => run.verdict === verdictFilter);

  return (
    <div className="space-y-6">
      <div className="space-y-2.5">
        <Link
          href="/"
          className="inline-flex text-[0.8125rem] font-medium text-indigo-300 transition-colors duration-150 hover:text-white"
        >
          &lt;- All repositories
        </Link>

        <header className="space-y-1.5">
          <h1 className="break-words text-[clamp(1.65rem,2.8vw,2.35rem)] font-bold leading-tight tracking-[-0.03em] text-white">
            {repository.repoFullName}
          </h1>
          <p className="text-[0.875rem] text-slate-300">
            <span>{languageLabel(repository.language)}</span>
            <span aria-hidden="true" className="mx-2 text-slate-500">
              ·
            </span>
            <span>{repository.enabled ? 'Verification enabled' : 'Verification paused'}</span>
          </p>
        </header>
      </div>

      {error === null ? null : <LoadError error={error} onRetry={() => void load()} />}

      <section aria-label="Run summary" className="glass-panel rounded-2xl p-6 sm:p-7">
        <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_320px] md:items-center">
          <div>
            <p className="text-[0.875rem] font-medium text-slate-300">Weak-test catch rate</p>
            <p className="mt-2 text-5xl font-light leading-none tracking-[-0.04em] tabular-nums text-white sm:text-[3.5rem]">
              {formatCatchRate(data.catchRate)}
            </p>
            <p className="mt-2 text-[0.8125rem] text-slate-400">
              Weak-test runs divided by all runs. Mixed runs are counted separately.
            </p>
          </div>

          <dl className="space-y-2.5">
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-[0.875rem] text-slate-400">Total runs</dt>
              <dd className="text-[0.875rem] font-medium tabular-nums text-white">
                {data.totalRuns}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-[0.875rem] text-slate-400">Weak tests caught</dt>
              <dd className="text-[0.875rem] font-medium tabular-nums text-white">
                {data.weakTestCount}
              </dd>
            </div>
            {data.mixedTestCount === null ? null : (
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-[0.875rem] text-slate-400">Mixed test runs</dt>
                <dd className="text-[0.875rem] font-medium tabular-nums text-orange-200">
                  {data.mixedTestCount}
                </dd>
              </div>
            )}
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-[0.875rem] text-slate-400">Verified fixes</dt>
              <dd className="text-[0.875rem] font-medium tabular-nums text-white">
                {verifiedCount}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-[0.875rem] text-slate-400">Latest verdict</dt>
              <dd className="text-[0.875rem] font-medium tabular-nums text-white">
                {verdictLabel(data.runs[0]?.verdict)}
              </dd>
            </div>
          </dl>
        </div>

        <div className="mt-6 border-t border-white/10 pt-5">
          <div className="flex items-center gap-1 sm:gap-1.5" aria-hidden="true">
            {spectrumTicks.map((color, index) => (
              <span
                key={index}
                className={
                  color === null
                    ? 'h-4 flex-1 rounded-[3px] bg-white/12'
                    : 'h-4 flex-1 rounded-[3px]'
                }
                style={color === null ? undefined : { backgroundColor: color }}
              />
            ))}
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[0.8125rem] text-slate-300">
            <span>
              {data.runs.length === 0
                ? 'No runs recorded yet'
                : `Outcome distribution across ${data.runs.length} recent runs`}
            </span>
            {data.runs.length === 0 ? null : (
              <span className="tabular-nums text-slate-400">{data.weakTestCount} weak caught</span>
            )}
          </div>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
        <section id="history" className="space-y-3.5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-baseline gap-3">
              <h2 className="text-[1.125rem] font-semibold tracking-tight text-white">
                Verification history
              </h2>
              <span className="text-[0.8125rem] tabular-nums text-slate-400">
                Showing {filteredRuns.length} of {data.totalRuns} runs
              </span>
            </div>

            <div className="flex items-center">
              <label htmlFor="verdict-filter" className="sr-only">
                Filter by verdict
              </label>
              <select
                id="verdict-filter"
                value={verdictFilter}
                onChange={(event) => setVerdictFilter(event.target.value)}
                className="glass-control rounded-xl border border-white/15 bg-[#060813]/85 px-3 py-1.5 text-[0.8125rem] text-white focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
              >
                {VERDICT_FILTER_OPTIONS.map((option) => (
                  <option
                    key={option.value}
                    value={option.value}
                    className="bg-[#0b1020] text-white"
                  >
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {data.runs.length === 0 ? (
            <p className="glass-panel rounded-2xl p-6 text-[0.875rem] text-slate-300">
              No verification runs yet. Open a pull request that changes tests to populate this
              history.
            </p>
          ) : filteredRuns.length === 0 ? (
            <div className="glass-panel flex flex-wrap items-center justify-between gap-3 rounded-2xl p-6">
              <p className="text-[0.875rem] text-slate-300">
                No runs match the selected verdict filter.
              </p>
              <button
                type="button"
                onClick={() => setVerdictFilter('all')}
                className="text-[0.8125rem] font-medium text-indigo-300 transition-colors duration-150 hover:text-white"
              >
                Show all verdicts
              </button>
            </div>
          ) : (
            <div className="glass-panel divide-y divide-white/10 overflow-hidden rounded-2xl">
              {filteredRuns.map((run) => (
                <RunCard key={run.id} run={run} />
              ))}
            </div>
          )}
        </section>

        <aside id="config" className="lg:sticky lg:top-6">
          <RepoConfigForm repo={repository} onSaved={handleSaved} />
        </aside>
      </div>
    </div>
  );
}
