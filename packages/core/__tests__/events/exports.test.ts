import { describe, it, expect } from '@jest/globals';
import {
  ExecutionEventEmitter,
  type RunbookEventV1,
  type StepTransitionedPayload,
} from '../../src/index.js';

describe('core exports', () => {
  it('exports ExecutionEventEmitter', () => {
    expect(ExecutionEventEmitter).toBeDefined();
  });

  it('exports event types', () => {
    const event: RunbookEventV1 = {
      v: '1',
      type: 'STEP_TRANSITIONED',
      ts: new Date().toISOString(),
      runbookId: 'test',
      runbook: { name: 'test' },
      seq: 1,
      payload: {
        action: 'CONTINUE',
        from: '1',
        at: '2',
        result: 'PASS',
      } satisfies StepTransitionedPayload,
    };
    expect(event.type).toBe('STEP_TRANSITIONED');
  });
});
