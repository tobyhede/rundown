import { describe, it, expect } from '@jest/globals';
import { asTemplateVars } from '../../src/runbook/retry-hook.js';

describe('asTemplateVars', () => {
  it('passes through strings, numbers, arrays, and objects unchanged', () => {
    const input = {
      s: 'hello',
      n: 42,
      arr: ['a', 'b'],
      obj: { host: 'x' },
    };
    const result = asTemplateVars(input);
    expect(result).toEqual(input);
  });

  it('filters out boolean values with a warning path', () => {
    const input = { kept: 'yes', dropped: true };
    const result = asTemplateVars(input);
    expect(result).toEqual({ kept: 'yes' });
    expect(Object.hasOwn(result, 'dropped')).toBe(false);
  });

  it('filters out null values', () => {
    const input = { kept: 'yes', nulled: null };
    const result = asTemplateVars(input);
    expect(result).toEqual({ kept: 'yes' });
    expect(Object.hasOwn(result, 'nulled')).toBe(false);
  });

  it('returns an empty object for an empty input', () => {
    expect(asTemplateVars({})).toEqual({});
  });
});
