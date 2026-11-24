/**
 * Diff splitter — Phase 2, pipeline step 2.
 *
 * docs/architecture.md, "End-to-End Verification Pipeline": "The worker pulls
 * the unified PR diff via GitHub API and splits changed files into two patches
 * using repo-configured test globs … **Test-Only Patch:** Only additions/edits
 * to test files. **Full PR Patch:** Complete implementation + test changes."
 *
 * The Test-Only Patch is a projection of the input: the `raw` bytes of the
 * selected sections are concatenated in diff order and never re-serialized, so
 * it applies cleanly wherever the full diff would.
 *
 * Edge cases handled here (also named in the architecture doc): deleted test
 * files are a test change worth reporting but cannot be executed at head, and
 * pure-refactor PRs (no test changes at all) short-circuit to `neutral` via
 * `!hasTestChanges`.
 */

import { isTestFile } from './glob.js';
import { parseUnifiedDiff } from './parse.js';
import { DEFAULT_TEST_GLOBS } from './types.js';
import type { DiffFileSection, SplitResult } from './types.js';

/**
 * Split `diff` into the Full PR Patch and the Test-Only Patch.
 *
 * Classification uses each section's b-side path, i.e. the path the file has at
 * head: a rename is judged by its new name, so a deleted test file is still a
 * test change (it is matched by its old path, which is also its b-side path for
 * deletions) and a file renamed *into* a test name becomes a test file.
 *
 * `globs` replaces the defaults entirely; an empty list means "nothing is a
 * test file". Never throws — malformed input degrades to an empty result.
 */
export function splitDiff(diff: string, globs: readonly string[] = DEFAULT_TEST_GLOBS): SplitResult {
  // Keep the Full PR Patch byte-identical to what GitHub returned.
  const fullDiff = typeof diff === 'string' ? diff : '';
  const files = parseUnifiedDiff(fullDiff);

  const testFiles: DiffFileSection[] = files.filter((file) => isTestFile(file.path, globs));

  const changedTestFiles = testFiles.map((file) => file.path);

  // Deleted and binary test files exist in name only at head, so Run A / Run B
  // have nothing to execute for them.
  const runnableTestFiles = testFiles
    .filter(
      (file) =>
        (file.status === 'added' || file.status === 'modified' || file.status === 'renamed') &&
        !file.isBinary,
    )
    .map((file) => file.path);

  // Byte-exact projection: no trimming, no added or dropped newlines.
  const testOnlyDiff = testFiles.map((file) => file.raw).join('');

  return {
    fullDiff,
    testOnlyDiff,
    files,
    changedTestFiles,
    runnableTestFiles,
    hasTestChanges: changedTestFiles.length > 0,
  };
}
