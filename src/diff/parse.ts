/**
 * Unified-diff parser — Phase 2 ("Diff Splitter"), pipeline step 2.
 *
 * docs/architecture.md, "End-to-End Verification Pipeline": "The worker pulls
 * the unified PR diff via GitHub API and splits changed files into two patches
 * using repo-configured test globs… Test-Only Patch … Full PR Patch …".
 *
 * The splitter projects a subset of the PR diff back into a standalone patch,
 * so nothing here re-serializes a diff: each section keeps the exact input
 * substring in `raw`, and every piece of metadata is derived by *reading*
 * (never rewriting) those bytes. That is what makes `git apply` on the
 * Test-Only Patch safe.
 *
 * Robustness contract: `parseUnifiedDiff` never throws. Empty, whitespace-only,
 * malformed, or non-diff input degrades to `[]`, to a best-effort section list,
 * or to sections whose `path` is `''`.
 */

import type { DiffFileSection, DiffFileStatus } from './types.js';

/** Literal prefix that starts a file section; it must sit at column 0. */
const SECTION_PREFIX = 'diff --git ';

/** Marker git uses for a side that does not exist (added / deleted files). */
const DEV_NULL = '/dev/null';

/**
 * Split a unified diff into one `DiffFileSection` per `diff --git ` section.
 *
 * Sections begin at a line whose first characters are `diff --git `; anything
 * before the first such line (commit preamble, e-mail headers, stray logs) is
 * ignored. Each `raw` runs from its own header line up to the next section's
 * header line (or the end of the input), so for a diff that starts at a
 * section boundary `sections.map(s => s.raw).join('') === input` holds exactly,
 * trailing newline included or absent.
 */
export function parseUnifiedDiff(diff: string): DiffFileSection[] {
  if (typeof diff !== 'string' || diff.length === 0) return [];
  // Whitespace-only input has no sections; keeps the common "empty GitHub
  // response" path cheap.
  if (diff.trim().length === 0) return [];

  const starts = findSectionStarts(diff);
  const sections: DiffFileSection[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : diff.length;
    sections.push(parseSection(diff.slice(start, end)));
  }
  return sections;
}

/**
 * Offsets of every line that opens a file section.
 *
 * Only column-0 occurrences count: a `diff --git ` inside a hunk body is always
 * prefixed by ' ', '+' or '-', so it can never be mistaken for a section start.
 */
function findSectionStarts(diff: string): number[] {
  const starts: number[] = [];
  let lineStart = 0;
  for (;;) {
    if (diff.startsWith(SECTION_PREFIX, lineStart)) starts.push(lineStart);
    const newline = diff.indexOf('\n', lineStart);
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  return starts;
}

/** Split one section into lines for metadata reads; `raw` itself is untouched. */
function splitLines(raw: string): string[] {
  const lines = raw.split('\n');
  // A trailing newline yields a final '' element: drop it so it is not read as
  // an empty body line (that would matter for an added blank line at EOF).
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  // Tolerate CRLF payloads while reading; `raw` keeps the original bytes.
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].endsWith('\r')) lines[i] = lines[i].slice(0, -1);
  }
  return lines;
}

/** The two path tokens of a `diff --git` line; quoted tokens keep their quotes. */
function parseGitHeader(rest: string): { a: string | null; b: string | null } {
  // A quoted token may contain spaces and backslash escapes; an unquoted token
  // runs to the next space. Git quotes paths with spaces/specials, which is
  // exactly the ambiguity this tokenizer relies on.
  const tokens = rest.match(/"(?:[^"\\]|\\.)*"|\S+/g);
  if (tokens === null || tokens.length === 0) return { a: null, b: null };
  if (tokens.length === 1) return { a: tokens[0], b: null };
  return { a: tokens[0], b: tokens[1] };
}

/**
 * Normalize a path token read from a header line: trim padding, drop the
 * surrounding double quotes git adds for paths with spaces or special
 * characters, and drop a leading `a/` / `b/` side prefix when present.
 *
 * LIMITATION: git's C-style escapes *inside* a quoted path (`\"`, `\t`, and the
 * octal UTF-8 escapes such as `\303\244`) are kept literally and never decoded,
 * so `path` / `oldPath` can differ from the real filename for non-ASCII or
 * quote-containing paths. Only metadata is affected: `raw` stays byte-exact and
 * the projected patch still applies with `git apply`.
 */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Strip the `a/` or `b/` side prefix that `---`/`+++`/`diff --git` lines carry. */
function stripSidePrefix(path: string): string {
  if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2);
  return path;
}

/** `''` → null, so an empty header value never wins over a later fallback. */
function nonEmpty(value: string): string | null {
  return value.length > 0 ? value : null;
}

function parseSection(raw: string): DiffFileSection {
  const lines = splitLines(raw);

  let firstHunkIndex = -1;
  let hunks = 0;
  let isBinary = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('@@')) {
      if (firstHunkIndex === -1) firstHunkIndex = i;
      hunks += 1;
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      isBinary = true;
    }
  }

  // Additions/deletions are hunk-body facts only: the `---`/`+++` header lines
  // sit before the first `@@`, so they are naturally excluded. `@@` headers,
  // "\ No newline at end of file" markers and context lines (space) never match.
  let additions = 0;
  let deletions = 0;
  if (firstHunkIndex !== -1) {
    for (let i = firstHunkIndex + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.startsWith('+')) additions += 1;
      else if (line.startsWith('-')) deletions += 1;
    }
  }

  // Path/status facts come only from the header region: a hunk body can hold an
  // added line "+..." whose text starts with "++" (rendering as `+++ ...`) or a
  // removed line "--..." (rendering as `--- ...`). Scanning past the first `@@`
  // would let those decoys win.
  const headerEnd = firstHunkIndex === -1 ? lines.length : firstHunkIndex;

  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let minusValue: string | null = null;
  let plusValue: string | null = null;
  let headerA: string | null = null;
  let headerB: string | null = null;
  let hasNewFileMode = false;
  let hasDeletedFileMode = false;

  for (let i = 0; i < headerEnd; i += 1) {
    const line = lines[i];
    if (line.startsWith(SECTION_PREFIX)) {
      const header = parseGitHeader(line.slice(SECTION_PREFIX.length));
      // A section has exactly one `diff --git` line; keep the first. Either
      // side may be missing on a truncated header, so store them independently.
      if (headerA === null && headerB === null) {
        headerA = header.a;
        headerB = header.b;
      }
    } else if (line.startsWith('rename from ')) {
      if (renameFrom === null) {
        renameFrom = nonEmpty(unquote(line.slice('rename from '.length)));
      }
    } else if (line.startsWith('rename to ')) {
      if (renameTo === null) {
        renameTo = nonEmpty(unquote(line.slice('rename to '.length)));
      }
    } else if (line.startsWith('--- ')) {
      if (minusValue === null) minusValue = unquote(line.slice('--- '.length));
    } else if (line.startsWith('+++ ')) {
      if (plusValue === null) plusValue = unquote(line.slice('+++ '.length));
    } else if (line.startsWith('new file mode')) {
      hasNewFileMode = true;
    } else if (line.startsWith('deleted file mode')) {
      hasDeletedFileMode = true;
    }
  }

  // Precompute the usable path candidates for each header source.
  const minusPath =
    minusValue !== null && minusValue !== DEV_NULL && minusValue.length > 0
      ? stripSidePrefix(minusValue)
      : null;
  const plusPath =
    plusValue !== null && plusValue !== DEV_NULL && plusValue.length > 0
      ? stripSidePrefix(plusValue)
      : null;
  const headerAPath = headerA !== null ? stripSidePrefix(headerA) : null;
  const headerBPath = headerB !== null ? stripSidePrefix(headerB) : null;

  let path = '';
  let aSide: string | null = null;

  // (a) Rename lines win over everything else, and they are the only path
  // source a pure rename (similarity index 100%, no `---`/`+++` lines) has.
  if (renameTo !== null) {
    path = renameTo;
    aSide = renameFrom ?? minusPath;
  } else if (plusValue !== null) {
    // (b) The `+++` line is the head-side truth.
    if (plusPath !== null) {
      path = plusPath;
      aSide = minusPath;
    } else if (minusPath !== null) {
      // `+++ /dev/null` marks a deleted file: its path lives on the `---` side.
      path = minusPath;
      // aSide equals path here, so it collapses to `oldPath: null` below.
      aSide = minusPath;
    }
  }

  // (c) No usable rename/`+++` path: fall back to `diff --git a/<old> b/<new>`.
  if (path.length === 0) {
    path = headerBPath !== null && headerBPath.length > 0 ? headerBPath : (headerAPath ?? '');
    if (aSide === null && headerAPath !== null && headerAPath.length > 0) {
      aSide = headerAPath;
    }
  }

  // `oldPath` only exists when the a-side really moved (renames in practice).
  const oldPath = aSide === null || aSide.length === 0 || aSide === path ? null : aSide;

  // Status precedence mirrors git's own header vocabulary; the flags are
  // mutually exclusive in real diffs.
  let status: DiffFileStatus = 'modified';
  if (hasNewFileMode) status = 'added';
  else if (hasDeletedFileMode) status = 'deleted';
  else if (renameFrom !== null && renameTo !== null) status = 'renamed';

  return { raw, path, oldPath, status, isBinary, hunks, additions, deletions };
}
