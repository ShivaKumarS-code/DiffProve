import { describe, expect, it } from 'vitest';

import { splitDiff } from './split.js';
import type { SplitResult } from './types.js';

/**
 * Section fixtures are byte-exact slices of a GitHub `.diff` payload, and every
 * multi-section input is a plain concatenation of them — which is exactly the
 * property the splitter must preserve.
 */

const IMPL_A = [
  'diff --git a/src/app.py b/src/app.py',
  'index 1111111..2222222 100644',
  '--- a/src/app.py',
  '+++ b/src/app.py',
  '@@ -1,3 +1,4 @@',
  ' def main():',
  '-    return 1',
  '+    return 2',
  '+    # keep it boring',
  '',
].join('\n');

const ADDED_TEST = [
  'diff --git a/tests/test_added.py b/tests/test_added.py',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/tests/test_added.py',
  '@@ -0,0 +1,3 @@',
  '+def test_added():',
  '+    assert True',
  '+',
  '',
].join('\n');

const MODIFIED_TEST = [
  'diff --git a/tests/test_mod.py b/tests/test_mod.py',
  'index 4444444..5555555 100644',
  '--- a/tests/test_mod.py',
  '+++ b/tests/test_mod.py',
  '@@ -1,3 +1,3 @@',
  ' def test_mod():',
  '-    assert False',
  '+    assert True',
  '',
].join('\n');

const IMPL_B = [
  'diff --git a/src/lib.ts b/src/lib.ts',
  'index 6666666..7777777 100644',
  '--- a/src/lib.ts',
  '+++ b/src/lib.ts',
  '@@ -1,2 +1,2 @@',
  '-export const version = 1;',
  '+export const version = 2;',
  '',
].join('\n');

/** Byte-exactness is a property of every fixture, so it is asserted everywhere. */
function expectByteExact(input: string, result: SplitResult): void {
  expect(result.fullDiff).toBe(input);
  expect(result.files.map((section) => section.raw).join('')).toBe(input);
}

describe('splitDiff — mixed diff', () => {
  const input = IMPL_A + ADDED_TEST + MODIFIED_TEST + IMPL_B;
  const result = splitDiff(input);

  it('keeps the full PR patch verbatim and all files in order', () => {
    expectByteExact(input, result);
    expect(result.files).toHaveLength(4);
    expect(result.files.map((section) => section.path)).toEqual([
      'src/app.py',
      'tests/test_added.py',
      'tests/test_mod.py',
      'src/lib.ts',
    ]);
  });

  it('projects the test sections byte-exactly, in input order', () => {
    expect(result.testOnlyDiff).toBe(ADDED_TEST + MODIFIED_TEST);
    // The projection is a substring of the input, not a re-serialization.
    expect(input.includes(result.testOnlyDiff)).toBe(true);
  });

  it('lists changed and runnable test files and reports test changes', () => {
    expect(result.changedTestFiles).toEqual(['tests/test_added.py', 'tests/test_mod.py']);
    expect(result.runnableTestFiles).toEqual(['tests/test_added.py', 'tests/test_mod.py']);
    expect(result.hasTestChanges).toBe(true);
  });
});

describe('splitDiff — no test changes (pure-refactor short-circuit)', () => {
  const input = IMPL_A + IMPL_B;
  const result = splitDiff(input);

  it('reports no test changes and an empty test-only patch', () => {
    expectByteExact(input, result);
    expect(result.files).toHaveLength(2);
    expect(result.testOnlyDiff).toBe('');
    expect(result.changedTestFiles).toEqual([]);
    expect(result.runnableTestFiles).toEqual([]);
    expect(result.hasTestChanges).toBe(false);
  });
});

describe('splitDiff — deleted test file', () => {
  const DELETED_TEST = [
    'diff --git a/tests/test_gone.py b/tests/test_gone.py',
    'deleted file mode 100644',
    'index 8888888..0000000',
    '--- a/tests/test_gone.py',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-def test_gone():',
    '-    assert False',
    '',
  ].join('\n');
  const result = splitDiff(DELETED_TEST);

  it('is a test change worth reporting', () => {
    expectByteExact(DELETED_TEST, result);
    expect(result.changedTestFiles).toEqual(['tests/test_gone.py']);
    expect(result.hasTestChanges).toBe(true);
    expect(result.testOnlyDiff).toBe(DELETED_TEST);
  });

  it('is not runnable: it does not exist at head', () => {
    expect(result.runnableTestFiles).toEqual([]);
  });
});

describe('splitDiff — renamed test files', () => {
  const RENAMED_TEST_PURE = [
    'diff --git a/tests/old_test.py b/tests/new_test.py',
    'similarity index 100%',
    'rename from tests/old_test.py',
    'rename to tests/new_test.py',
    '',
  ].join('\n');

  const RENAMED_TEST_WITH_HUNKS = [
    'diff --git a/tests/old2_test.py b/tests/new2_test.py',
    'similarity index 80%',
    'rename from tests/old2_test.py',
    'rename to tests/new2_test.py',
    'index 9999999..aaaaaaa 100644',
    '--- a/tests/old2_test.py',
    '+++ b/tests/new2_test.py',
    '@@ -1 +1 @@',
    '-assert False',
    '+assert True',
    '',
  ].join('\n');

  const input = RENAMED_TEST_PURE + RENAMED_TEST_WITH_HUNKS;
  const result = splitDiff(input);

  it('classifies renames by their head (new) name', () => {
    expectByteExact(input, result);
    expect(result.changedTestFiles).toEqual(['tests/new_test.py', 'tests/new2_test.py']);
    expect(result.runnableTestFiles).toEqual(['tests/new_test.py', 'tests/new2_test.py']);
    expect(result.testOnlyDiff).toBe(input);
    expect(result.hasTestChanges).toBe(true);
  });
});

describe('splitDiff — binary test files', () => {
  const BINARY_TEST_DATA = [
    'diff --git a/test_data.bin b/test_data.bin',
    'index 2222222..3333333 100644',
    'Binary files a/test_data.bin and b/test_data.bin differ',
    '',
  ].join('\n');
  const result = splitDiff(BINARY_TEST_DATA, ['*.bin']);

  it('counts a matching binary as a change but never as runnable', () => {
    expectByteExact(BINARY_TEST_DATA, result);
    expect(result.changedTestFiles).toEqual(['test_data.bin']);
    expect(result.runnableTestFiles).toEqual([]);
    expect(result.testOnlyDiff).toBe(BINARY_TEST_DATA);
    expect(result.hasTestChanges).toBe(true);
  });
});

describe('splitDiff — custom globs', () => {
  const DEFAULT_MATCH = [
    'diff --git a/tests/test_default.py b/tests/test_default.py',
    'index bbbbbbb..ccccccc 100644',
    '--- a/tests/test_default.py',
    '+++ b/tests/test_default.py',
    '@@ -1 +1 @@',
    '-assert False',
    '+assert True',
    '',
  ].join('\n');

  const SNAP_TEST = [
    'diff --git a/tests/unit/x_snap.py b/tests/unit/x_snap.py',
    'index ddddddd..eeeeeee 100644',
    '--- a/tests/unit/x_snap.py',
    '+++ b/tests/unit/x_snap.py',
    '@@ -1 +1 @@',
    '-assert 1 == 1',
    '+assert 2 == 2',
    '',
  ].join('\n');

  const input = DEFAULT_MATCH + SNAP_TEST;

  it('replaces the default globs instead of extending them', () => {
    const result = splitDiff(input, ['*_snap.py']);
    expectByteExact(input, result);
    expect(result.changedTestFiles).toEqual(['tests/unit/x_snap.py']);
    expect(result.runnableTestFiles).toEqual(['tests/unit/x_snap.py']);
    expect(result.testOnlyDiff).toBe(SNAP_TEST);
    expect(result.hasTestChanges).toBe(true);
  });

  it('reports no test changes for an empty glob list', () => {
    const result = splitDiff(input, []);
    expectByteExact(input, result);
    expect(result.changedTestFiles).toEqual([]);
    expect(result.runnableTestFiles).toEqual([]);
    expect(result.testOnlyDiff).toBe('');
    expect(result.hasTestChanges).toBe(false);
  });
});

describe('splitDiff — empty and malformed input', () => {
  it('returns an empty result for the empty diff', () => {
    const result = splitDiff('');
    expect(result.fullDiff).toBe('');
    expect(result.testOnlyDiff).toBe('');
    expect(result.files).toEqual([]);
    expect(result.changedTestFiles).toEqual([]);
    expect(result.runnableTestFiles).toEqual([]);
    expect(result.hasTestChanges).toBe(false);
    expectByteExact('', result);
  });

  it('never throws on whitespace-only or junk input', () => {
    const junk = 'From 1234567 Mon Sep 17 00:00:00 2001\nnot a diff\n';
    expect(() => splitDiff(junk)).not.toThrow();
    const result = splitDiff(junk);
    expect(result.files).toEqual([]);
    expect(result.hasTestChanges).toBe(false);
    // The full patch is still returned verbatim even when nothing parses.
    expect(result.fullDiff).toBe(junk);
  });

  it('degrades a malformed section to a non-matching path instead of throwing', () => {
    const malformed = 'diff --git \nsome junk\n';
    const result = splitDiff(malformed);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe('');
    expect(result.changedTestFiles).toEqual([]);
    expect(result.hasTestChanges).toBe(false);
    expectByteExact(malformed, result);
  });
});
