import { describe, expect, it } from 'vitest';

import {
  buildInstallCommand,
  buildTestCommand,
  findLockfile,
  formatCustomTestCommand,
  quoteShellArg,
} from './commands.js';

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
  it('bootstraps uv when missing and runs uv sync when uv.lock is present', () => {
    expect(buildInstallCommand(['pyproject.toml', 'uv.lock'], 'pytest')).toBe(
      '(command -v uv >/dev/null 2>&1 || pip install -q uv) && uv sync',
    );
  });

  it('bootstraps poetry when missing and runs poetry install with in-project virtualenv when poetry.lock is the best lockfile', () => {
    expect(buildInstallCommand(['poetry.lock', 'pyproject.toml'], 'pytest')).toBe(
      '(command -v poetry >/dev/null 2>&1 || pip install -q poetry) && POETRY_VIRTUALENVS_IN_PROJECT=true poetry install',
    );
  });

  it('uses pip install -r with the matched single-quoted requirements.txt path', () => {
    expect(buildInstallCommand(['sub/requirements.txt'], 'pytest')).toBe(
      "pip install -r 'sub/requirements.txt'",
    );
  });

  it('shell-quotes a nested requirements.txt path containing spaces and special characters', () => {
    expect(buildInstallCommand(["sub dir/it's/requirements.txt"], 'pytest')).toBe(
      "pip install -r 'sub dir/it'\\''s/requirements.txt'",
    );
  });

  it('falls back to an editable install for a bare pyproject.toml', () => {
    expect(buildInstallCommand(['pyproject.toml'], 'pytest')).toBe('pip install -e .');
  });

  it('prefers uv.lock over poetry.lock and requirements.txt', () => {
    expect(buildInstallCommand(['requirements.txt', 'poetry.lock', 'uv.lock'], 'pytest')).toBe(
      '(command -v uv >/dev/null 2>&1 || pip install -q uv) && uv sync',
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

  it('uses npx --yes pnpm install --frozen-lockfile for pnpm-lock.yaml', () => {
    expect(buildInstallCommand(['pnpm-lock.yaml'], 'vitest')).toBe(
      'npx --yes pnpm install --frozen-lockfile',
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

describe('quoteShellArg', () => {
  it('wraps paths in single quotes and neutralizes shell metacharacters', () => {
    expect(quoteShellArg('tests/$(id).py')).toBe("'tests/$(id).py'");
    expect(quoteShellArg('tests/`uname`.py')).toBe("'tests/`uname`.py'");
    expect(quoteShellArg('tests/"quoted".py')).toBe('\'tests/"quoted".py\'');
    expect(quoteShellArg("tests/it's_a_test.py")).toBe("'tests/it'\\''s_a_test.py'");
  });
});

describe('buildTestCommand', () => {
  it('builds a pytest command with every path single-quoted', () => {
    expect(buildTestCommand('pytest', ['tests/test_a.py', 'tests/unit/test b.py'])).toBe(
      "pytest 'tests/test_a.py' 'tests/unit/test b.py'",
    );
  });

  it('builds a vitest command', () => {
    expect(buildTestCommand('vitest', ['src/a.test.ts'])).toBe("npx vitest run 'src/a.test.ts'");
  });

  it('builds a jest command', () => {
    expect(buildTestCommand('jest', ['src/a.spec.ts'])).toBe("npx jest 'src/a.spec.ts'");
  });

  it('keeps a path containing a space single-quoted', () => {
    expect(buildTestCommand('pytest', ['dir with space/test_x.py'])).toBe(
      "pytest 'dir with space/test_x.py'",
    );
  });

  it('safely single-quotes paths containing $(...), backticks, double quotes, and single quotes', () => {
    expect(
      buildTestCommand('pytest', [
        'tests/$(touch pwn).py',
        'tests/`id`.py',
        'tests/"double".py',
        "tests/single'quote.py",
      ]),
    ).toBe(
      "pytest 'tests/$(touch pwn).py' 'tests/`id`.py' 'tests/\"double\".py' 'tests/single'\\''quote.py'",
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

describe('formatCustomTestCommand', () => {
  it('replaces {file} and {files} with single-quoted test files', () => {
    expect(formatCustomTestCommand('pytest -v {file}', ['tests/test_a.py'])).toBe(
      "pytest -v 'tests/test_a.py'",
    );
    expect(
      formatCustomTestCommand('npx vitest run {files}', ['src/a.test.ts', 'src/b.test.ts']),
    ).toBe("npx vitest run 'src/a.test.ts' 'src/b.test.ts'");
  });

  it('replaces all occurrences of {file} and {files}', () => {
    expect(
      formatCustomTestCommand('echo {file} && pytest {files}', ['tests/a.py', 'tests/b.py']),
    ).toBe("echo 'tests/a.py' 'tests/b.py' && pytest 'tests/a.py' 'tests/b.py'");
  });

  it('quotes special characters including $(...), backticks, double quotes, single quotes, and $&', () => {
    expect(
      formatCustomTestCommand('pytest {files}', [
        'tests/$(id).py',
        'tests/`id`.py',
        'tests/"q".py',
        "tests/o'hara.py",
        'tests/$&x.py',
      ]),
    ).toBe(
      "pytest 'tests/$(id).py' 'tests/`id`.py' 'tests/\"q\".py' 'tests/o'\\''hara.py' 'tests/$&x.py'",
    );
  });

  it('returns templates without placeholders verbatim', () => {
    expect(formatCustomTestCommand('pytest -q --maxfail=1', ['tests/a.py'])).toBe(
      'pytest -q --maxfail=1',
    );
    expect(formatCustomTestCommand('  npm test  ', [])).toBe('  npm test  ');
  });

  it('handles an empty test file list when placeholders are present without trailing space', () => {
    expect(formatCustomTestCommand('pytest -v {files}', [])).toBe('pytest -v');
  });
});
