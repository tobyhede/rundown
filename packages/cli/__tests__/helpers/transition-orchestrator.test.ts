import { describe, expect, it, jest } from '@jest/globals';
import type { RunbookState, RunId, SessionService } from '@rundown-org/core';
import { orchestrateTransition } from '../../src/helpers/transition-orchestrator.js';
import { committed } from './session-mutation-fixtures.js';

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

  it.each([
    {
      label: 'execution_in_progress',
      refusal: {
        kind: 'execution_in_progress' as const,
        runId: baseState.id,
        message: `Run ${baseState.id} has an execution in progress.`,
      },
      code: 'EXECUTION_IN_PROGRESS',
    },
    {
      label: 'recovery_required',
      refusal: {
        kind: 'recovery_required' as const,
        runId: baseState.id,
        epoch: 7,
        message:
          `Run ${baseState.id} ended execution with an unknown outcome at epoch 7; its ` +
          `recovery has not completed. Recovery is automatic and has no separate command; ` +
          `this mutation wrote nothing.`,
      },
      code: 'RECOVERY_REQUIRED',
    },
  ])(
    'downgrades a completed transition to stopped when the terminal release refuses $label',
    async ({ refusal, code }) => {
      // The transition reached `done`, but the terminal release it owed did not
      // commit. Reporting `done` here would tell the caller the run was released
      // when it was not, so the refusal must both surface and change the status.
      const releaseRunbook = jest.fn(async (_id: RunId, _o?: unknown) => refusal);
      const sessionService = { releaseRunbook } as unknown as SessionService;
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
        updatedState: { ...baseState, lifecycle: 'completed' },
        snapshot: {
          status: 'done',
          value: 'COMPLETE',
          context: { lastAction: { type: 'COMPLETE', origin: 'direct' } },
        },
        result: 'pass',
        policy: {
          onComplete: { releaseRunbook: true },
          onStopped: { releaseRunbook: true },
        },
      });

      expect(releaseRunbook).toHaveBeenCalledWith(baseState.id, { retainClaimsAsTerminal: true });
      expect(sink.onErrorOccurred).toHaveBeenCalledWith({ message: refusal.message, code });
      expect(result).toEqual(
        expect.objectContaining({ status: 'stopped', message: refusal.message }),
      );
      // The return value alone is not enough: a consumer reading the event
      // stream must not have been told the run completed. The completion event
      // is dispatched from the same observation, so it has to wait on the
      // release rather than race ahead of it.
      expect(sink.onRunbookCompleted).not.toHaveBeenCalled();
      // The downgraded stop keeps the position the completion carried and names
      // the refusal as its reason, so the stream is not merely silent about the
      // failure — it says where the run stopped and why.
      expect(sink.onRunbookStopped).toHaveBeenCalledWith({
        position: { current: '1', total: 1 },
        message: refusal.message,
      });
    },
  );

  it('tolerates a sink that omits the optional error handler', async () => {
    // `onErrorOccurred` is optional on the sink, so a consumer may legitimately
    // omit it. Dispatching an ERROR_OCCURRED event must not throw for them.
    const sessionService = {
      releaseRunbook: jest.fn(async () => committed(null)),
    } as unknown as SessionService;
    const sink = {
      onStepTransitioned: jest.fn(),
      onRunbookCompleted: jest.fn(),
      onRunbookStopped: jest.fn(),
    };

    await expect(
      orchestrateTransition({
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
      }),
    ).resolves.toEqual(expect.objectContaining({ status: 'stopped' }));
  });

  it('does not apply the completion policy to a transition that did not complete', async () => {
    // The release is gated on the observation reaching `done`. A stopped
    // transition must not run the onComplete side effect even when that policy
    // would release — otherwise hoisting the release ahead of the event
    // dispatch would start releasing runs that merely stopped.
    const releaseRunbook = jest.fn(async () => committed(null));
    const sessionService = { releaseRunbook } as unknown as SessionService;
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
        context: { lastAction: { type: 'STOP', origin: 'direct' } },
      },
      result: 'fail',
      policy: {
        onComplete: { releaseRunbook: true },
        onStopped: { releaseRunbook: false },
      },
    });

    expect(result).toEqual(expect.objectContaining({ status: 'stopped' }));
    expect(releaseRunbook).not.toHaveBeenCalled();
  });

  it('reports done and no refusal event when the terminal release commits', async () => {
    const releaseRunbook = jest.fn(async () => committed(null));
    const sessionService = { releaseRunbook } as unknown as SessionService;
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
      updatedState: { ...baseState, lifecycle: 'completed' },
      snapshot: {
        status: 'done',
        value: 'COMPLETE',
        context: { lastAction: { type: 'COMPLETE', origin: 'direct' } },
      },
      result: 'pass',
      policy: {
        onComplete: { releaseRunbook: true },
        onStopped: { releaseRunbook: true },
      },
    });

    expect(releaseRunbook).toHaveBeenCalledTimes(1);
    expect(sink.onErrorOccurred).not.toHaveBeenCalled();
    // The committed half of the downgrade: completion still reaches the stream
    // untouched, and no stop is fabricated alongside it.
    expect(sink.onRunbookCompleted).toHaveBeenCalledTimes(1);
    expect(sink.onRunbookStopped).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ status: 'done' }));
  });
});
