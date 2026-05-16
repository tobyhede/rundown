import { describe, expect, it } from '@jest/globals';
import { LastActionSchema } from '../../src/runbook/last-action.js';

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
  ])('round-trips %#', (action) => {
    expect(LastActionSchema.parse(action)).toEqual(action);
  });

  it('rejects legacy aggregation markers without explicit origin', () => {
    expect(() => LastActionSchema.parse({ type: 'COMPLETE', aggregated: true })).toThrow();
  });
});
