/**
 * Command construction — Phase 3 pure differential policy.
 *
 * docs/architecture.md, "End-to-End Verification Pipeline" step 3: the sandbox
 * is provisioned from a snapshot keyed by the repo's lockfile hash
 * (`uv.lock`, `poetry.lock`, `requirements.txt`, `package-lock.json`,
 * `pnpm-lock.yaml`), and dependencies are installed before egress is disabled.
 * `yarn.lock` is included in addition to the architecture's list because the
 * guardrail's "standard lockfiles" scope covers yarn repos too.
 *
 * Steps 4-5: both runs execute "the exact same targeted test command"
 * (`pytest <changed_tests>` or `vitest run <changed_tests>`). Paths come from
 * the PR diff and are therefore always POSIX single-quoted so spaces or shell
 * metacharacters cannot change the command's meaning.
 *
 * Pure module: no I/O, no shell execution, no sandbox knowledge.
 */

import type { RunnerKind } from './types.js';

/**
 * Lockfile detection priority. Independent of the order files appear in the
 * repo listing: the first entry present here wins. A repo usually has exactly
 * one, and when it has several the most specific manager is preferred.
 */
const LOCKFILE_PRIORITY = [
  'uv.lock',
  'poetry.lock',
  'requirements.txt',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
] as const;

/** Last path segment, accepting both POSIX and Windows separators. */
function basename(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] ?? path;
}

/**
 * True when `path` is the named file at the repo root or nested in a
 * subdirectory (`sub/package-lock.json` matches `package-lock.json`).
 */
function matchesFile(path: string, name: string): boolean {
  return path === name || basename(path) === name;
}

/** First path (repo-listing order) whose basename equals `name`, else null. */
function findFile(files: readonly string[], name: string): string | null {
  for (const file of files) {
    if (matchesFile(file, name)) {
      return file;
    }
  }
  return null;
}

/**
 * Detects the dependency lockfile to key the sandbox snapshot by.
 *
 * Returns `{ name, path }` for the highest-priority lockfile present, where
 * `path` is the file's path as listed (it may be nested). The priority order
 * above wins over the order of `files`; null when no lockfile exists.
 */
export function findLockfile(files: readonly string[]): { name: string; path: string } | null {
  for (const name of LOCKFILE_PRIORITY) {
    const path = findFile(files, name);
    if (path !== null) {
      return { name, path };
    }
  }
  return null;
}

/**
 * POSIX single-quotes `arg` so `/bin/sh` passes it literally without expanding
 * `$(...)`, backticks, `"`, `$VAR`, or splitting on whitespace.
 */
export function quoteShellArg(arg: string): string {
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

/**
 * Builds the dependency install command for `kind` from the repo's files.
 *
 * Returns null when there is nothing to install from (e.g. a bare package.json
 * is still installable — it yields `npm install` — but a repo with neither a
 * lockfile nor a manifest yields null), in which case the runner skips install.
 */
export function buildInstallCommand(files: readonly string[], kind: RunnerKind): string | null {
  if (kind === 'pytest') {
    // Python installers, most reproducible first. A requirements.txt path may
    // be nested, so the matched path is POSIX single-quoted.
    if (findFile(files, 'uv.lock') !== null) {
      return 'uv sync';
    }
    if (findFile(files, 'poetry.lock') !== null) {
      return 'POETRY_VIRTUALENVS_IN_PROJECT=true poetry install';
    }
    const requirements = findFile(files, 'requirements.txt');
    if (requirements !== null) {
      return `pip install -r ${quoteShellArg(requirements)}`;
    }
    if (findFile(files, 'pyproject.toml') !== null) {
      return 'pip install -e .';
    }
    return null;
  }

  // vitest and jest are installed identically from the Node lockfile.
  if (findFile(files, 'package-lock.json') !== null) {
    return 'npm ci';
  }
  if (findFile(files, 'pnpm-lock.yaml') !== null) {
    return 'pnpm install --frozen-lockfile';
  }
  if (findFile(files, 'yarn.lock') !== null) {
    return 'yarn install --frozen-lockfile';
  }
  if (findFile(files, 'package.json') !== null) {
    return 'npm install';
  }
  return null;
}

/**
 * Builds the targeted test command shared by Run A and Run B.
 *
 * Every path is POSIX single-quoted. An empty file list produces the runner's
 * default invocation with no trailing space.
 */
export function buildTestCommand(kind: RunnerKind, testFiles: readonly string[]): string {
  const quoted = testFiles.map(quoteShellArg).join(' ');

  switch (kind) {
    case 'pytest':
      return quoted === '' ? 'pytest' : `pytest ${quoted}`;
    case 'vitest':
      return quoted === '' ? 'npx vitest run' : `npx vitest run ${quoted}`;
    case 'jest':
      return quoted === '' ? 'npx jest' : `npx jest ${quoted}`;
  }
}

/**
 * Formats a custom `testCommand` override with POSIX single-quoted `testFiles`.
 *
 * Replaces `{files}` and `{file}` placeholders when present; otherwise returns
 * `template` verbatim.
 */
export function formatCustomTestCommand(template: string, testFiles: readonly string[]): string {
  if (!template.includes('{files}') && !template.includes('{file}')) {
    return template;
  }

  const joined = testFiles.map(quoteShellArg).join(' ');
  const formatted = template
    .replaceAll('{files}', () => joined)
    .replaceAll('{file}', () => joined);
  return testFiles.length === 0 ? formatted.trimEnd() : formatted;
}
