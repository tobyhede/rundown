import { describe, expect, it } from '@jest/globals';
import type { ResolvedStep, RunbookState } from '../../src/runbook/types.js';
import {
  deriveGotoActionBlock,
  deriveTransitionObservation,
} from '../../src/events/transition-observation.js';

const steps = [
  {
    kind: 'command',
    name: '1',
    description: 'Build',
    command: { code: 'npm test', lang: 'bash' },
    transitions: {
      pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
      fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
    },
  },
  {
    kind: 'command',
    name: '2',
    description: 'Deploy',
    command: { code: 'npm run deploy', lang: 'bash' },
    transitions: {
      pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
      fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
    },
  },
] as unknown as ResolvedStep[];

const currentStep = steps[0];

function state(overrides: Partial<RunbookState> = {}): RunbookState {
  return {
    id: `rd_${'1'.repeat(32)}`,
    runbook: { source: 'project', path: 'test.runbook.md' },
    runbookPath: 'test.runbook.md',
    step: '1',
    stepName: 'Build',
    retryCount: 0,
    variables: {},
    steps: [],
    startedAt: '2026-05-12T00:00:00.000Z',
    updatedAt: '2026-05-12T00:00:00.000Z',
    lifecycle: 'running',
    ...overrides,
  } as RunbookState;
}

describe('deriveTransitionObservation', () => {
  it('derives a STEP_TRANSITIONED payload for non-terminal transitions', () => {
    const previousState = state({ step: '1' });
    const updatedState = state({ step: '2', stepName: 'Deploy' });

    const observation = deriveTransitionObservation({
      steps,
      currentStep,
      previousState,
      updatedState,
      snapshot: {
        value: { 'step::2': 'idle' },
        context: { lastAction: { type: 'CONTINUE', origin: 'direct' } },
      },
      result: 'pass',
      command: 'npm test',
    });

    expect(observation).toMatchObject({
      status: 'continue',
      action: 'CONTINUE',
      from: '1',
      at: '2',
      state: updatedState,
    });
    expect(observation.events).toEqual([
      {
        type: 'STEP_TRANSITIONED',
        payload: {
          action: 'CONTINUE',
          from: '1',
          at: '2',
          result: 'PASS',
          command: 'npm test',
        },
      },
    ]);
  });

  it('derives RETRY metadata using the snapshot retry counters', () => {
    const previousState = state({ step: '1', retryCount: 0 });
    const updatedState = state({ step: '1', retryCount: 1 });

    const observation = deriveTransitionObservation({
      steps,
      currentStep,
      previousState,
      updatedState,
      snapshot: {
        value: { 'step::1': 'idle' },
        context: {
          lastAction: { type: 'RETRY', origin: 'direct' },
          retryMax: 3,
          iterationRetryCount: 1,
        },
      },
      result: 'fail',
    });

    expect(observation.events).toEqual([
      {
        type: 'STEP_TRANSITIONED',
        payload: {
          action: 'RETRY',
          from: '1',
          at: '1',
          result: 'FAIL',
          retryAttempt: 1,
          retryMax: 3,
        },
      },
    ]);
  });

  it('includes FOR loop position metadata on transition payloads', () => {
    const previousState = state({
      step: '1',
      forStack: [
        {
          stepId: '1',
          iteration: 1,
          start: 1,
          end: 4,
          variable: 'item',
          source: { kind: 'range' },
          implicit: false,
        },
      ],
    });
    const updatedState = state({
      step: '1',
      forStack: [
        {
          stepId: '1',
          iteration: 2,
          start: 1,
          end: 4,
          variable: 'item',
          source: { kind: 'range' },
          implicit: false,
        },
      ],
    });

    const observation = deriveTransitionObservation({
      steps,
      currentStep,
      previousState,
      updatedState,
      snapshot: {
        value: { 'step::1': 'idle' },
        context: { lastAction: { type: 'NEXT', origin: 'direct' } },
      },
      result: 'pass',
    });

    expect(observation.events[0]).toEqual({
      type: 'STEP_TRANSITIONED',
      payload: {
        action: 'NEXT',
        from: '1.1',
        at: '1.2',
        result: 'PASS',
        forIndex: 2,
        forEnd: 4,
      },
    });
  });

  it('emits STEP_TRANSITIONED then RUNBOOK_COMPLETED for terminal completion', () => {
    const previousState = state({ step: '2', retryCount: 0 });
    const updatedState = state({ step: '2', lifecycle: 'completed' });

    const observation = deriveTransitionObservation({
      steps,
      currentStep: steps[1],
      previousState,
      updatedState,
      snapshot: {
        status: 'done',
        value: 'COMPLETE',
        context: {
          lifecycle: 'completed',
          lastAction: { type: 'COMPLETE', origin: 'direct' },
          lastMessage: 'Ship it',
        },
      },
      result: 'pass',
    });

    expect(observation.status).toBe('done');
    if (observation.status !== 'done') {
      throw new Error(`Expected done observation, got ${observation.status}`);
    }
    expect(observation.message).toBe('Ship it');
    expect(observation.events).toEqual([
      {
        type: 'STEP_TRANSITIONED',
        payload: {
          action: 'COMPLETE',
          from: '2',
          at: '2',
          result: 'PASS',
        },
      },
      {
        type: 'RUNBOOK_COMPLETED',
        payload: {
          message: 'Ship it',
          finalPosition: { current: '2', total: 2 },
        },
      },
    ]);
  });

  it('suppresses STEP_TRANSITIONED and emits ERROR_OCCURRED before RUNBOOK_STOPPED for internal failures', () => {
    const previousState = state({ step: '1', retryCount: 0 });
    const updatedState = state({ step: '1', lifecycle: 'stopped' });

    const observation = deriveTransitionObservation({
      steps,
      currentStep,
      previousState,
      updatedState,
      snapshot: {
        status: 'done',
        value: 'STOPPED',
        context: {
          lifecycle: 'stopped',
          lastAction: {
            type: 'OUTPUT_CAPTURE_FAILED',
            origin: 'direct',
            message: 'failed to capture Foo',
          },
        },
      },
      result: 'fail',
    });

    expect(observation).toMatchObject({
      status: 'stopped',
      action: 'OUTPUT_CAPTURE_FAILED',
      from: '1',
      at: '1',
      message: 'failed to capture Foo',
    });
    expect(observation.events).toEqual([
      {
        type: 'ERROR_OCCURRED',
        payload: {
          message: 'failed to capture Foo',
        },
      },
      {
        type: 'RUNBOOK_STOPPED',
        payload: {
          message: 'failed to capture Foo',
          position: { current: '1', total: 2 },
          reason: 'output_capture_failed',
        },
      },
    ]);
  });

  it('uses computeActionResult for direct pass/fail display parity', () => {
    const previousState = state({ step: '1' });
    const updatedState = state({ step: '1', lifecycle: 'stopped' });

    const observation = deriveTransitionObservation({
      steps,
      currentStep,
      previousState,
      updatedState,
      snapshot: {
        status: 'done',
        value: 'STOPPED',
        context: {
          lifecycle: 'stopped',
          lastAction: { type: 'STOP', origin: 'direct' },
        },
      },
      result: 'pass',
      computeActionResult: (action) => action !== 'STOP',
    });

    expect(observation.events[0]).toEqual({
      type: 'STEP_TRANSITIONED',
      payload: {
        action: 'STOP',
        from: '1',
        at: '1',
        result: 'FAIL',
      },
    });
  });

  it('sets aggregated: true in STEP_TRANSITIONED payload when lastAction origin is aggregation', () => {
    const previousState = state({ step: '1' });
    const updatedState = state({ step: '2', stepName: 'Deploy' });

    const observation = deriveTransitionObservation({
      steps,
      currentStep,
      previousState,
      updatedState,
      snapshot: {
        value: { 'step::2': 'idle' },
        context: { lastAction: { type: 'COMPLETE', origin: 'aggregation' } },
      },
      result: 'pass',
    });

    expect(observation.events).toEqual([
      {
        type: 'STEP_TRANSITIONED',
        payload: {
          action: 'COMPLETE',
          from: '1',
          at: '2',
          result: 'PASS',
          aggregated: true,
        },
      },
    ]);
  });
});

describe('deriveGotoActionBlock', () => {
  it('derives the goto action display payload from previous and updated state', () => {
    expect(
      deriveGotoActionBlock({
        steps,
        previousState: state({ step: '1' }),
        updatedState: state({ step: '2' }),
        target: { step: '2' },
      }),
    ).toEqual({
      action: 'GOTO 2',
      from: '1',
      at: '2',
    });
  });
});
