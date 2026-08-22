import { describe, expect, it, jest } from '@jest/globals';
import type { RunbookState } from '@rundown-org/core';
import { orchestrateTransition } from '../../src/helpers/transition-orchestrator.js';

const baseState = {
  id: `rd_${'1'.repeat(32)}`,
  runbook: { source: 'project', path: 'test.runbook.md' },
  runbookPath: 'test.runbook.md',
  step: '1',
  stepName: 'Capture',
  lifecycle: 'running',
  retryCount: 0,
  variables: {},
  steps: [],
  startedAt: '2026-05-11T00:00:00.000Z',
  updatedAt: '2026-05-11T00:00:00.000Z',
} as unknown as RunbookState;

const steps = [
  {
    kind: 'command',
    name: '1',
    description: 'Capture',
    command: { code: 'echo hi', lang: 'sh' },
    transitions: {
      pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
      fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
    },
  },
] as any;

describe('orchestrateTransition', () => {
  it('renders core-projected internal failure events without mutating runbook state', () => {
    const sink = {
      onErrorOccurred: jest.fn(),
      onStepTransitioned: jest.fn(),
      onRunbookCompleted: jest.fn(),
      onRunbookStopped: jest.fn(),
    };

    const result = orchestrateTransition({
      sink,
      steps,
      currentStep: steps[0],
      previousState: baseState,
      updatedState: { ...baseState, lifecycle: 'stopped' },
      snapshot: {
        status: 'done',
        value: 'STOPPED',
        context: {
          lastAction: {
            type: 'OUTPUT_CAPTURE_FAILED',
            origin: 'direct',
            message: 'failed to capture Foo',
          },
        },
      },
      result: 'fail',
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: 'stopped',
        message: 'failed to capture Foo',
      }),
    );
    expect(sink.onStepTransitioned).not.toHaveBeenCalled();
    expect(sink.onErrorOccurred).toHaveBeenCalledWith({
      message: 'failed to capture Foo',
    });
    expect(sink.onRunbookStopped).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'output_capture_failed',
        message: 'failed to capture Foo',
      }),
    );
  });

  it('returns the synchronized updated state on non-terminal transitions', () => {
    const sink = {
      onErrorOccurred: jest.fn(),
      onStepTransitioned: jest.fn(),
      onRunbookCompleted: jest.fn(),
      onRunbookStopped: jest.fn(),
    };
    const updatedState = { ...baseState, step: '2', stepName: 'Next' };

    const result = orchestrateTransition({
      sink,
      steps: [
        ...steps,
        {
          kind: 'command',
          name: '2',
          description: 'Next',
          command: { code: 'echo next', lang: 'sh' },
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ] as any,
      currentStep: steps[0],
      previousState: baseState,
      updatedState,
      snapshot: {
        status: 'active',
        value: { 'step::2': 'idle' },
        context: { lastAction: { type: 'CONTINUE', origin: 'direct' } },
      },
      result: 'pass',
    });

    expect(result).toEqual({
      status: 'continue',
      state: updatedState,
      action: 'CONTINUE',
      from: '1',
      at: '2',
    });
    expect(sink.onStepTransitioned).toHaveBeenCalledWith({
      action: 'CONTINUE',
      from: '1',
      at: '2',
      result: 'PASS',
    });
  });

  it('tolerates a sink that omits the optional error handler', () => {
    // `onErrorOccurred` is optional on the sink, so a consumer may legitimately
    // omit it. Dispatching an ERROR_OCCURRED event must not throw for them.
    const sink = {
      onStepTransitioned: jest.fn(),
      onRunbookCompleted: jest.fn(),
      onRunbookStopped: jest.fn(),
    };

    expect(
      orchestrateTransition({
        sink,
        steps,
        currentStep: steps[0],
        previousState: baseState,
        updatedState: { ...baseState, lifecycle: 'stopped' },
        snapshot: {
          status: 'done',
          value: 'STOPPED',
          context: {
            lastAction: {
              type: 'OUTPUT_CAPTURE_FAILED',
              origin: 'direct',
              message: 'failed to capture Foo',
            },
          },
        },
        result: 'fail',
      }),
    ).toEqual(expect.objectContaining({ status: 'stopped' }));
  });

  it('reports done and emits only the completion event when the runbook completes', () => {
    const sink = {
      onErrorOccurred: jest.fn(),
      onStepTransitioned: jest.fn(),
      onRunbookCompleted: jest.fn(),
      onRunbookStopped: jest.fn(),
    };

    const result = orchestrateTransition({
      sink,
      steps,
      currentStep: steps[0],
      previousState: baseState,
      updatedState: { ...baseState, lifecycle: 'completed' },
      snapshot: {
        status: 'done',
        value: 'COMPLETE',
        context: { lastAction: { type: 'COMPLETE', origin: 'direct' } },
      },
      result: 'pass',
    });

    expect(sink.onErrorOccurred).not.toHaveBeenCalled();
    // Completion reaches the stream untouched, and no stop is fabricated
    // alongside it.
    expect(sink.onRunbookCompleted).toHaveBeenCalledTimes(1);
    expect(sink.onRunbookStopped).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ status: 'done' }));
  });
});
