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

describe('withActionOverrides type-level contract', () => {
  // Each test exercises a distinct misuse. A test passes if:
  //   1. The `@ts-expect-error` line genuinely errors (TypeScript enforces this
  //      at build time — a missing error is itself a compile error).
  //   2. Jest runs the block without throwing.
  //
  // The runtime `expect(true).toBe(true)` keeps Jest happy; the real assertion
  // is made by `tsc`.

  it('rejects unknown override keys', () => {
    withActionOverrides({
      // @ts-expect-error - "notAnAction" is not a key of RunbookActionImpls
      notAnAction: () => {
        /* stub */
      },
    });
    expect(true).toBe(true);
  });

  it('rejects overrides with the wrong params shape', () => {
    withActionOverrides({
      // @ts-expect-error - `setLastAction` params require { action, msg? };
      // `wrongField` is not part of that shape.
      setLastAction: (_, params: { wrongField: string }) => {
        void params.wrongField;
      },
    });
    expect(true).toBe(true);
  });

  it('accepts a correctly typed override', () => {
    // Compile-time assertion: this call must NOT error. If a future refactor
    // accidentally makes the params shape unassignable, `tsc` fails here and
    // the test file stops compiling.
    withActionOverrides({
      setLastAction: (_, params) => {
        // `params` is inferred from runbookSetup — confirm the expected
        // shape is reachable without casts.
        void params.action;
        void params.msg;
      },
    });
    expect(true).toBe(true);
  });
});
