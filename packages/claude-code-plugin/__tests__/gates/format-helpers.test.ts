// packages/claude-code-plugin/__tests__/gates/format-helpers.test.ts
import { expect, describe, it } from '@jest/globals';
import { extractExecError, formatRunbookError } from '../../src/gates/format-helpers.js';

describe('extractExecError', () => {
  it('returns stdout when all properties present', () => {
    const error = { stdout: 'stdout', stderr: 'stderr', message: 'msg' };
    expect(extractExecError(error)).toBe('stdout');
  });

  it('returns stderr when stdout is undefined', () => {
    const error = { stderr: 'stderr', message: 'msg' };
    expect(extractExecError(error)).toBe('stderr');
  });

  it('returns message when stdout and stderr are undefined', () => {
    const error = new Error('Something failed');
    expect(extractExecError(error)).toBe('Something failed');
  });

  it('returns Unknown error when no useful properties', () => {
    expect(extractExecError({ code: 'ERR' })).toBe('Unknown error');
  });

  it('uses string value as message for string errors', () => {
    expect(extractExecError('string error')).toBe('string error');
  });

  it('handles null input', () => {
    expect(extractExecError(null)).toBe('Unknown error');
  });

  it('handles undefined input', () => {
    expect(extractExecError(undefined)).toBe('Unknown error');
  });

  it('handles number input', () => {
    expect(extractExecError(42)).toBe('Unknown error');
  });

  it('handles boolean input', () => {
    expect(extractExecError(true)).toBe('Unknown error');
  });

  it('skips empty stdout and returns stderr', () => {
    const error = { stdout: '', stderr: 'real error', message: 'msg' };
    expect(extractExecError(error)).toBe('real error');
  });

  it('skips empty stdout and stderr and returns message', () => {
    const error = { stdout: '', stderr: '', message: 'fallback message' };
    expect(extractExecError(error)).toBe('fallback message');
  });
});

describe('formatRunbookError', () => {
  it('includes runbook name in heading', () => {
    const result = formatRunbookError('my-runbook', 'some error');
    expect(result).toContain('RUNBOOK ERROR: my-runbook');
  });

  it('includes error in code block', () => {
    const result = formatRunbookError('rb', 'detailed error message');
    expect(result).toContain('detailed error message');
    expect(result).toContain('```');
  });

  it('includes recovery command with runbook name', () => {
    const result = formatRunbookError('my-runbook', 'err');
    expect(result).toContain('`rd run my-runbook`');
  });

  it('trims whitespace from error content', () => {
    const result = formatRunbookError('rb', '  padded error  ');
    expect(result).toContain('padded error');
    expect(result).not.toContain('  padded error  ');
  });
});
