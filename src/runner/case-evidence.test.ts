import { describe, expect, it } from 'vitest';

import { caseReportOptions, parseTestCases, summarizeCaseEvidence } from './case-evidence.js';
import type { TestCaseResult } from './types.js';

const BASE = '/tmp/diffprove/run-a';
const HEAD = '/tmp/diffprove/run-b';

describe('caseReportOptions', () => {
  it('writes only to fixed report paths outside the worktree', () => {
    const pytest = caseReportOptions('pytest');
    expect(pytest.args).toContain('--junitxml=/tmp/diffprove/pytest-cases.xml');
    expect(pytest.args).toContain('junit_family=xunit1');
    expect(pytest.readCommand).toMatch(/^python3 -I -S -c /);
    expect(pytest.readCommand).toContain('O_NOFOLLOW');
    expect(pytest.readCommand).toContain('<!DOCTYPE');

    const vitest = caseReportOptions('vitest');
    expect(vitest.args).toBe('--reporter=default --reporter=json --outputFile.json=/tmp/diffprove/vitest-cases.json');
    const jest = caseReportOptions('jest');
    expect(jest.args).toBe('--json --outputFile=/tmp/diffprove/jest-cases.json');
    for (const { readCommand } of [vitest, jest]) {
      expect(readCommand).toMatch(/^env -u NODE_OPTIONS -u NODE_PATH node -e /);
      expect(readCommand).toContain('O_NOFOLLOW');
    }
  });
});

describe('parseTestCases', () => {
  it('parses the pytest JUnit helper shape without using dotted modules as file IDs', () => {
    const cases = [
      { file: 'pkg/a.py', classname: 'pkg.a.TestSum', name: 'test_add[1-2]', status: 'fail' },
      { file: `${BASE}/pkg.a.py`, classname: 'pkg.a.TestSum', name: 'test_add[1-2]', status: 'pass' },
      { file: 'pkg/a.py', classname: 'pkg.a', name: 'test_pending', status: 'skipped' },
      { file: 'pkg/a.py', classname: 'pkg.a', name: 'test_setup', status: 'unknown' },
      { file: null, classname: '', name: 'pkg/test_collection.py', status: 'unknown' },
      { file: 'pkg/a.py', classname: 'other.Class', name: 'test_foreign', status: 'pass' },
    ];
    expect(parseTestCases('pytest', JSON.stringify(cases), BASE)).toEqual([
      { id: 'pkg/a.py::TestSum::test_add[1-2]', status: 'fail' },
      { id: 'pkg.a.py::TestSum::test_add[1-2]', status: 'pass' },
      { id: 'pkg/a.py::test_pending', status: 'skipped' },
      { id: 'pkg/a.py::test_setup', status: 'unknown' },
    ]);
  });

  it('reads native Vitest assertions and does not credit a broken file or missing assertions', () => {
    const report = {
      numTotalTests: 3,
      success: false,
      testResults: [
        {
          name: `${BASE}/src/sum.spec.ts`,
          status: 'failed',
          message: '',
          assertionResults: [
            { ancestorTitles: ['sum'], fullName: 'sum adds', title: 'adds', status: 'failed' },
            { ancestorTitles: [], fullName: 'incomplete', title: 'incomplete' },
          ],
        },
        { name: `${BASE}/src/import.spec.ts`, status: 'failed', message: 'Missing module', assertionResults: [] },
        {
          name: `${BASE}/src/setup.spec.ts`,
          status: 'failed',
          message: 'Could not set up test file',
          assertionResults: [
            { ancestorTitles: [], fullName: 'not run', title: 'not run', status: 'failed' },
            { ancestorTitles: [], fullName: 'skipped', title: 'skipped', status: 'skipped' },
          ],
        },
      ],
    };
    expect(parseTestCases('vitest', JSON.stringify(report), BASE)).toEqual([
      { id: 'src/sum.spec.ts::sum::adds', status: 'fail' },
      { id: 'src/sum.spec.ts::incomplete', status: 'unknown' },
      { id: 'src/setup.spec.ts::not run', status: 'unknown' },
      { id: 'src/setup.spec.ts::skipped', status: 'skipped' },
    ]);
  });

  it('reads native Jest assertion statuses, including failed assertions with a suite message', () => {
    const report = {
      numFailedTests: 1,
      testResults: [{
        name: 'c:\\sandbox\\repo\\spec\\sum.test.js',
        status: 'failed',
        message: 'Expected: 4 Received: 3',
        assertionResults: [
          { ancestorTitles: ['integer', 'sum'], title: 'adds', fullName: 'integer sum adds', status: 'failed' },
          { ancestorTitles: ['integer'], title: 'skips', fullName: 'integer skips', status: 'pending' },
          { ancestorTitles: [], title: 'later', fullName: 'later', status: 'todo' },
        ],
      }, {
        name: 'C:\\sandbox\\repo\\spec\\broken.test.js',
        status: 'failed',
        message: 'Could not load',
        assertionResults: [],
      }],
    };
    expect(parseTestCases('jest', JSON.stringify(report), 'C:\\sandbox\\repo')).toEqual([
      { id: 'spec/sum.test.js::integer::sum::adds', status: 'fail' },
      { id: 'spec/sum.test.js::integer::skips', status: 'skipped' },
      { id: 'spec/sum.test.js::later', status: 'skipped' },
    ]);
  });

  it('normalizes paths for two worktrees but preserves file paths and title boundaries', () => {
    const assertion = { ancestorTitles: [], title: 'adds', status: 'passed' };
    const report = (file: string, status: string): string => JSON.stringify({
      testResults: [{
        name: file,
        assertionResults: [
          { ...assertion, status },
          { ...assertion, ancestorTitles: ['a b'], title: 'c', fullName: 'a b c' },
          { ...assertion, ancestorTitles: ['a'], title: 'b c', fullName: 'a b c' },
          { ...assertion, ancestorTitles: ['a'], title: 'b::c' },
          { ...assertion, ancestorTitles: ['a', 'b'], title: 'c' },
        ],
      },
      { name: 'other/sum.test.ts', assertionResults: [assertion] },
      { name: 'src\\sum.test.ts', assertionResults: [assertion] },
      { name: '/outside/sum.test.ts', assertionResults: [assertion] },
      { name: '../../sum.test.ts', assertionResults: [assertion] }],
    });
    const a = parseTestCases('vitest', report(`${BASE}/src/sum.test.ts`, 'failed'), BASE);
    const b = parseTestCases('vitest', report('./src/sum.test.ts', 'passed'), HEAD);
    expect(a).toHaveLength(7);
    expect(a?.map(({ id }) => id)).toEqual(b?.map(({ id }) => id));
    expect(new Set(a?.map(({ id }) => id)).size).toBe(7);
    expect(summarizeCaseEvidence(a, b)).toMatchObject({
      totalCases: 7,
      reproducing: 1,
      nonReproducing: 6,
    });
  });

  it('rejects unusable report shapes and does not fall back to truncating identifiers', () => {
    expect(parseTestCases('vitest', '{', BASE)).toBeUndefined();
    expect(parseTestCases('jest', '{"testResults":{}}', BASE)).toBeUndefined();
    expect(parseTestCases('pytest', '{"testCases":[]}', BASE)).toBeUndefined();

    const report = {
      testResults: [{
        name: 'spec/sum.test.js',
        assertionResults: [
          { title: 'x'.repeat(512), ancestorTitles: [], status: 'passed' },
          { title: 'test\u0000name', ancestorTitles: [], status: 'passed' },
          { title: 'test\ud800name', ancestorTitles: [], status: 'passed' },
          { title: 'test name', ancestorTitles: [null], status: 'passed' },
          { fullName: 'test name', status: 'passed' },
        ],
      }],
    };
    expect(parseTestCases('jest', JSON.stringify(report), BASE)).toEqual([]);
  });

  it('bounds the input bytes and number of cases', () => {
    expect(parseTestCases('pytest', `[]${' '.repeat(512 * 1024 - 2)}`, BASE)).toEqual([]);
    expect(parseTestCases('pytest', `[]${' '.repeat(512 * 1024 - 1)}`, BASE)).toBeUndefined();
    expect(parseTestCases('jest', JSON.stringify({
      testResults: [],
      ignored: 'é'.repeat(256 * 1024),
    }), BASE)).toBeUndefined();
    expect(parseTestCases('vitest', JSON.stringify({
      testResults: [{ name: 'spec.js', assertionResults: Array(4097).fill(null) }],
    }), BASE)).toBeUndefined();
    expect(parseTestCases('pytest', JSON.stringify(Array(4097).fill(null)), BASE)).toBeUndefined();
  });
});

const result = (id: string, status: TestCaseResult['status']): TestCaseResult => ({ id, status });

describe('summarizeCaseEvidence', () => {
  it('returns null when reports are unavailable or contain no usable identities', () => {
    expect(summarizeCaseEvidence(undefined, [result('a', 'pass')])).toBeNull();
    expect(summarizeCaseEvidence([result('a', 'fail')], undefined)).toBeNull();
    expect(summarizeCaseEvidence([], [])).toBeNull();
  });

  it('counts only observed transitions, treating duplicates and unmatched cases as unknown', () => {
    const a = [
      result('base only', 'pass'),
      result('both pass', 'pass'),
      result('duplicate', 'fail'),
      result('duplicate', 'fail'),
      result('fixed', 'fail'),
      result('skipped', 'skipped'),
    ];
    const b = [
      result('both pass', 'pass'),
      result('duplicate', 'pass'),
      result('fixed', 'pass'),
      result('head only', 'pass'),
      result('skipped', 'pass'),
    ];
    expect(summarizeCaseEvidence(a, b)).toEqual({
      reproducing: 1,
      nonReproducing: 1,
      totalCases: 6,
      cases: [
        { id: 'base only', base: 'pass', head: 'unknown' },
        { id: 'both pass', base: 'pass', head: 'pass' },
        { id: 'duplicate', base: 'unknown', head: 'pass' },
        { id: 'fixed', base: 'fail', head: 'pass' },
        { id: 'head only', base: 'unknown', head: 'pass' },
        { id: 'skipped', base: 'skipped', head: 'pass' },
      ],
    });
    expect(summarizeCaseEvidence([], b)).toMatchObject({
      totalCases: b.length,
      reproducing: 0,
      nonReproducing: 0,
    });
  });

  it.each(['pass', 'fail'] as const)('keeps both transitions at the storage cap with 120 base %s cases', (majority) => {
    const minority = majority === 'pass' ? 'fail' : 'pass';
    const common = Array.from({ length: 120 }, (_, i) => result(`case ${String(i).padStart(3, '0')}`, majority));
    const a = [result('a skipped', 'skipped'), result('b unknown', 'unknown'), ...common, result('zzz', minority)];
    const b = a.map(({ id }) => result(id, 'pass'));
    const evidence = summarizeCaseEvidence(a, b);
    expect(evidence).toEqual({
      totalCases: 123,
      reproducing: majority === 'fail' ? 120 : 1,
      nonReproducing: majority === 'pass' ? 120 : 1,
      cases: [
        ...common.slice(0, 99).map(({ id }) => ({ id, base: majority, head: 'pass' })),
        { id: 'zzz', base: minority, head: 'pass' },
      ],
    });
  });
});
