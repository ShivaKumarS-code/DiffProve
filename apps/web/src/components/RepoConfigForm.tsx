'use client';

import { useEffect, useState, type FormEvent } from 'react';

import { patchRepoConfig, toApiError, type RepoRow } from '../lib/api';

/**
 * Test-configuration editor for one repository.
 *
 * `test_command` and `test_file_globs` override the auto-detected runner
 * (docs/architecture.md, "API & Interface Contracts": `PATCH
 * /api/repos/:id/config`). Empty inputs are saved as `null` so the service
 * falls back to detection instead of storing empty strings.
 */

/**
 * Comma-separated input → glob list. `[]` becomes `null` (clear the override),
 * matching the API's `test_file_globs: string[] | null` field.
 */
function parseGlobs(text: string): string[] | null {
  const globs = text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return globs.length === 0 ? null : globs;
}

function globsToText(globs: string[] | null): string {
  return globs === null ? '' : globs.join(', ');
}

export default function RepoConfigForm({
  repo,
  onSaved,
}: {
  repo: RepoRow;
  onSaved: (updated: RepoRow) => void;
}) {
  const [testCommand, setTestCommand] = useState(repo.testCommand ?? '');
  const [globsText, setGlobsText] = useState(globsToText(repo.testFileGlobs));
  const [enabled, setEnabled] = useState(repo.enabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  // Re-sync when the parent hands over a freshly loaded row (for example after
  // a save-triggered refresh) so the inputs never show stale values.
  useEffect(() => {
    setTestCommand(repo.testCommand ?? '');
    setGlobsText(globsToText(repo.testFileGlobs));
    setEnabled(repo.enabled);
  }, [repo]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (saving) {
      return;
    }

    setSaving(true);
    setError(null);
    setJustSaved(false);

    const command = testCommand.trim();
    try {
      const updated = await patchRepoConfig(repo.id, {
        testCommand: command.length === 0 ? null : command,
        testFileGlobs: parseGlobs(globsText),
        enabled,
      });
      onSaved(updated);
      setJustSaved(true);
    } catch (caught) {
      // The service's own message is shown as-is, including the 503
      // "database not configured (set DATABASE_URL)" hint.
      setError(toApiError(caught).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-neutral-100">Test configuration</h2>
        <p className="text-xs text-neutral-500">
          Overrides the auto-detected test command and file globs for this repository.
        </p>
      </div>

      <form className="mt-4 space-y-4" onSubmit={handleSubmit}>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label
              htmlFor="test-command"
              className="block text-sm font-medium text-neutral-200"
            >
              Test command
            </label>
            <input
              id="test-command"
              type="text"
              value={testCommand}
              onChange={(event) => {
                setTestCommand(event.target.value);
                setJustSaved(false);
              }}
              placeholder="Auto-detected — e.g. pytest <changed test files> / vitest run <changed test files>"
              autoComplete="off"
              spellCheck={false}
              className="mt-1 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-100 placeholder:font-sans placeholder:text-neutral-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
            <p className="mt-1 text-xs text-neutral-500">
              Leave empty to let DiffProve detect the runner from the lockfile and
              project files.
            </p>
          </div>

          <div>
            <label
              htmlFor="test-file-globs"
              className="block text-sm font-medium text-neutral-200"
            >
              Test file globs
            </label>
            <input
              id="test-file-globs"
              type="text"
              value={globsText}
              onChange={(event) => {
                setGlobsText(event.target.value);
                setJustSaved(false);
              }}
              placeholder="Comma-separated, e.g. test_*.py, *_test.py, *.test.ts, *.spec.ts"
              autoComplete="off"
              spellCheck={false}
              className="mt-1 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-100 placeholder:font-sans placeholder:text-neutral-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
            <p className="mt-1 text-xs text-neutral-500">
              Leave empty to use the default globs for the repository language.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            id="enabled"
            type="checkbox"
            checked={enabled}
            onChange={(event) => {
              setEnabled(event.target.checked);
              setJustSaved(false);
            }}
            className="h-4 w-4 rounded border-neutral-600 bg-neutral-950 accent-emerald-500"
          />
          <label htmlFor="enabled" className="text-sm font-medium text-neutral-200">
            Enabled
          </label>
          <span className="text-xs text-neutral-500">
            When off, new verification jobs stay queued instead of running.
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={saving}
            className="rounded-lg bg-emerald-500 px-3 py-2 text-sm font-semibold text-neutral-950 transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? 'Saving…' : 'Save configuration'}
          </button>

          {error === null ? null : (
            <p role="alert" className="text-sm text-red-300">
              {error}
            </p>
          )}

          {error === null && justSaved ? (
            <p role="status" className="text-sm text-emerald-300">
              Configuration saved.
            </p>
          ) : null}
        </div>
      </form>
    </section>
  );
}
