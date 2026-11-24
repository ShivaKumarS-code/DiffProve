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
 * (docs/architecture.md, "Key Engineering Guardrails" — Postgres is optional).
 */
const DATABASE_HINT =
  'Start Postgres (`docker compose up -d postgres`) and set DATABASE_URL on the service.';

function languageLabel(language: RepoRow['language']): string {
  if (language === 'python') {
    return 'Python · pytest';
  }
  if (language === 'node') {
    return 'Node · vitest / jest';
  }
  return '—';
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

function RepoListSkeleton() {
  return (
    <div
      role="status"
      className="space-y-2 rounded-xl border border-neutral-800 bg-neutral-900/40 p-4"
    >
      <span className="sr-only">Loading repositories…</span>
      {[0, 1, 2].map((row) => (
        <div key={row} className="h-10 animate-pulse rounded-lg bg-neutral-800/70" />
      ))}
    </div>
  );
}

function ErrorBanner({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  const databaseNotConfigured = error.message.includes('database not configured');

  return (
    <div role="alert" className="rounded-xl border border-red-900/70 bg-red-950/40 p-4">
      <p className="text-sm font-semibold text-red-300">Could not load repositories</p>
      <p className="mt-1 break-words text-sm text-red-200/90">{error.message}</p>

      {databaseNotConfigured ? (
        <p className="mt-3 rounded-lg border border-neutral-800 bg-neutral-950/60 px-3 py-2 text-xs text-neutral-300">
          Setup: {DATABASE_HINT}
        </p>
      ) : null}

      <button
        type="button"
        onClick={onRetry}
        className="mt-3 rounded-lg border border-red-800/70 bg-red-900/30 px-3 py-1.5 text-xs font-medium text-red-200 transition-colors hover:bg-red-900/50"
      >
        Retry
      </button>
    </div>
  );
}

function RepoTable({ repos }: { repos: RepoRow[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-neutral-800">
      <table className="min-w-full divide-y divide-neutral-800 text-sm">
        <caption className="sr-only">Repositories registered with the DiffProve GitHub App</caption>
        <thead className="bg-neutral-900/70 text-left text-xs uppercase tracking-wide text-neutral-400">
          <tr>
            <th scope="col" className="px-4 py-3 font-medium">
              Repository
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              Language
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              Enabled
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              Test command
            </th>
            <th scope="col" className="px-4 py-3 text-right font-medium">
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-800">
          {repos.map((repo) => (
            <tr key={repo.id} className="transition-colors hover:bg-neutral-900/60">
              <td className="px-4 py-3 font-medium text-neutral-100">{repo.repoFullName}</td>
              <td className="px-4 py-3 text-neutral-300">{languageLabel(repo.language)}</td>
              <td className="px-4 py-3">
                <EnabledBadge enabled={repo.enabled} />
              </td>
              <td className="px-4 py-3">
                {repo.testCommand === null ? (
                  <span className="text-xs text-neutral-500">auto-detected</span>
                ) : (
                  <span className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[11px] text-neutral-200">
                    {repo.testCommand}
                  </span>
                )}
              </td>
              <td className="px-4 py-3 text-right">
                <Link
                  href={`/repos/${repo.id}`}
                  aria-label={`Open ${repo.repoFullName}`}
                  className="inline-flex items-center rounded-md px-2 py-1 text-sm font-medium text-emerald-400 transition-colors hover:bg-emerald-500/10 hover:text-emerald-300"
                >
                  →
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
  const [loading, setLoading] = useState(true);

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

  const showTable = !loading && error === null && repos !== null && repos.length > 0;
  const showEmpty = !loading && error === null && repos !== null && repos.length === 0;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">Repositories</h1>
        <p className="max-w-3xl text-sm text-neutral-400">
          DiffProve re-runs each PR&apos;s changed tests against the reverted base commit and the
          patched head commit, so weak or hallucinated tests fail before a human reviews them.
        </p>
      </header>

      {loading ? <RepoListSkeleton /> : null}

      {!loading && error !== null ? (
        <ErrorBanner error={error} onRetry={() => void load()} />
      ) : null}

      {showEmpty ? (
        <p className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-6 text-sm text-neutral-400">
          No repositories yet — install the GitHub App on a repository and open a PR.
        </p>
      ) : null}

      {showTable && repos !== null ? <RepoTable repos={repos} /> : null}
    </div>
  );
}
