import { describe, expect, it } from 'vitest';

import { isTestFile, matchesGlob } from './glob.js';

describe('matchesGlob — defaults from the architecture doc', () => {
  it('matches test_*.py against a bare and a nested path', () => {
    expect(matchesGlob('test_foo.py', 'test_*.py')).toBe(true);
    expect(matchesGlob('tests/unit/test_foo.py', 'test_*.py')).toBe(true);
    expect(matchesGlob('foo.py', 'test_*.py')).toBe(false);
  });

  it('matches *_test.py on the basename', () => {
    expect(matchesGlob('lib/foo_test.py', '*_test.py')).toBe(true);
    expect(matchesGlob('foo_test.py', '*_test.py')).toBe(true);
    expect(matchesGlob('foo.py', '*_test.py')).toBe(false);
  });

  it('matches *.test.ts / *.spec.ts on the basename and is anchored', () => {
    expect(matchesGlob('src/deep/a.test.ts', '*.test.ts')).toBe(true);
    expect(matchesGlob('a.test.ts', '*.test.ts')).toBe(true);
    // Anchored: ".tsx" is not ".ts", and a bare "spec.ts" has no ".spec" segment.
    expect(matchesGlob('a.test.tsx', '*.test.ts')).toBe(false);
    expect(matchesGlob('spec.ts', '*.spec.ts')).toBe(false);
  });
});

describe('matchesGlob — full path vs basename', () => {
  it('matches a wildcard against the basename when the full path has slashes', () => {
    expect(matchesGlob('a/b/c.py', '*.py')).toBe(true);
    expect(matchesGlob('a/b/c.py', '*.js')).toBe(false);
  });

  it('supports ** across directories', () => {
    expect(matchesGlob('a/b/c.py', '**/*.py')).toBe(true);
    expect(matchesGlob('a/b/c.py', 'a/**/*.py')).toBe(true);
    expect(matchesGlob('x/b/c.py', 'a/**/*.py')).toBe(false);
  });

  it('treats * as "no slash" and ** as "any characters"', () => {
    expect(matchesGlob('a/b.py', 'a/*.py')).toBe(true);
    expect(matchesGlob('a/b/c.py', 'a/*.py')).toBe(false);
    expect(matchesGlob('a/b/c.py', 'a/**/*.py')).toBe(true);
  });
});

describe('matchesGlob — ? and literal escaping', () => {
  it('matches exactly one non-slash character for ?', () => {
    expect(matchesGlob('a.ts', '?.ts')).toBe(true);
    expect(matchesGlob('ab.ts', '?.ts')).toBe(false);
  });

  it('escapes RegExp metacharacters so dots are literal', () => {
    expect(matchesGlob('aXtestYts', '*.test.ts')).toBe(false);
    expect(matchesGlob('a.test.ts', 'a.test.ts')).toBe(true);
    expect(matchesGlob('aXtest.ts', 'a.test.ts')).toBe(false);
  });

  it('anchors both ends of the pattern', () => {
    expect(matchesGlob('test_a.py', 'test_*')).toBe(true);
    expect(matchesGlob('prefix_test_a.py', 'test_*.py')).toBe(false);
  });
});

describe('isTestFile', () => {
  it('applies DEFAULT_TEST_GLOBS when no list is given', () => {
    expect(isTestFile('tests/unit/test_foo.py')).toBe(true);
    expect(isTestFile('src/deep/a.spec.ts')).toBe(true);
    expect(isTestFile('lib/foo_test.py')).toBe(true);
    expect(isTestFile('src/app.ts')).toBe(false);
    expect(isTestFile('scripts/deploy.py')).toBe(false);
  });

  it('respects a custom glob list', () => {
    expect(isTestFile('tests/unit/snapshots/a.snap', ['**/snapshots/**'])).toBe(true);
    expect(isTestFile('tests/unit/a.snap', ['**/snapshots/**'])).toBe(false);
    // A custom list replaces the defaults rather than extending them.
    expect(isTestFile('test_foo.py', ['**/snapshots/**'])).toBe(false);
  });

  it('returns false for an empty glob list', () => {
    expect(isTestFile('test_foo.py', [])).toBe(false);
  });
});
