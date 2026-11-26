'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { getRepos, toApiError, type ApiError, type RepoRow } from '../lib/api';

/**
 * Repository list / onboarding page.
 *
 * A client component by design: the dashboard is a pure frontend and the
 * service API is queried from the browser via `NEXT_PUBLIC_API_URL`.
 */

/**
 * Shown when the service answers 503 because it has no `DATABASE_URL`
 * (docs/architecture.md, "Key Engineering Guardrails": Postgres is optional).
 */
const DATABASE_HINT =
  'Start Postgres (`docker compose up -d postgres`) and set DATABASE_URL on the service.';

const COVERAGE_TICK_COUNT = 28;

type StatusFilter = 'all' | 'enabled' | 'disabled';

function languageLabel(language: RepoRow['language']): string {
  if (language === 'python') {
    return 'Python (pytest)';
  }
  if (language === 'node') {
    return 'Node (vitest / jest)';
  }
  return 'Unclassified';
}

function StatusIndicator({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[0.8125rem] font-medium ${
        enabled
          ? 'border-emerald-400/35 bg-emerald-500/15 text-emerald-200'
          : 'border-white/15 bg-white/[0.06] text-slate-300'
      }`}
    >
      {enabled ? 'Enabled' : 'Disabled'}
    </span>
  );
}

function RepoListSkeleton() {
  return (
    <div role="status" className="glass-panel space-y-2.5 rounded-2xl p-5">
      <span className="sr-only">Loading repositories...</span>
      {[0, 1, 2].map((row) => (
        <div key={row} className="h-10 animate-pulse rounded-lg bg-white/[0.06]" />
      ))}
    </div>
  );
}

function ErrorBanner({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  const databaseNotConfigured = error.message.includes('database not configured');

  return (
    <div
      role="alert"
      className="rounded-2xl border border-red-400/30 bg-red-950/55 p-5 text-red-200 backdrop-blur-xl"
    >
      <p className="text-[0.9375rem] font-semibold text-white">Could not load repositories</p>
      <p className="mt-1 break-words text-[0.875rem] text-red-200">{error.message}</p>

      {databaseNotConfigured ? (
        <p className="mt-3 rounded-xl border border-red-400/25 bg-[#060812]/80 px-3.5 py-2.5 text-[0.8125rem] text-slate-200">
          Setup: {DATABASE_HINT}
        </p>
      ) : null}

      <button
        type="button"
        onClick={onRetry}
        className="mt-4 inline-flex items-center rounded-lg border border-red-400/35 bg-white/[0.08] px-3.5 py-1.5 text-[0.8125rem] font-medium text-white transition-colors duration-150 hover:bg-red-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300/60"
      >
        Retry
      </button>
    </div>
  );
}

function AuthErrorBanner({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-red-400/30 bg-red-950/55 p-5 text-red-200 backdrop-blur-xl"
    >
      <div className="space-y-1">
        <p className="text-[0.9375rem] font-semibold text-white">GitHub sign-in failed</p>
        <p className="break-words text-[0.875rem] text-red-200">{message}</p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="rounded-lg border border-red-400/35 bg-white/[0.08] px-3.5 py-1.5 text-[0.8125rem] font-medium text-white transition-colors duration-150 hover:bg-red-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300/60"
      >
        Dismiss
      </button>
    </div>
  );
}

function SignInGate() {
  return (
    <section aria-label="Sign in required" className="glass-panel rounded-2xl p-6 sm:p-8">
      <h2 className="text-[1.125rem] font-semibold tracking-tight text-white">
        Sign in to view repositories
      </h2>
      <p className="mt-2 max-w-[65ch] text-[0.9375rem] text-slate-300">
        DiffProve scopes dashboard history and configuration to the GitHub repositories you have
        access to.
      </p>
      <div className="mt-5">
        <a
          href="/api/auth/login"
          className="inline-flex items-center rounded-xl bg-[#4f6bff] px-4 py-2.5 text-[0.875rem] font-semibold text-white shadow-[0_0_24px_rgba(79,107,255,0.35)] transition-colors duration-150 hover:bg-[#6780ff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
        >
          Sign in with GitHub
        </a>
      </div>
    </section>
  );
}

function CoverageOverview({
  totalCount,
  enabledCount,
  customCommandCount,
}: {
  totalCount: number;
  enabledCount: number;
  customCommandCount: number;
}) {
  const pausedCount = totalCount - enabledCount;
  const coveragePercent = totalCount > 0 ? Math.round((enabledCount / totalCount) * 100) : 0;
  const litTicks =
    totalCount > 0 ? Math.round((enabledCount / totalCount) * COVERAGE_TICK_COUNT) : 0;

  const metrics = [
    { label: 'Connected repositories', value: totalCount },
    { label: 'Verification enabled', value: enabledCount },
    { label: 'Custom test commands', value: customCommandCount },
    { label: 'Paused', value: pausedCount },
  ];

  return (
    <section aria-label="Verification coverage overview" className="glass-panel rounded-2xl p-6 sm:p-7">
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] md:items-center">
        <div className="space-y-2">
          <p className="text-[0.875rem] font-medium text-slate-300">Verification coverage</p>
          <p className="text-5xl font-light leading-none tracking-[-0.04em] tabular-nums text-white sm:text-[3.25rem]">
            {coveragePercent}%
          </p>
        </div>

        <dl className="space-y-0.5">
          {metrics.map((metric) => (
            <div
              key={metric.label}
              className="flex items-center justify-between py-1.5 text-[0.875rem]"
            >
              <dt className="text-slate-300">{metric.label}</dt>
              <dd className="font-medium tabular-nums text-white">{metric.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="mt-6 border-t border-white/10 pt-5">
        <div aria-hidden="true" className="flex h-6 items-stretch gap-1 sm:gap-1.5">
          {Array.from({ length: COVERAGE_TICK_COUNT }, (_, index) => {
            const lit = index < litTicks;
            return (
              <span
                key={index}
                className={`flex-1 rounded-full ${
                  lit
                    ? 'bg-gradient-to-b from-[#6ee7b7] to-[#818cf8]'
                    : 'bg-white/15'
                }`}
              />
            );
          })}
        </div>
        <div className="mt-2.5 flex items-center justify-between text-[0.8125rem] text-slate-300">
          <span>Enabled coverage</span>
          <span className="tabular-nums text-slate-200">
            {enabledCount} of {totalCount} active
          </span>
        </div>
      </div>
    </section>
  );
}

function RepoTable({
  repos,
  onResetFilters,
}: {
  repos: RepoRow[];
  onResetFilters: () => void;
}) {
  if (repos.length === 0) {
    return (
      <div className="glass-panel rounded-2xl px-6 py-10 text-center">
        <p className="text-[0.875rem] text-slate-300">
          No repositories match your current search or status filter.
        </p>
        <button
          type="button"
          onClick={onResetFilters}
          className="mt-3 inline-flex items-center rounded-lg border border-white/15 bg-white/[0.06] px-3.5 py-1.5 text-[0.8125rem] font-medium text-indigo-200 transition-colors duration-150 hover:border-indigo-400/40 hover:bg-white/[0.1] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
        >
          Reset filters
        </button>
      </div>
    );
  }

  return (
    <div className="glass-panel overflow-hidden rounded-2xl">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-white/10 text-[0.875rem]">
          <caption className="sr-only">
            Repositories registered with the DiffProve GitHub App
          </caption>
          <thead className="bg-white/[0.03] text-left text-[0.8125rem] text-slate-300">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">
                Repository
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Language
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Status
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Test command
              </th>
              <th scope="col" className="px-4 py-3 text-right font-medium">
                Details
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/10">
            {repos.map((repo) => (
              <tr key={repo.id} className="transition-colors duration-150 hover:bg-white/[0.04]">
                <td className="px-4 py-3.5 font-medium text-white">
                  <Link
                    href={`/repos/${repo.id}`}
                    className="rounded transition-colors duration-150 hover:text-indigo-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
                  >
                    {repo.repoFullName}
                  </Link>
                </td>
                <td className="px-4 py-3.5 text-slate-300">{languageLabel(repo.language)}</td>
                <td className="px-4 py-3.5">
                  <StatusIndicator enabled={repo.enabled} />
                </td>
                <td className="px-4 py-3.5">
                  {repo.testCommand === null ? (
                    <span className="text-[0.8125rem] text-slate-400">Auto-detected</span>
                  ) : (
                    <code className="rounded-md border border-white/10 bg-[#060812]/90 px-2 py-0.5 font-mono text-[0.8125rem] text-indigo-200">
                      {repo.testCommand}
                    </code>
                  )}
                </td>
                <td className="px-4 py-3.5 text-right">
                  <Link
                    href={`/repos/${repo.id}`}
                    aria-label={`Inspect ${repo.repoFullName}`}
                    className="inline-flex items-center rounded text-[0.8125rem] font-medium text-indigo-300 transition-colors duration-150 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
                  >
                    Inspect -&gt;
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function ReposPage() {
  const [repos, setRepos] = useState<RepoRow[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setRepos(await getRepos());
    } catch (caught) {
      setRepos(null);
      setError(toApiError(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const message = params.get('authError');
    if (message && message.trim().length > 0) {
      setAuthError(message.trim());
    }
  }, []);

  const dismissAuthError = () => {
    setAuthError(null);
    const url = new URL(window.location.href);
    if (url.searchParams.has('authError')) {
      url.searchParams.delete('authError');
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
  };

  const showLedger = !loading && error === null && repos !== null && repos.length > 0;
  const showEmpty = !loading && error === null && repos !== null && repos.length === 0;

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const filteredRepos =
    repos === null
      ? []
      : repos.filter((repo) => {
          if (statusFilter === 'enabled' && !repo.enabled) {
            return false;
          }
          if (statusFilter === 'disabled' && repo.enabled) {
            return false;
          }
          if (normalizedQuery.length === 0) {
            return true;
          }
          const matchesName = repo.repoFullName.toLowerCase().includes(normalizedQuery);
          const matchesCommand =
            repo.testCommand !== null && repo.testCommand.toLowerCase().includes(normalizedQuery);
          return matchesName || matchesCommand;
        });

  const totalCount = repos?.length ?? 0;
  const enabledCount = repos ? repos.filter((repo) => repo.enabled).length : 0;
  const customCommandCount = repos
    ? repos.filter((repo) => repo.testCommand !== null).length
    : 0;

  const resetFilters = () => {
    setSearchQuery('');
    setStatusFilter('all');
  };

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-[clamp(1.75rem,3vw,2.5rem)] font-bold leading-tight tracking-[-0.03em] text-white">
          Repositories
        </h1>
        <p className="max-w-[65ch] text-[0.9375rem] text-slate-300">
          Catch weak or hallucinated pull request tests automatically before review, and inspect
          verification configuration across connected repositories.
        </p>
      </header>

      {authError !== null ? (
        <AuthErrorBanner message={authError} onDismiss={dismissAuthError} />
      ) : null}

      {loading ? <RepoListSkeleton /> : null}

      {!loading && error !== null ? (
        error.status === 401 ? (
          <SignInGate />
        ) : (
          <ErrorBanner error={error} onRetry={() => void load()} />
        )
      ) : null}

      {showEmpty ? (
        <p className="glass-panel rounded-2xl p-6 text-[0.875rem] text-slate-300">
          No repositories yet. Install the GitHub App on a repository and open a pull request to
          begin verification.
        </p>
      ) : null}

      {showLedger ? (
        <>
          <CoverageOverview
            totalCount={totalCount}
            enabledCount={enabledCount}
            customCommandCount={customCommandCount}
          />

          <section id="repositories" aria-label="Connected repositories" className="space-y-3.5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-1 flex-col gap-2.5 sm:flex-row sm:items-center">
                <div className="w-full sm:max-w-xs">
                  <label htmlFor="repo-search" className="sr-only">
                    Search repositories or test commands
                  </label>
                  <input
                    id="repo-search"
                    type="search"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="Filter by repository or test command..."
                    className="glass-control w-full rounded-xl border border-white/15 bg-[#070914]/80 px-3.5 py-2 text-[0.875rem] text-white placeholder:text-slate-400 transition-colors duration-150 focus:border-indigo-400 focus:outline-none"
                  />
                </div>

                <div>
                  <label htmlFor="repo-status-filter" className="sr-only">
                    Filter by status
                  </label>
                  <select
                    id="repo-status-filter"
                    value={statusFilter}
                    onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
                    className="glass-control w-full rounded-xl border border-white/15 bg-[#070914]/80 px-3.5 py-2 text-[0.875rem] text-white transition-colors duration-150 focus:border-indigo-400 focus:outline-none sm:w-auto"
                  >
                    <option value="all" className="bg-[#090d1a] text-white">
                      All repositories
                    </option>
                    <option value="enabled" className="bg-[#090d1a] text-white">
                      Enabled only
                    </option>
                    <option value="disabled" className="bg-[#090d1a] text-white">
                      Disabled only
                    </option>
                  </select>
                </div>
              </div>

              <p className="text-[0.8125rem] tabular-nums text-slate-300">
                Showing {filteredRepos.length} of {totalCount}{' '}
                {totalCount === 1 ? 'repository' : 'repositories'}
              </p>
            </div>

            <RepoTable repos={filteredRepos} onResetFilters={resetFilters} />
          </section>
        </>
      ) : null}
    </div>
  );
}
