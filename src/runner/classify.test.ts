import { describe, expect, it } from 'vitest';

import { classifyRun } from './classify.js';
import type { SandboxRawResult } from './types.js';

/** Raw result with sane defaults; `overrides` models one sandbox observation. */
function raw(overrides: Partial<SandboxRawResult> = {}): SandboxRawResult {
  return {
    exitCode: 1,
    stdout: '',
    stderr: '',
    timedOut: false,
    durationMs: 1234,
    ...overrides,
  };
}

describe('classifyRun — status precedence', () => {
  it('classifies timedOut as timeout before looking at the exit code', () => {
    expect(classifyRun(raw({ timedOut: true, exitCode: 1 }), 'pytest').status).toBe('timeout');
    expect(classifyRun(raw({ timedOut: true, exitCode: 0 }), 'vitest').status).toBe('timeout');
  });

  it('classifies a null exit code as error', () => {
    expect(classifyRun(raw({ exitCode: null }), 'jest').status).toBe('error');
  });

  it('classifies exit code 0 as pass even when logs look like a failure', () => {
    const result = classifyRun(
      raw({ exitCode: 0, stdout: 'ModuleNotFoundError: No module named old' }),
      'pytest',
    );
    expect(result.status).toBe('pass');
  });

  it('classifies exit code 127 as error (missing command/runtime)', () => {
    const result = classifyRun(raw({ exitCode: 127, stderr: 'pytest: command not found' }), 'pytest');
    expect(result.status).toBe('error');
  });
});

describe('classifyRun — pytest patterns', () => {
  it('classifies ModuleNotFoundError as import-error', () => {
    const result = classifyRun(
      raw({ stderr: 'ModuleNotFoundError: No module named foo' }),
      'pytest',
    );
    expect(result.status).toBe('import-error');
  });

  it('classifies ImportError as import-error', () => {
    const result = classifyRun(
      raw({ stderr: 'ImportError: cannot import name "new_helper" from "app"' }),
      'pytest',
    );
    expect(result.status).toBe('import-error');
  });

  it('classifies a pytest SyntaxError as syntax-error', () => {
    const result = classifyRun(
      raw({ stderr: 'SyntaxError: invalid syntax\n  File "tests/test_x.py", line 3' }),
      'pytest',
    );
    expect(result.status).toBe('syntax-error');
  });

  it('prefers import-error when both signals appear in the output', () => {
    const result = classifyRun(
      raw({
        stdout: 'ImportError: cannot import name "x"',
        stderr: 'SyntaxError: invalid syntax',
      }),
      'pytest',
    );
    expect(result.status).toBe('import-error');
  });

  it('classifies an assertion failure as fail', () => {
    const result = classifyRun(
      raw({
        stdout: 'AssertionError: assert False',
        stderr: 'FAILED tests/test_x.py::test_new - AssertionError',
      }),
      'pytest',
    );
    expect(result.status).toBe('fail');
  });

  it('classifies exit code 1 with unrelated output as fail', () => {
    expect(classifyRun(raw({ stderr: 'collected 0 items / no tests ran' }), 'pytest').status).toBe(
      'fail',
    );
  });
});

describe('classifyRun — vitest / jest patterns', () => {
  it('classifies vitest "Cannot find module" as import-error', () => {
    const result = classifyRun(
      raw({ stderr: 'Error: Cannot find module "./new-symbol"' }),
      'vitest',
    );
    expect(result.status).toBe('import-error');
  });

  it('classifies a vitest transform failure as syntax-error', () => {
    const result = classifyRun(
      raw({ stderr: 'Transform failed with 1 error: Unexpected token "' }),
      'vitest',
    );
    expect(result.status).toBe('syntax-error');
  });

  it('classifies TS2307 as import-error', () => {
    const result = classifyRun(
      raw({ stdout: "src/a.ts(1,10): error TS2307: Cannot find module './b'" }),
      'vitest',
    );
    expect(result.status).toBe('import-error');
  });

  it('classifies jest "Module not found: Error" as import-error', () => {
    const result = classifyRun(
      raw({ stderr: "Module not found: Error: Can't resolve './missing' in '/app'" }),
      'jest',
    );
    expect(result.status).toBe('import-error');
  });

  it('classifies a jest SyntaxError as syntax-error', () => {
    const result = classifyRun(raw({ stderr: 'SyntaxError: Unexpected token <' }), 'jest');
    expect(result.status).toBe('syntax-error');
  });
});

describe('classifyRun — evidence handling', () => {
  it('classifies exit code 1 with unrelated output as fail', () => {
    const result = classifyRun(raw({ stderr: 'Expected 1 test, received 0' }), 'vitest');
    expect(result.status).toBe('fail');
  });

  it('passes exitCode and durationMs through unchanged', () => {
    const result = classifyRun(
      raw({ exitCode: 3, durationMs: 4321, stderr: 'something went wrong' }),
      'jest',
    );
    expect(result.status).toBe('fail');
    expect(result.exitCode).toBe(3);
    expect(result.durationMs).toBe(4321);
  });

  it('keeps exitCode null and the measured duration for error results', () => {
    const result = classifyRun(raw({ exitCode: null, durationMs: 77 }), 'vitest');
    expect(result).toMatchObject({ status: 'error', exitCode: null, durationMs: 77 });
  });

  it('combines stdout then stderr in that order', () => {
    const result = classifyRun(raw({ stdout: 'from stdout', stderr: 'from stderr' }), 'pytest');
    expect(result.logExcerpt).toBe('from stdout\nfrom stderr');
  });

  it('trims surrounding whitespace from the excerpt', () => {
    const result = classifyRun(raw({ stdout: '  \nfrom stdout\n  ', stderr: '' }), 'pytest');
    expect(result.logExcerpt).toBe('from stdout');
  });

  it('clips a 10_000 character excerpt to 4000 characters plus a marker', () => {
    const result = classifyRun(raw({ stdout: 'x'.repeat(10_000) }), 'pytest');
    expect(result.logExcerpt).toHaveLength(4000 + '\n… (clipped)'.length);
    expect(result.logExcerpt.endsWith('\n… (clipped)')).toBe(true);
    expect(result.logExcerpt.startsWith('x'.repeat(4000))).toBe(true);
  });

  it('does not clip an excerpt of exactly 4000 characters', () => {
    const result = classifyRun(raw({ stdout: 'y'.repeat(4000) }), 'pytest');
    expect(result.logExcerpt).toHaveLength(4000);
    expect(result.logExcerpt.endsWith('(clipped)')).toBe(false);
  });
});
