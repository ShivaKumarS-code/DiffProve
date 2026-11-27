import { quoteShellArg } from './commands.js';
import type { RunnerKind, TestCaseResult } from './types.js';

const REPORT_DIR = '/tmp/diffprove';
const MAX_REPORT_BYTES = 512 * 1024;
const MAX_CASES = 4096;
const MAX_ID_LENGTH = 512;
const MAX_PERSISTED_CASES = 100;

// These helpers run in the sandbox. Both open only a bounded regular file; the
// nonblocking, no-follow open also prevents a FIFO or symlink in place of it.
// Python runs without repository imports, user Python settings, or site files.
const READ_PYTEST = `
import json, os, stat, sys
import xml.etree.ElementTree as ET

limit = ${MAX_REPORT_BYTES}
fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
with os.fdopen(fd, "rb") as f:
    info = os.fstat(f.fileno())
    if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
        sys.exit(1)
    raw = f.read(limit + 1)
text = raw.decode("utf-8")
if len(raw) > limit or "<!DOCTYPE" in text or "\\x00" in text:
    sys.exit(1)
root = ET.fromstring(raw, parser=ET.XMLParser(encoding="utf-8"))
if root.tag not in ("testsuites", "testsuite"):
    sys.exit(1)

cases = []
for suite in (root.findall("testsuite") if root.tag == "testsuites" else [root]):
    for case in suite.iterfind("testcase"):
        if len(cases) >= ${MAX_CASES}:
            sys.exit(1)
        tags = {child.tag for child in case}
        if (tags - {"properties", "system-out", "system-err", "failure", "skipped"}
                or ("failure" in tags and "skipped" in tags)):
            status = "unknown"
        elif "failure" in tags:
            status = "fail"
        elif "skipped" in tags:
            status = "skipped"
        else:
            status = "pass"
        row = {key: case.get(key) for key in ("file", "classname", "name")}
        cases.append({**row, "status": status})
output = json.dumps(cases, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
if len(output) > limit:
    sys.exit(1)
sys.stdout.buffer.write(output)
`.trim();

const READ_JSON = `
const fs = require('node:fs');
const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
const limit = ${MAX_REPORT_BYTES};
const fd = fs.openSync(process.argv[1], O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
try {
  const info = fs.fstatSync(fd);
  if (!info.isFile() || info.size > limit) process.exit(1);
  const bytes = Buffer.alloc(limit + 1);
  let size = 0;
  while (size < bytes.length) {
    const n = fs.readSync(fd, bytes, size, bytes.length - size, null);
    if (!n) break;
    size += n;
  }
  if (size > limit) process.exit(1);
  process.stdout.write(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
} finally {
  fs.closeSync(fd);
}
`.trim();

/** Report flags for built-in test commands only, and a constant sandbox read command. */
export function caseReportOptions(kind: RunnerKind): { args: string; readCommand: string } {
  if (kind === 'pytest') {
    const path = `${REPORT_DIR}/pytest-cases.xml`;
    return {
      // xunit1 includes the actual file path; a dotted classname is ambiguous.
      args: `--junitxml=${path} --junit-prefix= -o junit_family=xunit1 -o junit_logging=no`,
      readCommand: `python3 -I -S -c ${quoteShellArg(READ_PYTEST)} ${path}`,
    };
  }

  const path = kind === 'vitest' ? `${REPORT_DIR}/vitest-cases.json` : `${REPORT_DIR}/jest-cases.json`;
  return {
    args: kind === 'vitest'
      ? `--reporter=default --reporter=json --outputFile.json=${path}`
      : `--json --outputFile=${path}`,
    readCommand: `env -u NODE_OPTIONS -u NODE_PATH node -e ${quoteShellArg(READ_JSON)} ${path}`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdentityPart(value: unknown): value is string {
  // JSONB cannot store NUL or unpaired UTF-16 surrogates.
  return typeof value === 'string' &&
    value.length <= MAX_ID_LENGTH && !value.includes('\0') && !/\p{Cs}/u.test(value);
}

/** Match in-worktree absolute paths and relative paths without conflating basenames. */
function relativeFile(value: unknown, workspace: string): string | undefined {
  if (!isIdentityPart(value) || value === '') return undefined;

  // The sandboxes are Linux; only interpret backslashes as separators for a
  // Windows workspace. Backslashes in POSIX filenames are literal.
  const windows = /^[a-z]:[\\/]/i.test(workspace);
  const canonical = (path: string): string | undefined => {
    const separators = windows
      ? path.replaceAll('\\', '/').replace(/^[a-z]:/i, (s) => s.toLowerCase())
      : path;
    const parts = separators.split('/');
    if (parts.includes('..')) return undefined;
    const cleaned = parts.filter((part) => part !== '' && part !== '.').join('/');
    return separators.startsWith('/') ? `/${cleaned}` : cleaned;
  };

  const file = canonical(value);
  if (file === undefined || file === '') return undefined;
  if (!file.startsWith('/') && !(windows && /^[a-z]:/i.test(file))) return file;

  const root = canonical(workspace);
  if (root === undefined || root === '') return undefined;
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return file.startsWith(prefix) && file.length > prefix.length
    ? file.slice(prefix.length)
    : undefined;
}

/** An injective, human-readable tuple of file, suites/classes, and test name. */
function caseId(...parts: string[]): string | undefined {
  const id = parts.map((part) => part.replaceAll('\\', '\\\\').replaceAll(':', '\\:')).join('::');
  // Reject rather than truncate an identity that is used for comparison.
  return id.length <= MAX_ID_LENGTH ? id : undefined;
}

function parsePytest(report: unknown, workspace: string): TestCaseResult[] | undefined {
  if (!Array.isArray(report) || report.length > MAX_CASES) return undefined;
  const results: TestCaseResult[] = [];
  for (const row of report) {
    if (!isRecord(row) || !isIdentityPart(row.classname) || !isIdentityPart(row.name)) continue;
    const file = relativeFile(row.file, workspace);
    if (file === undefined) continue;
    // pytest's JUnit reporter encodes node-id file segments as a dotted module
    // prefix. Strip that prefix using the native file field and retain class names.
    const moduleName = file.replaceAll('/', '.').replace(/\.py$/, '');
    let lineage: string[];
    if (row.classname === moduleName) {
      lineage = [];
    } else if (row.classname.startsWith(`${moduleName}.`)) {
      lineage = row.classname.slice(moduleName.length + 1).split('.');
    } else {
      // The report does not specify a reliably reconstructible node identity.
      continue;
    }

    const id = caseId(file, ...lineage, row.name);
    if (id === undefined) continue;
    const status = row.status === 'pass' || row.status === 'fail' || row.status === 'skipped'
      ? row.status
      : 'unknown';
    results.push({ id, status });
  }
  return results;
}

function jsStatus(value: unknown): TestCaseResult['status'] {
  switch (value) {
    case 'passed': return 'pass';
    case 'failed': return 'fail';
    case 'pending':
    case 'skipped':
    case 'disabled':
    case 'todo': return 'skipped';
    default: return 'unknown';
  }
}

function parseJs(
  kind: 'vitest' | 'jest',
  report: unknown,
  workspace: string,
): TestCaseResult[] | undefined {
  if (!isRecord(report) || !Array.isArray(report.testResults) ||
      report.testResults.length > MAX_CASES) return undefined;
  const results: TestCaseResult[] = [];
  let count = 0;
  for (const suite of report.testResults) {
    if (!isRecord(suite) || !Array.isArray(suite.assertionResults)) continue;
    count += suite.assertionResults.length;
    if (count > MAX_CASES) return undefined;
    const file = relativeFile(suite.name, workspace);
    if (file === undefined) continue;

    // Vitest's message is a file-level error (separate from assertion
    // failures); Jest includes assertion failures there, but emits no
    // assertions for a collection/exec error.
    const fileError = kind === 'vitest' && suite.status === 'failed' &&
      typeof suite.message === 'string' && suite.message !== '';
    for (const row of suite.assertionResults) {
      if (!isRecord(row) || !isIdentityPart(row.title) || !Array.isArray(row.ancestorTitles) ||
          row.ancestorTitles.length > MAX_ID_LENGTH || !row.ancestorTitles.every(isIdentityPart)) {
        continue;
      }
      // fullName (space-joined) collides across distinct suite/title boundaries.
      const id = caseId(file, ...row.ancestorTitles, row.title);
      if (id !== undefined) {
        const status = jsStatus(row.status);
        results.push({ id, status: fileError && status !== 'skipped' ? 'unknown' : status });
      }
    }
  }
  return results;
}

/** Parse a bounded sandbox report; assertions without usable identities are omitted. */
export function parseTestCases(
  kind: RunnerKind,
  text: string,
  workspace: string,
): TestCaseResult[] | undefined {
  if (text.length > MAX_REPORT_BYTES || Buffer.byteLength(text) > MAX_REPORT_BYTES) {
    return undefined;
  }
  let report: unknown;
  try {
    report = JSON.parse(text);
  } catch {
    return undefined;
  }
  return kind === 'pytest' ? parsePytest(report, workspace) : parseJs(kind, report, workspace);
}

export interface TestCaseComparison {
  id: string;
  base: TestCaseResult['status'];
  head: TestCaseResult['status'];
}

export interface CaseEvidence {
  reproducing: number;
  nonReproducing: number;
  totalCases: number;
  cases: TestCaseComparison[];
}

function isReproducing({ base, head }: TestCaseComparison): boolean {
  return base === 'fail' && head === 'pass';
}

function isNonReproducing({ base, head }: TestCaseComparison): boolean {
  return base === 'pass' && head === 'pass';
}

function isConclusive(status: TestCaseResult['status']): boolean {
  return status === 'pass' || status === 'fail';
}

/** @internal Shared detail selection for storage and the GitHub summary. */
export function selectCaseDetails(
  cases: readonly TestCaseComparison[],
  limit: number,
): TestCaseComparison[] {
  if (cases.length <= limit) return cases.slice();

  const selected = new Set<number>();
  // Reserve one of each transition before a more numerous kind can fill the cap.
  for (const matches of [isReproducing, isNonReproducing]) {
    const index = cases.findIndex(matches);
    if (index >= 0 && selected.size < limit) selected.add(index);
  }

  function fill(matches: (row: TestCaseComparison) => boolean): void {
    for (const [index, row] of cases.entries()) {
      if (selected.size >= limit) break;
      if (matches(row)) selected.add(index);
    }
  }

  fill((row) => isReproducing(row) || isNonReproducing(row));
  fill(({ base, head }) => isConclusive(base) && isConclusive(head));
  fill(() => true);
  return cases.filter((_, index) => selected.has(index));
}

function indexCases(cases: TestCaseResult[]): Map<string, TestCaseResult['status']> {
  const index = new Map<string, TestCaseResult['status']>();
  for (const { id, status } of cases) {
    // With indistinguishable repeated cases (e.g. multi-project JS runs or
    // pytest call and teardown reports), pairing by arrival order is unsafe.
    index.set(id, index.has(id) ? 'unknown' : status);
  }
  return index;
}

export function summarizeCaseEvidence(
  a: TestCaseResult[] | undefined,
  b: TestCaseResult[] | undefined,
): CaseEvidence | null {
  if (a === undefined || b === undefined || a.length + b.length === 0) return null;

  const baseById = indexCases(a);
  const headById = indexCases(b);
  const ids = [...new Set([...baseById.keys(), ...headById.keys()])].sort();
  const comparisons = ids.map((id): TestCaseComparison => ({
    id,
    base: baseById.get(id) ?? 'unknown',
    head: headById.get(id) ?? 'unknown',
  }));
  return {
    reproducing: comparisons.filter(isReproducing).length,
    nonReproducing: comparisons.filter(isNonReproducing).length,
    totalCases: comparisons.length,
    cases: selectCaseDetails(comparisons, MAX_PERSISTED_CASES),
  };
}
