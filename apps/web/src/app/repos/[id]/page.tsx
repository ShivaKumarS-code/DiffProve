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

function languageLabel(language: RepoRunsResponse['repository']['language']): string {
  if (language === 'python') {
    return 'Python · pytest';
  }
  if (language === 'node') {
    return 'Node · vitest / jest';
  }
  return 'unknown language';
}

/** `null` catch rate means "no runs yet", which must not render as 0%. */
function formatCatchRate(catchRate: number | null): string {
  return catchRate === null ? '—' : `${(catchRate * 100).toFixed(1)}%`;
}

function EnabledBadge({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${
        enabled
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
          : 'border-neutral-500/30 bg-neutral-500/10 text-neutral-400'
      }`}
    >
      {enabled ? 'Enabled' : 'Disabled'}
    </span>
  );
}

function SummaryTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-neutral-100">{value}</p>
      {hint === undefined ? null : <p className="mt-1 text-xs text-neutral-500">{hint}</p>}
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div role="status" className="space-y-4">
      <span className="sr-only">Loading repository…</span>
      <div className="h-8 w-72 animate-pulse rounded-lg bg-neutral-800/70" />
      <div className="grid gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((tile) => (
          <div key={tile} className="h-24 animate-pulse rounded-xl bg-neutral-800/70" />
        ))}
      </div>
      <div className="h-40 animate-pulse rounded-xl bg-neutral-800/70" />
    </div>
  );
}

function LoadError({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  const databaseNotConfigured = error.message.includes('database not configured');

  return (
    <div role="alert" className="rounded-xl border border-red-900/70 bg-red-950/40 p-4">
      <p className="text-sm font-semibold text-red-300">Could not load this repository</p>
      <p className="mt-1 break-words text-sm text-red-200/90">{error.message}</p>

      {databaseNotConfigured ? (
        <p className="mt-3 rounded-lg border border-neutral-800 bg-neutral-950/60 px-3 py-2 text-xs text-neutral-300">
          Setup: {DATABASE_HINT}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onRetry}
          className="rounded-lg border border-red-800/70 bg-red-900/30 px-3 py-1.5 text-xs font-medium text-red-200 transition-colors hover:bg-red-900/50"
        >
          Retry
        </button>
        <Link
          href="/"
          className="text-xs font-medium text-neutral-400 transition-colors hover:text-neutral-200"
        >
          ← Back to repositories
        </Link>
      </div>
    </div>
  );
}

function NotFound({ repositoryId }: { repositoryId: string }) {
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">
        Repository not found.
      </h1>
      <p className="text-sm text-neutral-400">
        No repository with id <span className="font-mono text-neutral-300">{repositoryId}</span> is
        registered with this DiffProve installation.
      </p>
      <Link
        href="/"
        className="inline-flex text-sm font-medium text-emerald-400 transition-colors hover:text-emerald-300"
      >
        ← Back to repositories
      </Link>
    </div>
  );
}

export default function RepoDetailPage() {
  const params = useParams();
  const repositoryId = typeof params.id === 'string' ? params.id : '';

  const [data, setData] = useState<RepoRunsResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);

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
      // Keep previously loaded data visible; the banner explains the failure
      // on its own (e.g. a refresh after saving config).
      setError(toApiError(caught));
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
      return <p className="text-sm text-neutral-400">Loading repository…</p>;
    }
    if (error.status === 404) {
      return <NotFound repositoryId={repositoryId} />;
    }
    return <LoadError error={error} onRetry={() => void load()} />;
  }

  const repository = data.repository;

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <Link
          href="/"
          className="inline-flex text-xs font-medium text-neutral-400 transition-colors hover:text-neutral-200"
        >
          ← All repositories
        </Link>

        <header className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">
            {repository.repoFullName}
          </h1>
          <EnabledBadge enabled={repository.enabled} />
          <span className="rounded-full border border-neutral-700 px-2.5 py-0.5 text-xs text-neutral-300">
            {languageLabel(repository.language)}
          </span>
        </header>
      </div>

      {error === null ? null : <LoadError error={error} onRetry={() => void load()} />}

      <section aria-label="Run summary" className="grid gap-3 sm:grid-cols-3">
        <SummaryTile label="Total runs" value={String(data.totalRuns)} />
        <SummaryTile
          label="Weak-test catch rate"
          value={formatCatchRate(data.catchRate)}
          hint="share of runs flagged as weak / non-reproducing tests"
        />
        <SummaryTile
          label="Weak-test count"
          value={String(data.weakTestCount)}
          hint="runs whose tests passed on both base and head"
        />
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold text-neutral-100">Verification history</h2>
          <span className="text-xs text-neutral-500">
            Showing {data.runs.length} of {data.totalRuns} runs
          </span>
        </div>

        {data.runs.length === 0 ? (
          <p className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-6 text-sm text-neutral-400">
            No verification runs yet — open a pull request that changes tests to populate this
            history.
          </p>
        ) : (
          <div className="space-y-3">
            {data.runs.map((run) => (
              <RunCard key={run.id} run={run} />
            ))}
          </div>
        )}
      </section>

      <RepoConfigForm repo={repository} onSaved={handleSaved} />
    </div>
  );
}
