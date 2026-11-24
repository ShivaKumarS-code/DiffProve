import { describe, expect, it } from 'vitest';

import { parseUnifiedDiff } from './parse.js';

/**
 * Fixtures are assembled in-test from line arrays (no fixture files, no
 * network). Each constant is a byte-exact slice of a real GitHub `.diff`
 * payload, and multi-section inputs are plain concatenations of those slices.
 */

const IMPL_SECTION = [
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

const ADDED_TEST_SECTION = [
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

const MODIFIED_TEST_SECTION = [
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

describe('parseUnifiedDiff — mixed three-section diff', () => {
  const input = IMPL_SECTION + ADDED_TEST_SECTION + MODIFIED_TEST_SECTION;
  const sections = parseUnifiedDiff(input);

  it('keeps one section per `diff --git` header, in order', () => {
    expect(sections).toHaveLength(3);
    expect(sections.map((s) => s.path)).toEqual([
      'src/app.py',
      'tests/test_added.py',
      'tests/test_mod.py',
    ]);
  });

  it('derives status from the file-mode / hunk headers', () => {
    expect(sections.map((s) => s.status)).toEqual(['modified', 'added', 'modified']);
  });

  it('has no oldPath for in-place edits or a brand-new file', () => {
    expect(sections.map((s) => s.oldPath)).toEqual([null, null, null]);
  });

  it('counts hunks, additions and deletions by hand', () => {
    expect(sections.map((s) => s.hunks)).toEqual([1, 1, 1]);
    // impl: -return 1 / +return 2 / +# keep it boring
    // added: +def / +assert / + (the trailing blank added line)
    // mod:   -assert False / +assert True
    expect(sections.map((s) => s.additions)).toEqual([2, 3, 1]);
    expect(sections.map((s) => s.deletions)).toEqual([1, 0, 1]);
  });

  it('flags nothing as binary', () => {
    expect(sections.map((s) => s.isBinary)).toEqual([false, false, false]);
  });

  it('starts each raw exactly at its `diff --git` line', () => {
    expect(sections[0].raw.startsWith('diff --git a/src/app.py b/src/app.py\n')).toBe(true);
    expect(sections[1].raw.startsWith('diff --git a/tests/test_added.py b/tests/test_added.py\n')).toBe(
      true,
    );
    expect(sections[1].raw).toContain('--- /dev/null\n');
    expect(sections[2].raw.startsWith('diff --git a/tests/test_mod.py b/tests/test_mod.py\n')).toBe(
      true,
    );
  });

  it('preserves the input byte for byte when the raws are concatenated', () => {
    expect(sections.map((s) => s.raw).join('')).toBe(input);
  });
});

describe('parseUnifiedDiff — deleted file', () => {
  const DELETED_SECTION = [
    'diff --git a/gone.py b/gone.py',
    'deleted file mode 100644',
    'index 6666666..0000000',
    '--- a/gone.py',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-def test_gone():',
    '-    assert False',
    '',
  ].join('\n');

  it('takes the path from the `---` side and reports status deleted', () => {
    const sections = parseUnifiedDiff(DELETED_SECTION);
    expect(sections).toHaveLength(1);
    expect(sections[0].status).toBe('deleted');
    expect(sections[0].path).toBe('gone.py');
    expect(sections[0].oldPath).toBeNull();
    expect(sections[0].hunks).toBe(1);
    expect(sections[0].additions).toBe(0);
    expect(sections[0].deletions).toBe(2);
    expect(sections[0].raw).toBe(DELETED_SECTION);
  });
});

describe('parseUnifiedDiff — renames', () => {
  const RENAME_WITH_HUNKS = [
    'diff --git a/old_test.py b/new_test.py',
    'similarity index 85%',
    'rename from old_test.py',
    'rename to new_test.py',
    'index 7777777..8888888 100644',
    '--- a/old_test.py',
    '+++ b/new_test.py',
    '@@ -1,3 +1,3 @@',
    ' def test_x():',
    '-    assert False',
    '+    assert True',
    '',
  ].join('\n');

  const PURE_RENAME = [
    'diff --git a/old_name.py b/new_name.py',
    'similarity index 100%',
    'rename from old_name.py',
    'rename to new_name.py',
    '',
  ].join('\n');

  it('parses a rename with hunks from the rename-to line', () => {
    const sections = parseUnifiedDiff(RENAME_WITH_HUNKS);
    expect(sections).toHaveLength(1);
    expect(sections[0].status).toBe('renamed');
    expect(sections[0].path).toBe('new_test.py');
    expect(sections[0].oldPath).toBe('old_test.py');
    expect(sections[0].hunks).toBe(1);
    expect(sections[0].additions).toBe(1);
    expect(sections[0].deletions).toBe(1);
    expect(sections[0].isBinary).toBe(false);
  });

  it('parses a pure rename that has no ---/+++ lines at all', () => {
    const sections = parseUnifiedDiff(PURE_RENAME);
    expect(sections).toHaveLength(1);
    expect(sections[0].status).toBe('renamed');
    expect(sections[0].path).toBe('new_name.py');
    expect(sections[0].oldPath).toBe('old_name.py');
    expect(sections[0].hunks).toBe(0);
    expect(sections[0].additions).toBe(0);
    expect(sections[0].deletions).toBe(0);
    expect(sections[0].raw).toBe(PURE_RENAME);
  });
});

describe('parseUnifiedDiff — binary sections', () => {
  const BINARY = [
    'diff --git a/x.bin b/x.bin',
    'index 9999999..aaaaaaa 100644',
    'Binary files a/x.bin and b/x.bin differ',
    '',
  ].join('\n');

  const GIT_BINARY_PATCH = [
    'diff --git a/y.bin b/y.bin',
    'new file mode 100644',
    'index 0000000..bbbbbbb',
    'GIT binary patch',
    'literal 5',
    'Pc$@b0001',
    '',
  ].join('\n');

  it('detects `Binary files … differ` without inventing hunks', () => {
    const sections = parseUnifiedDiff(BINARY);
    expect(sections).toHaveLength(1);
    expect(sections[0].isBinary).toBe(true);
    expect(sections[0].path).toBe('x.bin');
    expect(sections[0].hunks).toBe(0);
    expect(sections[0].additions).toBe(0);
    expect(sections[0].deletions).toBe(0);
  });

  it('detects a `GIT binary patch` section', () => {
    const sections = parseUnifiedDiff(GIT_BINARY_PATCH);
    expect(sections).toHaveLength(1);
    expect(sections[0].isBinary).toBe(true);
    expect(sections[0].status).toBe('added');
    expect(sections[0].path).toBe('y.bin');
    expect(sections[0].hunks).toBe(0);
  });
});

describe('parseUnifiedDiff — quoted paths', () => {
  it('strips the surrounding quotes of a path with spaces', () => {
    const quoted = [
      'diff --git "a/my file.py" "b/my file.py"',
      'index ccccccc..ddddddd 100644',
      '--- "a/my file.py"',
      '+++ "b/my file.py"',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
    ].join('\n');

    const sections = parseUnifiedDiff(quoted);
    expect(sections).toHaveLength(1);
    expect(sections[0].path).toBe('my file.py');
    expect(sections[0].oldPath).toBeNull();
    expect(sections[0].additions).toBe(1);
    expect(sections[0].deletions).toBe(1);
  });

  it('strips quotes from rename lines too', () => {
    const quotedRename = [
      'diff --git "a/old name.py" "b/new name.py"',
      'similarity index 100%',
      'rename from "old name.py"',
      'rename to "new name.py"',
      '',
    ].join('\n');

    const sections = parseUnifiedDiff(quotedRename);
    expect(sections[0].path).toBe('new name.py');
    expect(sections[0].oldPath).toBe('old name.py');
    expect(sections[0].status).toBe('renamed');
  });
});

describe('parseUnifiedDiff — hunk-body edge cases', () => {
  it('counts additions across every hunk, not just the first', () => {
    const multiHunk = [
      'diff --git a/multi.py b/multi.py',
      'index 1234567..7654321 100644',
      '--- a/multi.py',
      '+++ b/multi.py',
      '@@ -1,2 +1,2 @@',
      '-a',
      '+A',
      ' ctx',
      '@@ -10,2 +10,3 @@',
      ' ctx2',
      '+added',
      '+added2',
      '',
    ].join('\n');

    const sections = parseUnifiedDiff(multiHunk);
    expect(sections).toHaveLength(1);
    expect(sections[0].hunks).toBe(2);
    expect(sections[0].additions).toBe(3);
    expect(sections[0].deletions).toBe(1);
    expect(sections[0].path).toBe('multi.py');
  });

  it('never counts the "\\ No newline at end of file" marker', () => {
    const noNewline = [
      'diff --git a/nl.py b/nl.py',
      'index eeeeeee..fffffff 100644',
      '--- a/nl.py',
      '+++ b/nl.py',
      '@@ -1,2 +1,2 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
      '',
    ].join('\n');

    const sections = parseUnifiedDiff(noNewline);
    expect(sections).toHaveLength(1);
    expect(sections[0].additions).toBe(1);
    expect(sections[0].deletions).toBe(1);
    expect(sections[0].hunks).toBe(1);
    expect(sections[0].path).toBe('nl.py');
  });

  it('counts a body line whose content begins with "+" exactly once', () => {
    const decoys = [
      'diff --git a/plus.py b/plus.py',
      'index 1234567..89abcde 100644',
      '--- a/plus.py',
      '+++ b/plus.py',
      '@@ -1,3 +1,3 @@',
      ' old',
      '+++ added content beginning with two plus signs',
      '--- removed content beginning with two minuses',
      '',
    ].join('\n');

    const sections = parseUnifiedDiff(decoys);
    expect(sections).toHaveLength(1);
    expect(sections[0].hunks).toBe(1);
    expect(sections[0].additions).toBe(1);
    expect(sections[0].deletions).toBe(1);
    // The `+++`/`---` decoys live after the first `@@`, so they must not
    // override the real header paths.
    expect(sections[0].path).toBe('plus.py');
    expect(sections[0].oldPath).toBeNull();
  });
});

describe('parseUnifiedDiff — junk, empty, and byte-exactness', () => {
  it('falls back to the diff --git line for a mode-only change', () => {
    const modeOnly = [
      'diff --git a/run.sh b/run.sh',
      'old mode 100644',
      'new mode 100755',
      '',
    ].join('\n');

    const sections = parseUnifiedDiff(modeOnly);
    expect(sections).toHaveLength(1);
    expect(sections[0].path).toBe('run.sh');
    expect(sections[0].oldPath).toBeNull();
    expect(sections[0].status).toBe('modified');
    expect(sections[0].hunks).toBe(0);
    expect(sections[0].additions).toBe(0);
    expect(sections[0].deletions).toBe(0);
  });

  it('uses the a-side of diff --git when the b-side token is missing', () => {
    const oneSided = ['diff --git a/only.py', ''].join('\n');
    const sections = parseUnifiedDiff(oneSided);
    expect(sections).toHaveLength(1);
    expect(sections[0].path).toBe('only.py');
    expect(sections[0].oldPath).toBeNull();
  });

  it('returns [] for the empty string and for whitespace-only input', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff('   \n\t\n  \r\n')).toEqual([]);
  });

  it('ignores everything before the first section', () => {
    const junk = [
      'From 1234567 Mon Sep 17 00:00:00 2001',
      'not a diff at all',
      'diff --gitx a/x b/x',
      '',
    ].join('\n');
    const sections = parseUnifiedDiff(junk + IMPL_SECTION);
    expect(sections).toHaveLength(1);
    expect(sections[0].path).toBe('src/app.py');
    expect(sections[0].raw).toBe(IMPL_SECTION);
  });

  it('returns [] when there is no section at all', () => {
    expect(parseUnifiedDiff('just some text\nand a second line\n')).toEqual([]);
    expect(parseUnifiedDiff('diff --git')).toEqual([]);
  });

  it('preserves a last section that has no trailing newline', () => {
    const withoutTrailingNewline = IMPL_SECTION + MODIFIED_TEST_SECTION.trimEnd();
    const sections = parseUnifiedDiff(withoutTrailingNewline);
    expect(sections).toHaveLength(2);
    expect(sections[1].raw).toBe(MODIFIED_TEST_SECTION.trimEnd());
    expect(sections[1].raw.endsWith('\n')).toBe(false);
    expect(sections.map((s) => s.raw).join('')).toBe(withoutTrailingNewline);
  });

  it('degrades to path "" instead of throwing on a malformed section', () => {
    expect(() => parseUnifiedDiff('diff --git \n')).not.toThrow();
    const sections = parseUnifiedDiff('diff --git \n');
    expect(sections).toHaveLength(1);
    expect(sections[0].path).toBe('');
    expect(sections[0].oldPath).toBeNull();
    expect(sections[0].status).toBe('modified');
  });
});
