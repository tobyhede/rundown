// packages/claude-code-plugin/__tests__/errors.test.ts
import { isNodeError, isError, getErrorMessage } from '../src/shared/index.js';

describe('isNodeError', () => {
  it('returns true for NodeJS.ErrnoException', () => {
    const err = new Error('test') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    expect(isNodeError(err)).toBe(true);
  });

  it('returns false for regular Error', () => {
    expect(isNodeError(new Error('test'))).toBe(false);
  });

  it('returns false for non-Error', () => {
    expect(isNodeError('string')).toBe(false);
    expect(isNodeError(null)).toBe(false);
    expect(isNodeError(undefined)).toBe(false);
  });
});

describe('isError', () => {
  it('returns true for Error instance', () => {
    expect(isError(new Error('test'))).toBe(true);
  });

  it('returns false for non-Error', () => {
    expect(isError('string')).toBe(false);
    expect(isError({ message: 'fake' })).toBe(false);
  });
});

describe('getErrorMessage', () => {
  it('extracts message from Error', () => {
    expect(getErrorMessage(new Error('test message'))).toBe('test message');
  });

  it('converts non-Error to string', () => {
    expect(getErrorMessage('string error')).toBe('string error');
    expect(getErrorMessage(123)).toBe('123');
    expect(getErrorMessage(null)).toBe('null');
  });
});
