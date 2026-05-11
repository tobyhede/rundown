import { describe, expect, it, jest } from '@jest/globals';
import type { RunbookState, SessionService, RunbookStateManager } from '@rundown-org/core';
import { orchestrateTransition } from '../../src/helpers/transition-orchestrator.js';

const baseState = {
  id: `rd_${'1'.repeat(32)}`,
  step: '1',
  status: 'running',
  retryCount: 0,
  variables: {},
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

describe('orchestrateTransition internal failure stop reasons', () => {
  it('maps OUTPUT_CAPTURE_FAILED lastAction to output_capture_failed stop reason', async () => {
    const manager = {
      update: jest.fn(async () => undefined),
      load: jest.fn(async () => null),
    } as unknown as RunbookStateManager;
    const sessionService = {
      releaseRunbook: jest.fn(async () => undefined),
    } as unknown as SessionService;
    const sink = {
      onStepTransitioned: jest.fn(),
      onRunbookCompleted: jest.fn(),
      onRunbookStopped: jest.fn(),
    };

    const result = await orchestrateTransition({
      manager,
      sessionService,
      sink,
      runbookId: baseState.id,
      steps,
      currentStep: steps[0],
      previousState: baseState,
      updatedState: { ...baseState, lifecycle: 'stopped' } as RunbookState,
      snapshot: {
        status: 'done',
        value: 'STOPPED',
        context: {
          lastAction: {
            type: 'OUTPUT_CAPTURE_FAILED',
            message: 'failed to capture Foo',
          },
        },
      },
      result: 'fail',
      actionResult: false,
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
    expect(sink.onRunbookStopped).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'output_capture_failed',
        message: 'failed to capture Foo',
      }),
    );
  });
});
