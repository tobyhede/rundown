import { describe, expect, it, jest } from '@jest/globals';
import type { RunbookState, SessionService } from '@rundown-org/core';
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
  it('renders core-projected internal failure events without mutating runbook state', async () => {
    const releaseRunbook = jest.fn(async () => undefined);
    const sessionService = {
      releaseRunbook,
    } as unknown as SessionService;
    const sink = {
      onErrorOccurred: jest.fn(),
      onStepTransitioned: jest.fn(),
      onRunbookCompleted: jest.fn(),
      onRunbookStopped: jest.fn(),
    };

    const result = await orchestrateTransition({
      sessionService,
      sink,
      runbookId: baseState.id,
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
      policy: {
        onComplete: { releaseRunbook: false },
        onStopped: { releaseRunbook: false },
      },
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
    expect(releaseRunbook).not.toHaveBeenCalled();
  });

  it('returns the synchronized updated state on non-terminal transitions', async () => {
    const sessionService = {
      releaseRunbook: jest.fn(async () => undefined),
    } as unknown as SessionService;
    const sink = {
      onErrorOccurred: jest.fn(),
      onStepTransitioned: jest.fn(),
      onRunbookCompleted: jest.fn(),
      onRunbookStopped: jest.fn(),
    };
    const updatedState = { ...baseState, step: '2', stepName: 'Next' };

    const result = await orchestrateTransition({
      sessionService,
      sink,
      runbookId: baseState.id,
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
      policy: {
        onComplete: { releaseRunbook: false },
        onStopped: { releaseRunbook: false },
      },
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
});
