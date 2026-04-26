import { describe, it, expect } from '@jest/globals';
import {
  resolveIndexOption,
  IndexOptionError,
  validateIndexRequiresStep,
} from '../../src/helpers/index-option.js';

describe('resolveIndexOption', () => {
  it('returns undefined when both inputs are undefined', () => {
    expect(resolveIndexOption(undefined, undefined)).toBeUndefined();
  });

  it('parses valid --index as positive integer', () => {
    expect(resolveIndexOption('1', undefined)).toBe(1);
    expect(resolveIndexOption('5', undefined)).toBe(5);
    expect(resolveIndexOption('100', undefined)).toBe(100);
  });

  it('rejects non-numeric --index', () => {
    expect(() => resolveIndexOption('abc', undefined)).toThrow(IndexOptionError);
    expect(() => resolveIndexOption('abc', undefined)).toThrow('Invalid --index value');
  });

  it('rejects zero --index', () => {
    expect(() => resolveIndexOption('0', undefined)).toThrow(IndexOptionError);
  });

  it('rejects negative --index', () => {
    expect(() => resolveIndexOption('-1', undefined)).toThrow(IndexOptionError);
  });

  it('rejects floating point --index', () => {
    expect(() => resolveIndexOption('1.5', undefined)).toThrow(IndexOptionError);
  });

  it('rejects empty string --index', () => {
    expect(() => resolveIndexOption('', undefined)).toThrow(IndexOptionError);
  });

  it('returns parsedAt when only parsedAt is provided (number)', () => {
    expect(resolveIndexOption(undefined, 3)).toBe(3);
  });

  it('returns undefined when only parsedAt is a template string', () => {
    expect(resolveIndexOption(undefined, '{{ Index }}')).toBeUndefined();
  });

  it('returns value when both match (idempotent)', () => {
    expect(resolveIndexOption('3', 3)).toBe(3);
  });

  it('throws CONFLICTING_INDEX when --index and parsedAt differ', () => {
    expect.assertions(2);
    try {
      resolveIndexOption('2', 5);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(IndexOptionError);
      expect((error as IndexOptionError).code).toBe('CONFLICTING_INDEX');
    }
  });

  it('throws CONFLICTING_INDEX when --index conflicts with template AT', () => {
    expect.assertions(2);
    try {
      resolveIndexOption('3', '{{ Index }}');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(IndexOptionError);
      expect((error as IndexOptionError).code).toBe('CONFLICTING_INDEX');
    }
  });

  it('error has INVALID_SYNTAX code for bad input', () => {
    expect.assertions(2);
    try {
      resolveIndexOption('bad-input', undefined);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(IndexOptionError);
      expect((error as IndexOptionError).code).toBe('INVALID_SYNTAX');
    }
  });
});

describe('validateIndexRequiresStep', () => {
  it('returns undefined when both are undefined', () => {
    expect(validateIndexRequiresStep(undefined, undefined)).toBeUndefined();
  });

  it('returns undefined when --step is provided without --index', () => {
    expect(validateIndexRequiresStep(undefined, '1.1')).toBeUndefined();
  });

  it('returns undefined when both --index and --step are provided', () => {
    expect(validateIndexRequiresStep('3', '1.1')).toBeUndefined();
  });

  it('returns error when --index is provided without --step', () => {
    expect(validateIndexRequiresStep('3', undefined)).toBe('--index requires --step');
  });
});
