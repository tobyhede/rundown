import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { ClaimId, RunId } from '@rundown-org/core';
import {
  parseTransitionTarget,
  transitionTargetFields,
} from '../../src/helpers/transition-target.js';

// The atomic parsers set `process.exitCode = 1` on failure (their real
// side-effect contract). Reset it after each test so a rejection case cannot
// make the Jest process itself exit non-zero.
afterEach(() => {
  process.exitCode = 0;
});

const CLAIM_ID =
  'rdclm_00000000000000000000000000000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const RUN_ID = `rd_${'1'.repeat(32)}`;

/** Minimal OutputEmitter double capturing error code + flush. */
function fakeOutput() {
  const errors: Array<{ message: string; code: string }> = [];
  return {
    errors,
    error: (message: string, code: string) => errors.push({ message, code }),
    flush: jest.fn(),
  };
}

describe('parseTransitionTarget', () => {
  it('returns { kind: "active" } when neither flag is supplied', () => {
    const output = fakeOutput();
    const target = parseTransitionTarget({}, output as never);
    expect(target).toEqual({ kind: 'active' });
    expect(output.errors).toHaveLength(0);
  });

  it('returns { kind: "claim" } for a valid --claim-id', () => {
    const output = fakeOutput();
    const target = parseTransitionTarget({ claimId: CLAIM_ID }, output as never);
    expect(target).toEqual({ kind: 'claim', claimId: CLAIM_ID as ClaimId });
  });

  it('returns { kind: "run" } for a valid --run', () => {
    const output = fakeOutput();
    const target = parseTransitionTarget({ run: RUN_ID }, output as never);
    expect(target).toEqual({ kind: 'run', runId: RUN_ID as RunId });
  });

  it('rejects both flags with INVALID_SYNTAX and returns undefined', () => {
    const output = fakeOutput();
    const target = parseTransitionTarget({ claimId: CLAIM_ID, run: RUN_ID }, output as never);
    expect(target).toBeUndefined();
    expect(output.errors).toEqual([expect.objectContaining({ code: 'INVALID_SYNTAX' })]);
  });

  it('rejects a malformed claim with INVALID_CLAIM_ID', () => {
    const output = fakeOutput();
    const target = parseTransitionTarget({ claimId: 'not-a-claim' }, output as never);
    expect(target).toBeUndefined();
    expect(output.errors).toEqual([expect.objectContaining({ code: 'INVALID_CLAIM_ID' })]);
  });

  it('rejects a malformed run with INVALID_RUN_ID', () => {
    const output = fakeOutput();
    const target = parseTransitionTarget({ run: 'not-a-run' }, output as never);
    expect(target).toBeUndefined();
    expect(output.errors).toEqual([expect.objectContaining({ code: 'INVALID_RUN_ID' })]);
  });

  it('applies precedence: both + malformed run yields INVALID_SYNTAX (not INVALID_RUN_ID)', () => {
    const output = fakeOutput();
    const target = parseTransitionTarget({ claimId: CLAIM_ID, run: 'not-a-run' }, output as never);
    expect(target).toBeUndefined();
    expect(output.errors).toEqual([expect.objectContaining({ code: 'INVALID_SYNTAX' })]);
  });
});

describe('transitionTargetFields', () => {
  it('maps claim to { claimId }', () => {
    expect(transitionTargetFields({ kind: 'claim', claimId: CLAIM_ID as ClaimId })).toEqual({
      claimId: CLAIM_ID,
    });
  });

  it('maps run to { runId }', () => {
    expect(transitionTargetFields({ kind: 'run', runId: RUN_ID as RunId })).toEqual({
      runId: RUN_ID,
    });
  });

  it('maps active to {}', () => {
    expect(transitionTargetFields({ kind: 'active' })).toEqual({});
  });
});
