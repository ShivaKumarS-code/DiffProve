import { describe, expect, it } from 'vitest';

import { buildInstallCommand, buildTestCommand, findLockfile } from './commands.js';

describe('findLockfile', () => {
  it('prefers uv.lock over requirements.txt regardless of listing order', () => {
    expect(findLockfile(['requirements.txt', 'pyproject.toml', 'uv.lock'])).toEqual({
      name: 'uv.lock',
      path: 'uv.lock',
    });
  });

  it('follows the documented cross-ecosystem priority', () => {
    expect(findLockfile(['yarn.lock', 'poetry.lock'])).toEqual({
      name: 'poetry.lock',
      path: 'poetry.lock',
    });
    expect(findLockfile(['pnpm-lock.yaml', 'package-lock.json'])).toEqual({
      name: 'package-lock.json',
      path: 'package-lock.json',
    });
    expect(findLockfile(['yarn.lock', 'pnpm-lock.yaml'])).toEqual({
      name: 'pnpm-lock.yaml',
      path: 'pnpm-lock.yaml',
    });
  });

  it('matches a nested lockfile by basename and returns its listed path', () => {
    expect(findLockfile(['src/app.ts', 'sub/package-lock.json'])).toEqual({
      name: 'package-lock.json',
      path: 'sub/package-lock.json',
    });
  });

  it('matches Windows-style separators by basename', () => {
    expect(findLockfile(['sub\\yarn.lock'])).toEqual({
      name: 'yarn.lock',
      path: 'sub\\yarn.lock',
    });
  });

  it('returns null when no lockfile is present', () => {
    expect(findLockfile([])).toBeNull();
    expect(findLockfile(['package.json', 'pyproject.toml', 'src/index.ts'])).toBeNull();
  });
});

describe('buildInstallCommand — pytest', () => {
  it('uses uv sync when uv.lock is present', () => {
    expect(buildInstallCommand(['pyproject.toml', 'uv.lock'], 'pytest')).toBe('uv sync');
  });

  it('uses poetry install when poetry.lock is the best lockfile', () => {
    expect(buildInstallCommand(['poetry.lock', 'pyproject.toml'], 'pytest')).toBe('poetry install');
  });

  it('uses pip install -r with the matched requirements.txt path', () => {
    expect(buildInstallCommand(['sub/requirements.txt'], 'pytest')).toBe(
      'pip install -r sub/requirements.txt',
    );
  });

  it('falls back to an editable install for a bare pyproject.toml', () => {
    expect(buildInstallCommand(['pyproject.toml'], 'pytest')).toBe('pip install -e .');
  });

  it('prefers uv.lock over poetry.lock and requirements.txt', () => {
    expect(buildInstallCommand(['requirements.txt', 'poetry.lock', 'uv.lock'], 'pytest')).toBe(
      'uv sync',
    );
  });

  it('returns null when no Python manifest exists', () => {
    expect(buildInstallCommand(['package-lock.json'], 'pytest')).toBeNull();
    expect(buildInstallCommand([], 'pytest')).toBeNull();
  });
});

describe('buildInstallCommand — vitest / jest', () => {
  it('uses npm ci for package-lock.json', () => {
    expect(buildInstallCommand(['package.json', 'package-lock.json'], 'vitest')).toBe('npm ci');
    expect(buildInstallCommand(['package-lock.json'], 'jest')).toBe('npm ci');
  });

  it('uses pnpm install --frozen-lockfile for pnpm-lock.yaml', () => {
    expect(buildInstallCommand(['pnpm-lock.yaml'], 'vitest')).toBe(
      'pnpm install --frozen-lockfile',
    );
  });

  it('uses yarn install --frozen-lockfile for yarn.lock', () => {
    expect(buildInstallCommand(['yarn.lock'], 'vitest')).toBe('yarn install --frozen-lockfile');
  });

  it('falls back to npm install for a bare package.json', () => {
    expect(buildInstallCommand(['package.json'], 'vitest')).toBe('npm install');
    expect(buildInstallCommand(['package.json'], 'jest')).toBe('npm install');
  });

  it('prefers package-lock.json over pnpm and yarn lockfiles', () => {
    expect(buildInstallCommand(['yarn.lock', 'pnpm-lock.yaml', 'package-lock.json'], 'vitest')).toBe(
      'npm ci',
    );
  });

  it('returns null when no Node manifest exists', () => {
    expect(buildInstallCommand(['uv.lock'], 'vitest')).toBeNull();
    expect(buildInstallCommand([], 'jest')).toBeNull();
  });
});

describe('buildTestCommand', () => {
  it('builds a pytest command with every path double-quoted', () => {
    expect(buildTestCommand('pytest', ['tests/test_a.py', 'tests/unit/test b.py'])).toBe(
      'pytest "tests/test_a.py" "tests/unit/test b.py"',
    );
  });

  it('builds a vitest command', () => {
    expect(buildTestCommand('vitest', ['src/a.test.ts'])).toBe('npx vitest run "src/a.test.ts"');
  });

  it('builds a jest command', () => {
    expect(buildTestCommand('jest', ['src/a.spec.ts'])).toBe('npx jest "src/a.spec.ts"');
  });

  it('keeps a path containing a space quoted', () => {
    expect(buildTestCommand('pytest', ['dir with space/test_x.py'])).toBe(
      'pytest "dir with space/test_x.py"',
    );
  });

  it('omits the trailing space for an empty file list', () => {
    expect(buildTestCommand('pytest', [])).toBe('pytest');
    expect(buildTestCommand('vitest', [])).toBe('npx vitest run');
    expect(buildTestCommand('jest', [])).toBe('npx jest');
  });

  it('produces the exact same command for both runs of a differential pair', () => {
    const testFiles = ['tests/test_a.py'];
    expect(buildTestCommand('pytest', testFiles)).toBe(buildTestCommand('pytest', testFiles));
  });
});
