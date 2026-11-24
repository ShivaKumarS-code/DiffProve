/**
 * Run classification — Phase 3 pure differential policy.
 *
 * Turns the raw result of ONE sandbox command into the `RunStatus` vocabulary
 * of the architecture's verdict matrix. All policy lives here (no E2B, no I/O)
 * so it is unit-testable without a sandbox.
 *
 * Check order is significant:
 *   1. `timedOut`      → timeout   (the process never produced a trustworthy code)
 *   2. `exitCode null` → error     (the command never completed / result unknown)
 *   3. `exitCode 0`    → pass      (a passing suite may log scary strings; pass wins)
 *   4. `exitCode 127`  → error     (shell's "command not found" / missing runtime)
 *   5. output patterns → import-error / syntax-error
 *   6. otherwise       → fail
 *
 * Guardrail #3: a brand-new function or module makes Run A fail with
 * `ImportError`/`ModuleNotFoundError` (Python) or `TS2307`/`Cannot find module`
 * (JS). Distinguishing that from a plain assertion failure is what lets the
 * matrix label valid feature PRs `new-symbol` instead of `broken-implementation`.
 */

import type { RunnerKind, RunStatus, SandboxRawResult, SandboxRunOutcome } from './types.js';

/** Maximum length of `logExcerpt` before it is clipped with a marker. */
const LOG_EXCERPT_LIMIT = 4000;

/** Marker appended when the excerpt is clipped. */
const CLIPPED_MARKER = '\n… (clipped)';

/** pytest: module import failures, including the "new symbol" feature case. */
const PYTEST_IMPORT_ERROR = /ModuleNotFoundError|ImportError|No module named/;

/** pytest: syntax errors raised while collecting the test module. */
const PYTEST_SYNTAX_ERROR_LINE = /^SyntaxError/m;
const PYTEST_SYNTAX_ERROR_INLINE = /SyntaxError:/;

/** vitest / jest: unresolved imports and TS2307 ("Cannot find module"). */
const JS_IMPORT_ERROR = /Cannot find module|Module not found|ERR_MODULE_NOT_FOUND|TS2307/;

/** vitest / jest: parse/transform errors and TS1005 ("," expected). */
const JS_SYNTAX_ERROR = /SyntaxError|TS1005|Unexpected token|Transform failed|Parsing error/;

/**
 * Pattern scan over combined output. Import errors are checked before syntax
 * errors because a missing module is the more specific, more actionable signal
 * (and TS2307 is a compile/import error, not a parse error).
 */
function scanOutput(output: string, kind: RunnerKind): RunStatus {
  if (kind === 'pytest') {
    if (PYTEST_IMPORT_ERROR.test(output)) {
      return 'import-error';
    }
    if (PYTEST_SYNTAX_ERROR_LINE.test(output) || PYTEST_SYNTAX_ERROR_INLINE.test(output)) {
      return 'syntax-error';
    }
    return 'fail';
  }

  // vitest and jest share the Node/TypeScript failure vocabulary.
  if (JS_IMPORT_ERROR.test(output)) {
    return 'import-error';
  }
  if (JS_SYNTAX_ERROR.test(output)) {
    return 'syntax-error';
  }
  return 'fail';
}

/** stdout first, then stderr, whitespace-trimmed and clipped to 4000 chars. */
function buildLogExcerpt(stdout: string, stderr: string): string {
  const excerpt = `${stdout}\n${stderr}`.trim();
  if (excerpt.length <= LOG_EXCERPT_LIMIT) {
    return excerpt;
  }
  return `${excerpt.slice(0, LOG_EXCERPT_LIMIT)}${CLIPPED_MARKER}`;
}

/**
 * Classifies one raw sandbox result for the given runner.
 *
 * Never throws: unexpected/missing stdout or stderr text is treated as empty.
 * `exitCode` and `durationMs` pass through unchanged so evidence is not lost.
 */
export function classifyRun(raw: SandboxRawResult, kind: RunnerKind): SandboxRunOutcome {
  const stdout = typeof raw.stdout === 'string' ? raw.stdout : '';
  const stderr = typeof raw.stderr === 'string' ? raw.stderr : '';

  let status: RunStatus;
  if (raw.timedOut) {
    status = 'timeout';
  } else if (raw.exitCode === null) {
    status = 'error';
  } else if (raw.exitCode === 0) {
    status = 'pass';
  } else if (raw.exitCode === 127) {
    // 127 is the POSIX shell code for "command not found": the runner or its
    // runtime is missing from the sandbox, i.e. an environment problem.
    status = 'error';
  } else {
    status = scanOutput(`${stdout}\n${stderr}`, kind);
  }

  return {
    status,
    exitCode: raw.exitCode,
    durationMs: raw.durationMs,
    logExcerpt: buildLogExcerpt(stdout, stderr),
  };
}
