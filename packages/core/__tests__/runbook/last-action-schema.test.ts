import { describe, expect, it } from '@jest/globals';
import {
  LastActionSchema,
  clearAggregationRetryOnExhaustion,
  isAggregationLastAction,
} from '../../src/runbook/last-action.js';
import type { LastAction } from '../../src/runbook/types.js';

describe('LastActionSchema', () => {
  it.each([
    { type: 'START', origin: 'direct' },
    { type: 'CONTINUE', origin: 'direct' },
    { type: 'DEFER', origin: 'direct' },
    { type: 'GOTO', origin: 'direct', target: '2', substep: '1', at: 3 },
    { type: 'COMPLETE', origin: 'direct' },
    { type: 'STOP', origin: 'direct' },
    { type: 'RETRY', origin: 'direct' },
    { type: 'NEXT', origin: 'direct' },
    { type: 'BREAK', origin: 'direct' },
    { type: 'COMPLETE', origin: 'aggregation' },
    { type: 'STOP', origin: 'aggregation' },
    { type: 'GOTO', origin: 'aggregation', target: '3' },
    { type: 'RETRY', origin: 'aggregation' },
    { type: 'RETRY_ERROR', origin: 'direct', code: 'RD-902', message: 'retry hook failed' },
    { type: 'OUTPUT_CAPTURE_FAILED', origin: 'direct', message: 'disk full' },
    { type: 'ARTIFACT_RESOLUTION_FAILED', origin: 'direct', message: 'unbound artifact' },
    {
      type: 'FOR_RESOLUTION_FAILED',
      origin: 'direct',
      code: 'undefined-variable',
      message: 'bad source',
    },
    {
      type: 'DELEGATION_ISSUANCE_FAILED',
      origin: 'direct',
      reason: 'delegation_resolution_failed',
      message: 'missing child',
    },
    { type: 'POLICY_DENIED', origin: 'direct', message: 'command not in allowlist' },
    { type: 'COMMAND_EXECUTION_FAILED', origin: 'direct', message: 'spawn ENOENT' },
  ])('round-trips %#', (action) => {
    expect(LastActionSchema.parse(action)).toEqual(action);
  });

  it('rejects legacy aggregation markers without explicit origin', () => {
    expect(() => LastActionSchema.parse({ type: 'COMPLETE', aggregated: true })).toThrow();
  });

  it.each([
    {
      label: 'missing required message',
      input: { type: 'RETRY_ERROR', origin: 'direct', code: 'RD-902' },
    },
    { label: 'unknown origin literal', input: { type: 'COMPLETE', origin: 'derived' } },
    { label: 'unknown discriminant type', input: { type: 'WAT', origin: 'direct' } },
    { label: 'missing origin', input: { type: 'COMPLETE' } },
  ])('rejects malformed payload: $label', ({ input }) => {
    expect(LastActionSchema.safeParse(input).success).toBe(false);
  });
});

describe('clearAggregationRetryOnExhaustion', () => {
  it('clears RETRY with origin aggregation', () => {
    const action: LastAction = { type: 'RETRY', origin: 'aggregation' };
    expect(clearAggregationRetryOnExhaustion(action)).toBeUndefined();
  });

  it('preserves RETRY with origin direct', () => {
    const action: LastAction = { type: 'RETRY', origin: 'direct' };
    expect(clearAggregationRetryOnExhaustion(action)).toBe(action);
  });

  it('preserves other actions with origin aggregation', () => {
    const action: LastAction = { type: 'COMPLETE', origin: 'aggregation' };
    expect(clearAggregationRetryOnExhaustion(action)).toBe(action);
  });

  it('preserves undefined', () => {
    expect(clearAggregationRetryOnExhaustion(undefined)).toBeUndefined();
  });
});

describe('isAggregationLastAction', () => {
  it('narrows to the aggregation variant when true', () => {
    const action: LastAction | undefined = { type: 'RETRY', origin: 'aggregation' };
    if (isAggregationLastAction(action)) {
      const origin: 'aggregation' = action.origin;
      expect(origin).toBe('aggregation');
    } else {
      throw new Error('expected aggregation-origin action');
    }
  });

  it('returns false for direct-origin actions', () => {
    expect(isAggregationLastAction({ type: 'COMPLETE', origin: 'direct' })).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isAggregationLastAction(undefined)).toBe(false);
  });
});
