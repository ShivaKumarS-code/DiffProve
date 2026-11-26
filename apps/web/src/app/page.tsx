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
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[0.8125rem] font-medium ${
        enabled
          ? 'border-[#A7F3D0] bg-[#ECFDF5] text-[#065F46]'
          : 'border-[#CBD5E1] bg-[#F1F5F9] text-[#475569]'
      }`}
    >
      {enabled ? 'Enabled' : 'Disabled'}
    </span>
  );
}

function RepoListSkeleton() {
  return (
    <div
      role="status"
      className="space-y-2.5 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-4"
    >
      <span className="sr-only">Loading repositories...</span>
      {[0, 1, 2].map((row) => (
        <div key={row} className="h-10 animate-pulse rounded-md bg-[var(--bg-recessed)]" />
      ))}
    </div>
  );
}

function ErrorBanner({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  const databaseNotConfigured = error.message.includes('database not configured');

  return (
    <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4 text-red-900">
      <p className="text-[0.9375rem] font-semibold text-red-900">Could not load repositories</p>
      <p className="mt-1 break-words text-[0.875rem] text-red-800">{error.message}</p>

      {databaseNotConfigured ? (
        <p className="mt-3 rounded-md border border-red-200 bg-[var(--bg-surface)] px-3 py-2 text-[0.8125rem] text-[var(--ink-secondary)]">
          Setup: {DATABASE_HINT}
        </p>
      ) : null}

      <button
        type="button"
        onClick={onRetry}
        className="mt-3 inline-flex items-center rounded-md border border-red-300 bg-[var(--bg-surface)] px-3 py-1.5 text-[0.8125rem] font-medium text-red-900 transition-colors duration-150 hover:bg-red-100"
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
      className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-red-300 bg-red-50 p-4 text-red-900"
    >
      <div className="space-y-1">
        <p className="text-[0.9375rem] font-semibold text-red-900">GitHub sign-in failed</p>
        <p className="break-words text-[0.875rem] text-red-800">{message}</p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="rounded-md border border-red-300 bg-[var(--bg-surface)] px-3 py-1.5 text-[0.8125rem] font-medium text-red-900 transition-colors duration-150 hover:bg-red-100"
      >
        Dismiss
      </button>
    </div>
  );
}

function SignInGate() {
  return (
    <section
      aria-label="Sign in required"
      className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-6 sm:p-8"
    >
      <h2 className="text-[1.125rem] font-semibold tracking-tight text-[var(--ink-primary)]">
        Sign in to view repositories
      </h2>
      <p className="mt-2 max-w-[65ch] text-[0.9375rem] text-[var(--ink-secondary)]">
        DiffProve scopes dashboard history and configuration to the GitHub repositories you have
        access to.
      </p>
      <div className="mt-5">
        <a
          href="/api/auth/login"
          className="inline-flex items-center rounded-md bg-[var(--accent)] px-4 py-2 text-[0.875rem] font-medium text-white transition-colors duration-150 hover:bg-[var(--accent-hover)]"
        >
          Sign in with GitHub
        </a>
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
      <div className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-6 py-10 text-center">
        <p className="text-[0.875rem] text-[var(--ink-secondary)]">
          No repositories match your current search or status filter.
        </p>
        <button
          type="button"
          onClick={onResetFilters}
          className="mt-3 text-[0.875rem] font-medium text-[var(--accent)] underline underline-offset-4 transition-colors duration-150 hover:text-[var(--accent-hover)]"
        >
          Reset filters
        </button>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)]">
      <table className="min-w-full divide-y divide-[var(--border-hairline)] text-[0.875rem]">
        <caption className="sr-only">Repositories registered with the DiffProve GitHub App</caption>
        <thead className="bg-[var(--bg-recessed)] text-left text-[0.8125rem] text-[var(--ink-secondary)]">
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
        <tbody className="divide-y divide-[var(--border-hairline)]">
          {repos.map((repo) => (
            <tr
              key={repo.id}
              className="transition-colors duration-150 hover:bg-[var(--bg-hover)]"
            >
              <td className="px-4 py-3 font-medium text-[var(--ink-primary)]">
                <Link
                  href={`/repos/${repo.id}`}
                  className="transition-colors duration-150 hover:text-[var(--accent)]"
                >
                  {repo.repoFullName}
                </Link>
              </td>
              <td className="px-4 py-3 text-[var(--ink-secondary)]">
                {languageLabel(repo.language)}
              </td>
              <td className="px-4 py-3">
                <StatusIndicator enabled={repo.enabled} />
              </td>
              <td className="px-4 py-3">
                {repo.testCommand === null ? (
                  <span className="text-[0.8125rem] text-[var(--ink-muted)]">Auto-detected</span>
                ) : (
                  <code className="rounded bg-[var(--bg-recessed)] px-2 py-0.5 font-mono text-[0.8125rem] text-[var(--ink-primary)]">
                    {repo.testCommand}
                  </code>
                )}
              </td>
              <td className="px-4 py-3 text-right">
                <Link
                  href={`/repos/${repo.id}`}
                  aria-label={`Inspect ${repo.repoFullName}`}
                  className="inline-flex items-center text-[0.8125rem] font-medium text-[var(--accent)] transition-colors duration-150 hover:text-[var(--accent-hover)]"
                >
                  Inspect -&gt;
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
        <h1 className="text-[clamp(1.75rem,2.5vw,2.25rem)] font-bold leading-tight tracking-[-0.03em] text-[var(--ink-primary)]">
          Repositories
        </h1>
        <p className="max-w-3xl text-[0.9375rem] text-[var(--ink-secondary)]">
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
        <p className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-6 text-[0.875rem] text-[var(--ink-secondary)]">
          No repositories yet. Install the GitHub App on a repository and open a pull request to
          begin verification.
        </p>
      ) : null}

      {showLedger ? (
        <section aria-label="Connected repositories" className="space-y-3">
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
                  className="w-full rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-3 py-1.5 text-[0.875rem] text-[var(--ink-primary)] placeholder:text-[var(--ink-muted)] transition-colors duration-150 focus:border-[var(--accent)] focus:outline-none"
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
                  className="w-full rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-3 py-1.5 text-[0.875rem] text-[var(--ink-primary)] transition-colors duration-150 focus:border-[var(--accent)] focus:outline-none sm:w-auto"
                >
                  <option value="all">All repositories</option>
                  <option value="enabled">Enabled only</option>
                  <option value="disabled">Disabled only</option>
                </select>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 text-[0.8125rem] tabular-nums text-[var(--ink-secondary)]">
              <span>
                {totalCount} {totalCount === 1 ? 'repository' : 'repositories'}
              </span>
              <span aria-hidden="true" className="h-3.5 w-px bg-[var(--border-hairline)]" />
              <span>{enabledCount} enabled</span>
              <span aria-hidden="true" className="h-3.5 w-px bg-[var(--border-hairline)]" />
              <span>
                {customCommandCount} custom {customCommandCount === 1 ? 'command' : 'commands'}
              </span>
            </div>
          </div>

          <RepoTable repos={filteredRepos} onResetFilters={resetFilters} />
        </section>
      ) : null}
    </div>
  );
}
