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

const VERDICT_FILTER_OPTIONS = [
  { value: 'all', label: 'All verdicts' },
  { value: 'verified-fix', label: 'Verified fix' },
  { value: 'weak-test', label: 'Weak test' },
  { value: 'broken-implementation', label: 'Broken implementation' },
  { value: 'new-symbol', label: 'New symbol' },
  { value: 'environment-failure', label: 'Environment failure' },
] as const;

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

function DetailSkeleton() {
  return (
    <div role="status" className="space-y-6">
      <span className="sr-only">Loading repository...</span>
      <div className="space-y-3">
        <div className="h-4 w-32 animate-pulse rounded bg-neutral-200/80" />
        <div className="h-9 w-72 animate-pulse rounded bg-neutral-200/80" />
        <div className="h-4 w-56 animate-pulse rounded bg-neutral-200/80" />
      </div>
      <div className="grid divide-y divide-[var(--border-hairline)] rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {[0, 1, 2].map((tile) => (
          <div key={tile} className="space-y-2 px-5 py-4">
            <div className="h-4 w-28 animate-pulse rounded bg-neutral-200/80" />
            <div className="h-6 w-16 animate-pulse rounded bg-neutral-200/80" />
          </div>
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
        <div className="h-64 animate-pulse rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)]" />
        <div className="h-80 animate-pulse rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)]" />
      </div>
    </div>
  );
}

function LoadError({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  const databaseNotConfigured = error.message.includes('database not configured');

  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-5">
      <p className="text-[0.875rem] font-semibold text-red-900">
        Could not load this repository
      </p>
      <p className="mt-1 break-words text-[0.875rem] text-red-800">{error.message}</p>

      {databaseNotConfigured ? (
        <p className="mt-3 rounded-md border border-red-200 bg-[var(--bg-surface)] px-3 py-2 text-[0.8125rem] text-neutral-800">
          Setup: {DATABASE_HINT}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border border-red-300 bg-[var(--bg-surface)] px-3 py-1.5 text-[0.8125rem] font-medium text-red-900 transition-colors duration-150 hover:bg-red-100"
        >
          Retry
        </button>
        <Link
          href="/"
          className="text-[0.8125rem] font-medium text-[var(--accent)] transition-colors duration-150 hover:text-[var(--accent-hover)]"
        >
          &lt;- All repositories
        </Link>
      </div>
    </div>
  );
}

function NotFound({ repositoryId }: { repositoryId: string }) {
  return (
    <div className="space-y-3 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-6">
      <h1 className="text-[1.5rem] font-bold tracking-[-0.02em] text-[var(--ink-primary)]">
        Repository not found.
      </h1>
      <p className="text-[0.875rem] text-[var(--ink-muted)]">
        No repository with id{' '}
        <span className="font-mono text-[var(--ink-primary)]">{repositoryId}</span> is registered
        with this DiffProve installation.
      </p>
      <Link
        href="/"
        className="inline-flex text-[0.8125rem] font-medium text-[var(--accent)] transition-colors duration-150 hover:text-[var(--accent-hover)]"
      >
        &lt;- All repositories
      </Link>
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
        Sign in to view this repository
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

function AccessDenied() {
  return (
    <section
      aria-label="Access denied"
      className="space-y-3 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-6"
    >
      <h1 className="text-[1.5rem] font-bold tracking-[-0.02em] text-[var(--ink-primary)]">
        Access denied
      </h1>
      <p className="max-w-[65ch] text-[0.9375rem] text-[var(--ink-secondary)]">
        You need access to this repository&apos;s GitHub App installation to view its verification
        history and configuration.
      </p>
      <Link
        href="/"
        className="inline-flex text-[0.8125rem] font-medium text-[var(--accent)] transition-colors duration-150 hover:text-[var(--accent-hover)]"
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
      return (
        <p className="text-[0.875rem] text-[var(--ink-muted)]">Loading repository...</p>
      );
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
  const filteredRuns =
    verdictFilter === 'all'
      ? data.runs
      : data.runs.filter((run) => run.verdict === verdictFilter);

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link
          href="/"
          className="inline-flex text-[0.8125rem] font-medium text-[var(--accent)] transition-colors duration-150 hover:text-[var(--accent-hover)]"
        >
          &lt;- All repositories
        </Link>

        <header className="space-y-1">
          <h1 className="break-words text-[clamp(1.75rem,2.5vw,2.25rem)] font-bold leading-tight tracking-[-0.03em] text-[var(--ink-primary)]">
            {repository.repoFullName}
          </h1>
          <p className="text-[0.875rem] text-[var(--ink-muted)]">
            <span>{languageLabel(repository.language)}</span>
            <span aria-hidden="true" className="mx-2">
              ·
            </span>
            <span>{repository.enabled ? 'Verification enabled' : 'Verification paused'}</span>
          </p>
        </header>
      </div>

      {error === null ? null : <LoadError error={error} onRetry={() => void load()} />}

      <section aria-label="Run summary">
        <dl className="grid divide-y divide-[var(--border-hairline)] rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <div className="px-5 py-4">
            <dt className="text-[0.8125rem] font-medium text-[var(--ink-muted)]">Total runs</dt>
            <dd className="mt-1 text-[1.125rem] font-semibold tabular-nums text-[var(--ink-primary)]">
              {data.totalRuns}
            </dd>
          </div>
          <div className="px-5 py-4">
            <dt className="text-[0.8125rem] font-medium text-[var(--ink-muted)]">
              Weak-test catch rate
            </dt>
            <dd className="mt-1 text-[1.125rem] font-semibold tabular-nums text-[var(--ink-primary)]">
              {formatCatchRate(data.catchRate)}
            </dd>
          </div>
          <div className="px-5 py-4">
            <dt className="text-[0.8125rem] font-medium text-[var(--ink-muted)]">
              Weak tests caught
            </dt>
            <dd className="mt-1 text-[1.125rem] font-semibold tabular-nums text-[var(--ink-primary)]">
              {data.weakTestCount}
            </dd>
          </div>
        </dl>
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-baseline gap-3">
              <h2 className="text-[1.125rem] font-semibold tracking-tight text-[var(--ink-primary)]">
                Verification history
              </h2>
              <span className="text-[0.8125rem] tabular-nums text-[var(--ink-muted)]">
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
                className="rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-[0.8125rem] text-[var(--ink-primary)] focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
              >
                {VERDICT_FILTER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {data.runs.length === 0 ? (
            <p className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-6 text-[0.875rem] text-[var(--ink-muted)]">
              No verification runs yet. Open a pull request that changes tests to populate this
              history.
            </p>
          ) : filteredRuns.length === 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-6">
              <p className="text-[0.875rem] text-[var(--ink-muted)]">
                No runs match the selected verdict filter.
              </p>
              <button
                type="button"
                onClick={() => setVerdictFilter('all')}
                className="text-[0.8125rem] font-medium text-[var(--accent)] transition-colors duration-150 hover:text-[var(--accent-hover)]"
              >
                Show all verdicts
              </button>
            </div>
          ) : (
            <div className="divide-y divide-[var(--border-hairline)] rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)]">
              {filteredRuns.map((run) => (
                <RunCard key={run.id} run={run} />
              ))}
            </div>
          )}
        </section>

        <aside className="lg:sticky lg:top-6">
          <RepoConfigForm repo={repository} onSaved={handleSaved} />
        </aside>
      </div>
    </div>
  );
}
