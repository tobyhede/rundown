import { describe, it, expect, jest } from '@jest/globals';
import { isZodError } from '../src/shared/errors.js';

describe('isError fallback path', () => {
  // Mirrors the core test — exercises the `instanceof Error` fallback on
  // hosts that don't ship `Error.isError` (Node ≤ 23 / WebContainer 22.x).
  it('falls back to instanceof Error when Error.isError is undefined', async () => {
    const original = (Error as { isError?: unknown }).isError;
    jest.resetModules();
    try {
      delete (Error as { isError?: unknown }).isError;
      const fallback = await import('../src/shared/errors.js');
      expect(fallback.isError(new Error('boom'))).toBe(true);
      expect(fallback.isError('not an error')).toBe(false);
      expect(fallback.isError(null)).toBe(false);

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

describe('isZodError', () => {
  it('accepts cross-realm Zod-like error with valid issues', () => {
    const error = {
      issues: [
        { path: ['name'], message: 'Required' },
        { path: ['count'], message: 'Expected number' },
      ],
    };
    expect(isZodError(error)).toBe(true);
  });

  it('rejects single malformed issue entry', () => {
    const error = {
      issues: [{ path: 'not-an-array', message: 'Required' }],
    };
    expect(isZodError(error)).toBe(false);
  });

  it('rejects mixed valid/invalid issue arrays', () => {
    const error = {
      issues: [
        { path: ['name'], message: 'Required' },
        { path: 'not-an-array', message: 'Bad' },
      ],
    };
    expect(isZodError(error)).toBe(false);
  });

  it('rejects empty issues array', () => {
    expect(isZodError({ issues: [] })).toBe(false);
  });

  it('rejects non-array issues', () => {
    expect(isZodError({ issues: 'not-an-array' })).toBe(false);
  });

  it('rejects non-object', () => {
    expect(isZodError('string')).toBe(false);
    expect(isZodError(null)).toBe(false);
    expect(isZodError(42)).toBe(false);
  });

  it('rejects object without issues property', () => {
    expect(isZodError({ message: 'error' })).toBe(false);
  });

  it('rejects issue missing message field', () => {
    const error = {
      issues: [{ path: ['name'] }],
    };
    expect(isZodError(error)).toBe(false);
  });

  it('rejects issue missing path field', () => {
    const error = {
      issues: [{ message: 'Required' }],
    };
    expect(isZodError(error)).toBe(false);
  });
});
