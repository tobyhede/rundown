import { describe, expect, it, jest } from '@jest/globals';
import { Command } from 'commander';
import type { ClaimId, RunId } from '@rundown-org/core';
import {
  parseTransitionTarget,
  transitionTargetFields,
  withTransitionTargetOptions,
} from '../../src/helpers/transition-target.js';
import { takeExitCode } from './exit-code.js';

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

  // The rejection cases below assert `takeExitCode()` because signalling failure
  // through `process.exitCode` is part of the parser's contract, not incidental
  // bookkeeping. Consuming it here also leaves the process clean for the next test.

  it('rejects both flags with INVALID_SYNTAX and returns undefined', () => {
    const output = fakeOutput();
    const target = parseTransitionTarget({ claimId: CLAIM_ID, run: RUN_ID }, output as never);
    expect(target).toBeUndefined();
    expect(output.errors).toEqual([expect.objectContaining({ code: 'INVALID_SYNTAX' })]);
    expect(takeExitCode()).toBe(1);
  });

  it('rejects a malformed claim with INVALID_CLAIM_ID', () => {
    const output = fakeOutput();
    const target = parseTransitionTarget({ claimId: 'not-a-claim' }, output as never);
    expect(target).toBeUndefined();
    expect(output.errors).toEqual([expect.objectContaining({ code: 'INVALID_CLAIM_ID' })]);
    expect(takeExitCode()).toBe(1);
  });

  it('rejects a malformed run with INVALID_RUN_ID', () => {
    const output = fakeOutput();
    const target = parseTransitionTarget({ run: 'not-a-run' }, output as never);
    expect(target).toBeUndefined();
    expect(output.errors).toEqual([expect.objectContaining({ code: 'INVALID_RUN_ID' })]);
    expect(takeExitCode()).toBe(1);
  });

  it('applies precedence: both + malformed run yields INVALID_SYNTAX (not INVALID_RUN_ID)', () => {
    const output = fakeOutput();
    const target = parseTransitionTarget({ claimId: CLAIM_ID, run: 'not-a-run' }, output as never);
    expect(target).toBeUndefined();
    expect(output.errors).toEqual([expect.objectContaining({ code: 'INVALID_SYNTAX' })]);
    expect(takeExitCode()).toBe(1);
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

describe('withTransitionTargetOptions', () => {
  it('registers both --claim-id and --run as a bonded pair', () => {
    const command = new Command('demo');
    withTransitionTargetOptions(command);
    const longs = command.options.map((o) => o.long).sort();
    expect(longs).toEqual(['--claim-id', '--run']);
  });

  it('defaults to the standard shared descriptions', () => {
    const command = new Command('demo');
    withTransitionTargetOptions(command);
    const byLong = new Map(command.options.map((o) => [o.long, o]));
    expect(byLong.get('--claim-id')?.description).toBe('Target a claimed delegated child runbook');
    expect(byLong.get('--run')?.description).toBe('Target a runbook by run id');
  });

  it('accepts per-command description overrides', () => {
    const command = new Command('demo');
    withTransitionTargetOptions(command, { claimId: 'Custom claim help', run: 'Custom run help' });
    const byLong = new Map(command.options.map((o) => [o.long, o]));
    expect(byLong.get('--claim-id')?.description).toBe('Custom claim help');
    expect(byLong.get('--run')?.description).toBe('Custom run help');
  });

  it('returns the command for chaining', () => {
    const command = new Command('demo');
    expect(withTransitionTargetOptions(command)).toBe(command);
  });
});
