import { describe, it, expect, jest } from '@jest/globals';
import { defaultActionStubs, withActionOverrides } from './test-actions.js';

describe('withActionOverrides', () => {
  it('returns the default stubs when no overrides are supplied', () => {
    const result = withActionOverrides();
    expect(Object.keys(result).sort()).toEqual(Object.keys(defaultActionStubs).sort());
    for (const key of Object.keys(defaultActionStubs)) {
      expect(result[key as keyof typeof defaultActionStubs]).toBe(
        defaultActionStubs[key as keyof typeof defaultActionStubs],
      );
    }
  });

  it('shallow-merges overrides on top of the defaults', () => {
    const spy = jest.fn();
    const result = withActionOverrides({ setLastAction: spy });

    expect(result.setLastAction).toBe(spy);
    // Every other key retains its default stub.
    for (const key of Object.keys(defaultActionStubs)) {
      if (key === 'setLastAction') continue;
      expect(result[key as keyof typeof defaultActionStubs]).toBe(
        defaultActionStubs[key as keyof typeof defaultActionStubs],
      );
    }
  });

  it('does not mutate the default stubs table when overrides are applied', () => {
    const before = { ...defaultActionStubs };
    withActionOverrides({ setLastAction: jest.fn() });
    expect(defaultActionStubs).toEqual(before);
  });
});
