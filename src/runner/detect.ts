/**
 * Runner detection — Phase 3 pure differential policy.
 *
 * docs/architecture.md, "Key Engineering Guardrails" #1: v1 supports only
 * Python (`pytest`) and TypeScript/JS (`vitest` / `jest`) repositories and
 * auto-detects the runner from `package.json` or `pyproject.toml`.
 *
 * Precedence rules:
 *  - `package.json` is consulted first and wins whenever it names a runner, so
 *    a repo that carries both manifests is treated as the JS one.
 *  - `vitest` wins over `jest`: migrations often leave both installed, and
 *    vitest is the runner the architecture names first.
 *  - Dependency presence wins over a `scripts.test` hint, because a script can
 *    be stale after a migration.
 *  - Invalid JSON is treated as "absent" rather than as a hard error, so one
 *    malformed manifest never hides a Python project.
 *  - A parseable `package.json` that names no supported runner is also treated
 *    as absent for detection purposes; `pyproject.toml` gets its chance. This
 *    keeps mixed repos (JS tooling + Python tests) detectable.
 *
 * v1 limitation (documented heuristic): `pyproject.toml` is scanned for the
 * literal substring `pytest` instead of being parsed as TOML. That finds both
 * `[tool.pytest.ini_options]` and `pytest` in dependency arrays without adding
 * a TOML dependency. A false positive (e.g. the word in a comment) at worst
 * picks pytest for a repo that does not install it; that surfaces as a sandbox
 * error, never as a false verdict on a PR.
 */

import type { RunnerKind } from './types.js';

/** Raw manifest text fetched by the trusted worker (null/undefined = absent). */
export interface RunnerDetectionInputs {
  packageJson?: string | null;
  pyprojectToml?: string | null;
}

/** A detected runner; `detectRunner` returns null when nothing matches. */
export interface RunnerDetection {
  kind: RunnerKind;
}

/** Manifest fields that can carry a test-runner dependency. */
const DEPENDENCY_FIELDS = ['devDependencies', 'dependencies'] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** Narrows an unknown JSON value to a plain object (arrays/null rejected). */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * True when `name` is declared in `devDependencies` or `dependencies`, checking
 * devDependencies first (the usual home of a test runner).
 */
function hasDependency(manifest: Record<string, unknown>, name: string): boolean {
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = asRecord(manifest[field]);
    if (dependencies !== null && Object.prototype.hasOwnProperty.call(dependencies, name)) {
      return true;
    }
  }
  return false;
}

/** Last-resort detection from `scripts.test`, e.g. `"test": "vitest run"`. */
function runnerFromTestScript(manifest: Record<string, unknown>): RunnerKind | null {
  const scripts = asRecord(manifest.scripts);
  if (scripts === null || typeof scripts.test !== 'string') {
    return null;
  }
  // Case-insensitive: scripts are written by hand, e.g. "NODE_ENV=test vitest".
  const testScript = scripts.test.toLowerCase();
  if (testScript.includes('vitest')) {
    return 'vitest';
  }
  if (testScript.includes('jest')) {
    return 'jest';
  }
  return null;
}

/** Detects a runner from a raw `package.json` string; invalid JSON → null. */
function detectFromPackageJson(rawPackageJson: string): RunnerKind | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawPackageJson);
  } catch {
    // Malformed manifest: treat it as absent so pyproject.toml can still win.
    return null;
  }

  const manifest = asRecord(parsed);
  if (manifest === null) {
    return null;
  }

  if (hasDependency(manifest, 'vitest')) {
    return 'vitest';
  }
  if (hasDependency(manifest, 'jest')) {
    return 'jest';
  }
  return runnerFromTestScript(manifest);
}

/** Detects a runner from a raw `pyproject.toml` string (v1 substring scan). */
function detectFromPyprojectToml(rawPyprojectToml: string): RunnerKind | null {
  return rawPyprojectToml.includes('pytest') ? 'pytest' : null;
}

/**
 * Detects the test runner for a repository from its manifest contents.
 *
 * Pure: takes already-fetched text, performs no I/O, and never throws.
 * Returns null when neither manifest names a supported runner; the caller then
 * reports an unsupported-repository outcome rather than guessing.
 */
export function detectRunner(inputs: RunnerDetectionInputs): RunnerDetection | null {
  const packageJson = inputs.packageJson;
  if (isNonEmptyString(packageJson)) {
    const kind = detectFromPackageJson(packageJson);
    if (kind !== null) {
      return { kind };
    }
  }

  const pyprojectToml = inputs.pyprojectToml;
  if (isNonEmptyString(pyprojectToml)) {
    const kind = detectFromPyprojectToml(pyprojectToml);
    if (kind !== null) {
      return { kind };
    }
  }

  return null;
}
