import { describe, it, expect, jest } from '@jest/globals';
import {
  isNodeError,
  isError,
  getErrorMessage,
  isFileNotFoundError,
  type SessionLoadError,
} from '../src/errors.js';

describe('isNodeError', () => {
  it('returns true for Error with code property', () => {
    const error = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    expect(isNodeError(error)).toBe(true);
  });

  it('returns false for Error without code property', () => {
    const error = new Error('Something went wrong');
    expect(isNodeError(error)).toBe(false);
  });

  it('returns false for non-Error value', () => {
    expect(isNodeError('not an error')).toBe(false);
    expect(isNodeError({ code: 'ENOENT' })).toBe(false);
  });

  it('returns false for null and undefined', () => {
    expect(isNodeError(null)).toBe(false);
    expect(isNodeError(undefined)).toBe(false);
  });
});

describe('isError', () => {
  it('returns true for Error instance', () => {
    expect(isError(new Error('test'))).toBe(true);
    expect(isError(new TypeError('type error'))).toBe(true);
  });

  it('returns false for string', () => {
    expect(isError('error message')).toBe(false);
  });

  it('returns false for object', () => {
    expect(isError({ message: 'error' })).toBe(false);
  });

  it('returns false for null and undefined', () => {
    expect(isError(null)).toBe(false);
    expect(isError(undefined)).toBe(false);
  });
});

describe('getErrorMessage', () => {
  it('returns message from Error instance', () => {
    const error = new Error('test error message');
    expect(getErrorMessage(error)).toBe('test error message');
  });

  it('returns string value directly', () => {
    expect(getErrorMessage('string error')).toBe('string error');
  });

  it('converts number to string', () => {
    expect(getErrorMessage(404)).toBe('404');
  });

  it('handles null and undefined', () => {
    expect(getErrorMessage(null)).toBe('null');
    expect(getErrorMessage(undefined)).toBe('undefined');
  });
});

describe('isError fallback path', () => {
  // The polyfill resolves `nativeIsError` once at module load. To exercise
  // the `instanceof Error` fallback (the path used on Node ≤ 23, e.g.
  // WebContainer's Node 22.x), delete `Error.isError`, reset the module
  // cache, and re-import errors.ts fresh.
  it('falls back to instanceof Error when Error.isError is undefined', async () => {
    const original = (Error as { isError?: unknown }).isError;
    jest.resetModules();
    try {
      delete (Error as { isError?: unknown }).isError;
      const fallback = await import('../src/errors.js');
      expect(fallback.isError(new Error('boom'))).toBe(true);
      expect(fallback.isError(new TypeError('type'))).toBe(true);
      expect(fallback.isError('not an error')).toBe(false);
      expect(fallback.isError(null)).toBe(false);
      expect(fallback.isError(undefined)).toBe(false);
      expect(fallback.isError({ message: 'fake' })).toBe(false);

      const errnoLike = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      expect(fallback.isNodeError(errnoLike)).toBe(true);
      expect(fallback.isNodeError(new Error('no code'))).toBe(false);
    } finally {
      if (original !== undefined) {
        (Error as { isError?: unknown }).isError = original;
      }
    }
  });
});

describe('isFileNotFoundError', () => {
  it('returns true for file_not_found type', () => {
    const error: SessionLoadError = { type: 'file_not_found', path: '/test/path' };
    expect(isFileNotFoundError(error)).toBe(true);
  });

  it('returns false for parse_error type', () => {
    const error: SessionLoadError = {
      type: 'parse_error',
      path: '/test/path',
      message: 'Invalid JSON',
    };
    expect(isFileNotFoundError(error)).toBe(false);
  });

  it('returns false for validation_error type', () => {
    const error: SessionLoadError = {
      type: 'validation_error',
      path: '/test/path',
      message: 'Schema mismatch',
    };
    expect(isFileNotFoundError(error)).toBe(false);
  });
});
