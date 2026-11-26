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
 * Comma-separated input to glob list. `[]` becomes `null` (clear the override),
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
    <section className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-5">
      <h2 className="text-[1.125rem] font-semibold tracking-tight text-[var(--ink-primary)]">
        Test configuration
      </h2>

      <form className="mt-4 space-y-4" onSubmit={handleSubmit}>
        <div>
          <label
            htmlFor="test-command"
            className="block text-[0.875rem] font-medium text-[var(--ink-primary)]"
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
            placeholder="e.g. pytest -q {files} or npx vitest run {files}"
            autoComplete="off"
            spellCheck={false}
            className="mt-1.5 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-3 py-2 font-mono text-[0.8125rem] text-[var(--ink-primary)] placeholder:font-sans placeholder:text-[var(--ink-muted)] focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
          />
          <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-[var(--ink-muted)]">
            Leave empty for auto-detection. Use {'{files}'} to pass changed test paths.
          </p>
        </div>

        <div>
          <label
            htmlFor="test-file-globs"
            className="block text-[0.875rem] font-medium text-[var(--ink-primary)]"
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
            placeholder="e.g. test_*.py, *_test.py, *.test.ts, *.spec.ts"
            autoComplete="off"
            spellCheck={false}
            className="mt-1.5 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-3 py-2 font-mono text-[0.8125rem] text-[var(--ink-primary)] placeholder:font-sans placeholder:text-[var(--ink-muted)] focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
          />
          <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-[var(--ink-muted)]">
            Leave empty to use default globs for the repository language.
          </p>
        </div>

        <div className="border-t border-[var(--border-hairline)] pt-4">
          <div className="flex items-start gap-2.5">
            <input
              id="enabled"
              type="checkbox"
              checked={enabled}
              onChange={(event) => {
                setEnabled(event.target.checked);
                setJustSaved(false);
              }}
              className="mt-0.5 h-4 w-4 rounded border-[var(--border-strong)] bg-[var(--bg-surface)] accent-[var(--accent)]"
            />
            <div>
              <label
                htmlFor="enabled"
                className="block text-[0.875rem] font-medium text-[var(--ink-primary)]"
              >
                Enable differential verification
              </label>
              <p className="mt-0.5 text-[0.8125rem] leading-relaxed text-[var(--ink-muted)]">
                When disabled, new PR jobs stay queued without running.
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 pt-1">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center justify-center rounded-md bg-[var(--accent)] px-4 py-2 text-[0.875rem] font-medium text-white transition-colors duration-150 hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? 'Saving...' : 'Save configuration'}
          </button>

          {error === null ? null : (
            <p role="alert" className="text-[0.8125rem] font-medium text-red-800">
              {error}
            </p>
          )}

          {error === null && justSaved ? (
            <p role="status" className="text-[0.8125rem] font-medium text-emerald-800">
              Configuration saved.
            </p>
          ) : null}
        </div>
      </form>
    </section>
  );
}
