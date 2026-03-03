import { describe, it, expect, jest } from '@jest/globals';
import { ExecutionEventEmitter, type RunbookState } from '@rundown-org/core';
import type { OutputEmitter } from '../../src/services/output-emitter.js';

const { createBridgedEmitter } = await import('../../src/helpers/execution-emitter.js');

describe('createBridgedEmitter', () => {
  function makeState(overrides: Partial<RunbookState> = {}): RunbookState {
    return {
      id: 'wf-test',
      runbook: 'test-runbook',
      runbookPath: 'test-runbook.md',
      step: '1',
      stepName: 'Step 1',
      retryCount: 0,
      variables: {},
      steps: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  function makeOutput(): {
    output: Pick<OutputEmitter, 'executionEvent'>;
    executionEventFn: jest.Mock;
  } {
    const executionEventFn = jest.fn();
    return {
      output: { executionEvent: executionEventFn } as Pick<OutputEmitter, 'executionEvent'>,
      executionEventFn,
    };
  }

  it('returns an ExecutionEventEmitter instance', () => {
    const { output } = makeOutput();
    const emitter = createBridgedEmitter(makeState(), output as unknown as OutputEmitter);
    expect(emitter).toBeInstanceOf(ExecutionEventEmitter);
  });

  it('forwards emitted events to output.executionEvent()', () => {
    const { output, executionEventFn } = makeOutput();
    const emitter = createBridgedEmitter(makeState(), output as unknown as OutputEmitter);

    emitter.emit('RUNBOOK_STARTED', {
      title: 'Test',
      prompted: false,
      statePath: '.claude/rundown/runs/wf-test.json',
    });

    expect(executionEventFn).toHaveBeenCalledTimes(1);
    const event = executionEventFn.mock.calls[0]?.[0];
    expect(event.type).toBe('RUNBOOK_STARTED');
    expect(event.runbookId).toBe('wf-test');
  });

  it('uses runbook name and path from state', () => {
    const { output, executionEventFn } = makeOutput();
    const state = makeState({ runbook: 'my-book', runbookPath: 'path/to/my-book.md' });
    const emitter = createBridgedEmitter(state, output as unknown as OutputEmitter);

    emitter.emit('RUNBOOK_STARTED', {
      title: 'Test',
      prompted: false,
      statePath: '.claude/rundown/runs/wf-test.json',
    });

    const event = executionEventFn.mock.calls[0]?.[0];
    expect(event.runbook).toEqual({ name: 'my-book', path: 'path/to/my-book.md' });
  });
});
