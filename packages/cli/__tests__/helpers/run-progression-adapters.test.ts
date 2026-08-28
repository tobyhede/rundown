import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { InlineChildDispatchResult } from '@rundown-org/core';
import type { DrivenRunPropagation } from '../../src/helpers/delegation-completion.js';
import type { OutputEmitter } from '../../src/services/output-emitter.js';

// The adapters fold CLI propagation machinery into the core Run Progression
// callable contracts. These pins hold the two #853-review properties the folds
// must keep: a typed refusal's identity (code + boundary-derived recovery)
// survives the fold instead of being re-labeled permanent (F3), and a broken
// reporting channel beneath either callable surfaces as core's typed
// ObservationDeliveryError rather than an untyped escape (F1).

const propagateDrivenRunTerminal =
  jest.fn<(...args: readonly unknown[]) => Promise<DrivenRunPropagation>>();
const launchInlineChildFromIntent =
  jest.fn<(args: Record<string, unknown>) => Promise<InlineChildDispatchResult>>();

jest.unstable_mockModule('../../src/helpers/delegation-completion.js', () => ({
  propagateDrivenRunTerminal,
}));
jest.unstable_mockModule('../../src/services/execution.js', () => ({
  launchInlineChildFromIntent,
}));

const { buildTerminalPropagation, buildInlineChildDispatch } = await import(
  '../../src/helpers/run-progression-adapters.js'
);
const { ObservationDeliveryError } = await import('@rundown-org/core');

const RUN_ID = 'rd_00000000000000000000000000000853' as never;

function makeOutput(overrides: Partial<Record<string, unknown>> = {}): OutputEmitter {
  return {
    warning: jest.fn(),
    error: jest.fn(),
    flush: jest.fn(),
    executionEvent: jest.fn(),
    ...overrides,
  } as unknown as OutputEmitter;
}

function propagationCtx(output: OutputEmitter) {
  return {
    manager: {} as never,
    cwd: '/test',
    output,
  };
}

beforeEach(() => {
  propagateDrivenRunTerminal.mockReset();
  launchInlineChildFromIntent.mockReset();
});

describe('buildTerminalPropagation', () => {
  it('keeps a typed refusal code and boundary recovery through the fold (#853 F3)', async () => {
    // A consume_failed (RD-829) advance refusal is retryable wherever it
    // surfaces; the fold must not strip the code or re-stamp permanent.
    propagateDrivenRunTerminal.mockResolvedValue({
      kind: 'inline-advanced',
      result: 'blocked',
      refusal: {
        code: 'RD-829',
        message: 'Failed to consume delegation frontier after re-entry; retry the run',
        recovery: 'retryable',
      },
    });
    const propagate = buildTerminalPropagation(propagationCtx(makeOutput()));

    const result = await propagate({ runId: RUN_ID, sink: { emit: jest.fn() } });

    expect(result).toEqual({
      kind: 'refused',
      code: 'RD-829',
      message: 'Failed to consume delegation frontier after re-entry; retry the run',
      recovery: 'retryable',
    });
  });

  it('reports a fail-closed conclusion with no typed refusal as permanent', async () => {
    // A parent advance reaching a STOP terminal (or a re-entrant fail-closed
    // flow-back) carries no refusal to preserve: diagnostics streamed, no
    // retry of the propagation changes it.
    propagateDrivenRunTerminal.mockResolvedValue({
      kind: 'inline-advanced',
      result: 'stopped',
    });
    const propagate = buildTerminalPropagation(propagationCtx(makeOutput()));

    const result = await propagate({ runId: RUN_ID, sink: { emit: jest.fn() } });

    expect(result).toMatchObject({ kind: 'refused', recovery: 'permanent' });
  });

  it('reports non-refusing propagation kinds as propagated', async () => {
    for (const propagation of [
      { kind: 'skipped' },
      { kind: 'inline-advanced', result: 'handled' },
      { kind: 'delegation-reported', result: 'reported' },
    ] satisfies DrivenRunPropagation[]) {
      propagateDrivenRunTerminal.mockResolvedValue(propagation);
      const propagate = buildTerminalPropagation(propagationCtx(makeOutput()));
      await expect(propagate({ runId: RUN_ID, sink: { emit: jest.fn() } })).resolves.toEqual({
        kind: 'propagated',
      });
    }
  });

  it('surfaces a broken reporting channel as the typed ObservationDeliveryError (#853 F1)', async () => {
    // The walk renders through the OutputEmitter; the adapter gates it so a
    // renderer throw becomes core's typed delivery failure, which the
    // activation boundary folds into the closed `failed` outcome.
    const output = makeOutput({
      warning: jest.fn(() => {
        throw new Error('broken pipe');
      }),
    });
    propagateDrivenRunTerminal.mockImplementation(async (...args) => {
      const gatedOutput = args[3] as OutputEmitter;
      gatedOutput.warning('rendering mid-walk');
      return { kind: 'skipped' };
    });
    const propagate = buildTerminalPropagation(propagationCtx(output));

    await expect(propagate({ runId: RUN_ID, sink: { emit: jest.fn() } })).rejects.toBeInstanceOf(
      ObservationDeliveryError,
    );
  });
});

describe('buildInlineChildDispatch', () => {
  function dispatchCtx(output: OutputEmitter) {
    return {
      manager: {} as never,
      actorService: {} as never,
      sessionService: {} as never,
      cwd: '/test',
      steps: [],
      output,
    };
  }
  const intent = { childRunId: 'rd_child' } as never;

  it('hands the launch span the gated sink core supplied, not a captured emitter (#853 F1)', async () => {
    launchInlineChildFromIntent.mockResolvedValue({ kind: 'waiting' });
    const sink = { emit: jest.fn() };
    const dispatch = buildInlineChildDispatch(dispatchCtx(makeOutput()));

    await dispatch({ intent, prompted: false, sink });

    expect(launchInlineChildFromIntent).toHaveBeenCalledWith(
      expect.objectContaining({ emitter: sink }),
    );
  });

  it('gates the output channel handed into the launch span', async () => {
    const output = makeOutput({
      warning: jest.fn(() => {
        throw new Error('broken pipe');
      }),
    });
    launchInlineChildFromIntent.mockImplementation(async (args) => {
      (args.output as OutputEmitter).warning('child stream mid-launch');
      return { kind: 'waiting' };
    });
    const dispatch = buildInlineChildDispatch(dispatchCtx(output));

    await expect(
      dispatch({ intent, prompted: false, sink: { emit: jest.fn() } }),
    ).rejects.toBeInstanceOf(ObservationDeliveryError);
  });
});
