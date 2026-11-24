import { describe, expect, it } from 'vitest';

import { detectRunner } from './detect.js';

/** Serializes a manifest object the way the worker would fetch it. */
function packageJson(manifest: unknown): string {
  return JSON.stringify(manifest);
}

describe('detectRunner — package.json dependencies', () => {
  it('detects vitest in devDependencies', () => {
    const json = packageJson({ devDependencies: { vitest: '^2.1.0' } });
    expect(detectRunner({ packageJson: json })).toEqual({ kind: 'vitest' });
  });

  it('detects jest in dependencies', () => {
    const json = packageJson({ dependencies: { jest: '^29.7.0' } });
    expect(detectRunner({ packageJson: json })).toEqual({ kind: 'jest' });
  });

  it('detects jest in devDependencies', () => {
    const json = packageJson({ devDependencies: { jest: '^29.7.0' } });
    expect(detectRunner({ packageJson: json })).toEqual({ kind: 'jest' });
  });

  it('prefers vitest over jest when both are installed', () => {
    const json = packageJson({
      devDependencies: { jest: '^29.7.0', vitest: '^2.1.0' },
    });
    expect(detectRunner({ packageJson: json })).toEqual({ kind: 'vitest' });
  });

  it('prefers a dependency over a contradictory scripts.test hint', () => {
    const json = packageJson({
      dependencies: { jest: '^29.7.0' },
      scripts: { test: 'vitest run' },
    });
    expect(detectRunner({ packageJson: json })).toEqual({ kind: 'jest' });
  });
});

describe('detectRunner — scripts.test fallback', () => {
  it('uses vitest from scripts.test when no dependency names it', () => {
    const json = packageJson({ scripts: { test: 'vitest run --reporter=dot' } });
    expect(detectRunner({ packageJson: json })).toEqual({ kind: 'vitest' });
  });

  it('uses jest from scripts.test when no dependency names it', () => {
    const json = packageJson({ scripts: { test: 'jest --ci' } });
    expect(detectRunner({ packageJson: json })).toEqual({ kind: 'jest' });
  });

  it('ignores a scripts.test that names no supported runner', () => {
    const json = packageJson({ scripts: { test: 'node --test' } });
    expect(detectRunner({ packageJson: json })).toBeNull();
  });

  it('ignores a non-string scripts.test', () => {
    const json = packageJson({ scripts: { test: ['vitest', 'run'] } });
    expect(detectRunner({ packageJson: json })).toBeNull();
  });
});

describe('detectRunner — pyproject.toml (v1 substring heuristic)', () => {
  it('detects pytest from [tool.pytest.ini_options]', () => {
    const pyprojectToml = '[tool.pytest.ini_options]\naddopts = "-q"\ntestpaths = ["tests"]\n';
    expect(detectRunner({ pyprojectToml })).toEqual({ kind: 'pytest' });
  });

  it('detects pytest from a dependency line', () => {
    const pyprojectToml = '[project.optional-dependencies]\ntest = ["pytest>=8"]\n';
    expect(detectRunner({ pyprojectToml })).toEqual({ kind: 'pytest' });
  });

  it('returns null when pyproject.toml does not mention pytest', () => {
    const pyprojectToml = '[project]\nname = "example"\nversion = "0.1.0"\n';
    expect(detectRunner({ pyprojectToml })).toBeNull();
  });

  it('returns null for an empty pyproject.toml', () => {
    expect(detectRunner({ pyprojectToml: '' })).toBeNull();
  });
});

describe('detectRunner — precedence and absent inputs', () => {
  it('falls back to pyproject.toml when packageJson is invalid JSON', () => {
    expect(
      detectRunner({
        packageJson: '{"devDependencies": {',
        pyprojectToml: '[tool.pytest.ini_options]\n',
      }),
    ).toEqual({ kind: 'pytest' });
  });

  it('returns null when invalid packageJson has no pyproject fallback', () => {
    expect(detectRunner({ packageJson: 'not json' })).toBeNull();
  });

  it('prefers packageJson vitest over pyprojectToml pytest', () => {
    expect(
      detectRunner({
        packageJson: packageJson({ devDependencies: { vitest: '^2.1.0' } }),
        pyprojectToml: '[tool.pytest.ini_options]\n',
      }),
    ).toEqual({ kind: 'vitest' });
  });

  it('prefers packageJson jest over pyprojectToml pytest', () => {
    expect(
      detectRunner({
        packageJson: packageJson({ devDependencies: { jest: '^29.7.0' } }),
        pyprojectToml: '[tool.pytest.ini_options]\n',
      }),
    ).toEqual({ kind: 'jest' });
  });

  it('returns null when package.json names no supported runner', () => {
    const json = packageJson({
      name: 'example',
      dependencies: { react: '^19.0.0' },
      scripts: { build: 'vite build' },
    });
    expect(detectRunner({ packageJson: json })).toBeNull();
  });

  it('lets pyproject.toml decide when package.json names no supported runner', () => {
    // Mixed repo: JS tooling but pytest tests. package.json cannot veto Python.
    expect(
      detectRunner({
        packageJson: packageJson({ name: 'web', scripts: { build: 'vite build' } }),
        pyprojectToml: '[tool.pytest.ini_options]\n',
      }),
    ).toEqual({ kind: 'pytest' });
  });

  it('treats empty and whitespace-only manifests as absent', () => {
    expect(detectRunner({ packageJson: '', pyprojectToml: '' })).toBeNull();
    expect(detectRunner({ packageJson: '   ', pyprojectToml: '\n\t' })).toBeNull();
    expect(detectRunner({ packageJson: null, pyprojectToml: null })).toBeNull();
    expect(detectRunner({})).toBeNull();
  });

  it('uses pyproject.toml when packageJson is an empty string', () => {
    expect(detectRunner({ packageJson: '', pyprojectToml: 'pytest' })).toEqual({ kind: 'pytest' });
  });

  it('treats non-object JSON packageJson values as absent', () => {
    expect(detectRunner({ packageJson: 'null' })).toBeNull();
    expect(detectRunner({ packageJson: '[]' })).toBeNull();
    expect(detectRunner({ packageJson: '"vitest"' })).toBeNull();
  });
});
