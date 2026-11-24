/**
 * Test-file glob matching for the Diff Splitter (Phase 2, pipeline step 2).
 *
 * docs/architecture.md, "End-to-End Verification Pipeline": the worker splits
 * the PR diff "using repo-configured test globs (`test_*.py`, `*_test.py`,
 * `*.test.ts`, `*.spec.ts`)". Those defaults live in `DEFAULT_TEST_GLOBS`
 * (./types.js); Phase 4 will let a repo override the list.
 *
 * The matcher is deliberately tiny and never throws: patterns are translated to
 * a fully anchored RegExp, and a pattern that cannot compile simply matches
 * nothing.
 */

import { DEFAULT_TEST_GLOBS } from './types.js';

/** Characters with a meaning inside a RegExp outside a character class. */
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/;

/** One compiled pattern per glob, so a diff with many files compiles once. */
const regexCache = new Map<string, RegExp | null>();

/** Escape one literal character for use in a RegExp. */
function escapeRegExpChar(char: string): string {
  return REGEX_SPECIAL.test(char) ? `\\${char}` : char;
}

/**
 * Translate a glob to a RegExp.
 *
 * - `**` → `.*`   (any characters, including '/')
 * - `*`  → `[^/]*` (any characters except '/')
 * - `?`  → `[^/]`  (exactly one character except '/')
 * - everything else is escaped and matched literally
 *
 * Anchored with `^` … `$`. Note the literal reading of `**`: it does not imply
 * "zero or more path segments", so the pattern "a" + "/" + "**" + "/b.ts"
 * requires at least one segment between the slashes. Returns null if the
 * pattern cannot compile.
 */
function compileGlob(pattern: string): RegExp | null {
  const cached = regexCache.get(pattern);
  if (cached !== undefined) return cached;

  let source = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*';
        i += 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += escapeRegExpChar(char);
    }
  }
  source += '$';

  let compiled: RegExp | null;
  try {
    compiled = new RegExp(source);
  } catch {
    // Unreachable for escaped input, but a malformed pattern must never throw.
    compiled = null;
  }
  regexCache.set(pattern, compiled);
  return compiled;
}

/** Last path segment: the basename rules out "tests/unit/" prefixes. */
function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

/**
 * True iff `pattern` matches the full `path` or its basename.
 *
 * Matching the basename is what makes the default `test_*.py` glob apply to
 * `tests/unit/test_foo.py` too, which is how the architecture doc reads these
 * globs.
 */
export function matchesGlob(path: string, pattern: string): boolean {
  if (typeof path !== 'string' || typeof pattern !== 'string') return false;
  const regex = compileGlob(pattern);
  if (regex === null) return false;
  return regex.test(path) || regex.test(basename(path));
}

/**
 * True iff any glob in `globs` matches `path`.
 *
 * An empty (or non-array) glob list matches nothing, so a repo that configures
 * no test globs gets the pure-refactor short-circuit for every PR.
 */
export function isTestFile(path: string, globs: readonly string[] = DEFAULT_TEST_GLOBS): boolean {
  if (typeof path !== 'string') return false;
  const patterns: readonly string[] = Array.isArray(globs) ? globs : [];
  for (const pattern of patterns) {
    if (typeof pattern === 'string' && matchesGlob(path, pattern)) return true;
  }
  return false;
}
