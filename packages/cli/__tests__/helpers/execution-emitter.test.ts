import { describe, it, expect, jest } from '@jest/globals';
import { ExecutionEventEmitter, type RunbookState } from '@rundown-org/core';
import type { OutputEmitter } from '../../src/services/output-emitter.js';
import { brandStoredOutputsForTest } from './brand-helpers.js';

const { createBridgedEmitter } = await import('../../src/helpers/execution-emitter.js');

type ExecutionEvent = Parameters<OutputEmitter['executionEvent']>[0];

describe('createBridgedEmitter', () => {
  function makeState(overrides: Partial<RunbookState> = {}): RunbookState {
    return {
      id: 'wf-test',
      runbook: { source: 'project', path: 'test-runbook.runbook.md' },
      runbookPath: 'test-runbook.runbook.md',
      step: '1',
      stepName: 'Step 1',
      retryCount: 0,
      variables: brandStoredOutputsForTest(),
      steps: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  function makeOutput(): {
    output: Pick<OutputEmitter, 'executionEvent'>;
    executionEventFn: jest.Mock<(event: ExecutionEvent) => void>;
  } {
    const executionEventFn = jest.fn<(event: ExecutionEvent) => void>();
    return {
      output: { executionEvent: executionEventFn },
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
      statePath: '.rundown/runs/wf-test.json',
    });

    expect(executionEventFn).toHaveBeenCalledTimes(1);
    const event = executionEventFn.mock.calls[0]?.[0];
    expect(event.type).toBe('RUNBOOK_STARTED');
    expect(event.runbookId).toBe('wf-test');
  });

  it('emits the persisted project runbook reference', () => {
    const { output, executionEventFn } = makeOutput();
    const state = makeState({
      runbook: { source: 'project', path: 'path/to/my-book.runbook.md' },
      runbookPath: 'path/to/my-book.runbook.md',
    });
    const emitter = createBridgedEmitter(state, output as unknown as OutputEmitter);

    emitter.emit('RUNBOOK_STARTED', {
      title: 'Test',
      prompted: false,
      statePath: '.rundown/runs/wf-test.json',
    });

    const event = executionEventFn.mock.calls[0]?.[0];
    expect(event.runbook).toEqual({ source: 'project', path: 'path/to/my-book.runbook.md' });
  });

  it('uses the persisted canonical runbook identity', () => {
    const { output, executionEventFn } = makeOutput();
    const state = makeState({
      runbook: { source: 'plugin', path: 'planning/write-plan.runbook.md' },
      runbookPath: '../../plugin/runbooks/planning/write-plan.runbook.md',
    });
    const emitter = createBridgedEmitter(state, output as unknown as OutputEmitter);

    emitter.emit('RUNBOOK_STARTED', {
      title: 'Test',
      prompted: false,
      statePath: '.rundown/runs/wf-test.json',
    });

    const event = executionEventFn.mock.calls[0]?.[0];
    expect(event.runbook).toEqual({ source: 'plugin', path: 'planning/write-plan.runbook.md' });
  });

  it('emits markdown paths without extension rewriting', () => {
    const { output, executionEventFn } = makeOutput();
    const state = makeState({
      runbook: { source: 'project', path: 'runbooks/substep-fail-any.md' },
      runbookPath: '../../var/folders/test/runbooks/substep-fail-any.md',
    });
    const emitter = createBridgedEmitter(state, output as unknown as OutputEmitter);

    emitter.emit('RUNBOOK_STARTED', {
      title: 'Test',
      prompted: false,
      statePath: '.rundown/runs/wf-test.json',
    });

    const event = executionEventFn.mock.calls[0]?.[0];
    expect(event.runbook).toEqual({
      source: 'project',
      path: 'runbooks/substep-fail-any.md',
    });
  });
});
