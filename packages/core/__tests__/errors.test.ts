import { describe, it, expect } from '@jest/globals';
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
