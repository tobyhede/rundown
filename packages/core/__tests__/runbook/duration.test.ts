import { describe, expect, it } from '@jest/globals';
import { assertDurationMs, type DurationMs } from '../../src/runbook/duration.js';

describe('assertDurationMs (#519)', () => {
  it('accepts zero and positive finite values', () => {
    expect(assertDurationMs(0)).toBe(0);
    expect(assertDurationMs(1234)).toBe(1234);
  });

  it('rejects negative values with a RangeError', () => {
    // RangeError, not a bare Error: a caller-precondition violation, per
    // assertPositiveEntry (targeting.ts:44-48). The TYPE is the contract —
    // claimActivity's read boundary in plan 3 sorts throws by type, never by
    // message substring.
    expect(() => assertDurationMs(-1)).toThrow(RangeError);
    expect(() => assertDurationMs(-1)).toThrow('DurationMs must be a non-negative finite number');
  });

  it('rejects non-finite values with a RangeError', () => {
    expect(() => assertDurationMs(Number.NaN)).toThrow(RangeError);
    expect(() => assertDurationMs(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

// Type-level pin: `DurationMs` is branded, so a bare number is NOT assignable.
//
// `@ts-expect-error` is the whole mechanism: it fails the build if the error it
// expects STOPS occurring — i.e. the moment the brand is deleted and `DurationMs`
// decays to `number`, this line reports "Unused '@ts-expect-error' directive" and
// `check:types` goes red.
// @ts-expect-error - a bare number must not be assignable to the branded DurationMs
const _brandPin: DurationMs = 5;
void _brandPin;
