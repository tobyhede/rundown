import { describe, it, expect } from '@jest/globals';
import {
  ExecutionEventEmitter,
  deriveGotoActionBlock,
  deriveTransitionObservation,
  type RunbookEventV1,
  type StepTransitionedPayload,
  type TransitionObservation,
  type TransitionObservationEvent,
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
      runbook: { source: 'project', path: 'test.runbook.md' },
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

  it('exports transition observation helpers', () => {
    expect(typeof deriveTransitionObservation).toBe('function');
    expect(typeof deriveGotoActionBlock).toBe('function');
    const _observation: TransitionObservation | undefined = undefined;
    const _event: TransitionObservationEvent | undefined = undefined;
    expect(_observation).toBeUndefined();
    expect(_event).toBeUndefined();
  });
});
