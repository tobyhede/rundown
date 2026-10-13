import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { mockFn } from './typed-mocks.js';
import type {
  ActionType,
  LifecycleTransitionOutcome,
  OwnedRunResolution,
  OwnerToken,
  RunId,
  RunProgressionAuthority,
  RunProgressionDirective,
  RunProgressionOutcome,
  RunbookState,
  RunbookStateManager,
  TransitionObservationEvent,
} from '@rundown-org/core';
import type { OutputEmitter } from '../../src/services/output-emitter.js';

// The unit-under-test (runSeamTransition, renderRefusal, renderApplied,
// buildActionSink, renderTransitionEvents, the config helpers) is only
// reachable from the CLI command layer through a *dynamic* `import('../cli.js')`
// in the in-process CLI runner. Because Stryker scopes each mutant to its
// *static* importers, the pass/fail integration suites never count toward this
// module's mutation score. This suite statically imports transitions.ts and
// drives the seam through structural core doubles so those branches — the
// token resolution hand-off, the result→action mapping and the typed-refusal
// render table — are pinned directly.

const RUN_ID = 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as RunId;
const TOKEN = 'rdo_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as OwnerToken;

const mockRunTransition = mockFn<(args: unknown) => Promise<LifecycleTransitionOutcome>>();
const mockManagerLoad = mockFn<(id: RunId) => Promise<RunbookState | null>>();
const mockManager = { load: mockManagerLoad } as unknown as RunbookStateManager;

// Core is spread back so the token-option renderers keep their real codes and
// messages; only the two collaborators this module drives are substituted.
const actualCore = await import('@rundown-org/core');
const mockResolveOwnedRun =
  mockFn<(manager: RunbookStateManager, token: OwnerToken) => Promise<OwnedRunResolution>>();
jest.unstable_mockModule('@rundown-org/core', () => ({
  ...actualCore,
  resolveOwnedRun: mockResolveOwnedRun,
  // `formatTransitionAction` is echoed into the buffered action object; the mock
  // returns a sentinel so we can assert the sink forwards the derived label.
  formatTransitionAction: mockFn<(action: ActionType) => string>().mockReturnValue('ACTION_LABEL'),
}));

jest.unstable_mockModule('../../src/helpers/lifecycle-seam-factory', () => ({
  buildLifecycleSeam: mockFn<() => unknown>().mockImplementation(() => ({
    manager: mockManager,
    seam: { runTransition: mockRunTransition },
  })),
}));

// Structural double for the shared Run Progression driver (#854): the suite
// pins that transitions.ts hands the directive through verbatim and maps the
// closed outcome, not the driver's own wiring (covered by its own suite).
// `progressionFailedClosed` mirrors the real predicate — a pure three-arm
// check — so the mapping under test reads the same signal.
const mockDriveRunProgression =
  mockFn<
    (
      activation: Extract<RunProgressionDirective, { kind: 'activate' }>,
      ctx: unknown,
    ) => Promise<RunProgressionOutcome>
  >();
jest.unstable_mockModule('../../src/helpers/run-progression-adapters', () => ({
  driveRunProgression: mockDriveRunProgression,
  progressionFailedClosed: (outcome: RunProgressionOutcome) =>
    outcome.kind === 'refused' || outcome.kind === 'failed' || outcome.kind === 'stopped',
}));

const mockEmitter = { emit: jest.fn() };
jest.unstable_mockModule('../../src/helpers/execution-emitter', () => ({
  createBridgedEmitter: mockFn<() => Record<string, unknown>>().mockReturnValue(mockEmitter),
}));

// A structural sink whose methods are jest fns so renderTransitionEvents can
// dispatch through the substep (emitter-bridged) path without throwing.
const mockSubstepSink = {
  onErrorOccurred: mockFn<(payload: unknown) => void>(),
  onStepTransitioned: mockFn<(payload: unknown) => void>(),
  onRunbookCompleted: mockFn<(payload: unknown) => void>(),
  onRunbookStopped: mockFn<(payload: unknown) => void>(),
};
jest.unstable_mockModule('../../src/helpers/transition-orchestrator', () => ({
  transitionSinkFromEmitter:
    mockFn<() => typeof mockSubstepSink>().mockReturnValue(mockSubstepSink),
}));

const { createBridgedEmitter } = await import('../../src/helpers/execution-emitter.js');
const { runSeamTransition, createPassTransitionConfig, createFailTransitionConfig, renderRefusal } =
  await import('../../src/helpers/transitions.js');

interface MockOutput {
  error: jest.Mock<(message: string, code?: string, details?: unknown) => void>;
  noActiveRunbook: jest.Mock<(command?: string) => void>;
  json: jest.Mock<(data: unknown) => void>;
  message: jest.Mock<(text: string) => void>;
  action: jest.Mock<(block: unknown) => void>;
  complete: jest.Mock<(message?: string, position?: unknown) => void>;
  stopped: jest.Mock<(message?: string, position?: unknown) => void>;
  status: jest.Mock<(action: string, message?: string, data?: unknown) => void>;
  warning: jest.Mock<(text: string) => void>;
  isJson: jest.Mock<() => boolean>;
  flush: jest.Mock<() => void>;
}

function makeOutput(json = true): MockOutput & OutputEmitter {
  return {
    error: mockFn<(message: string, code?: string, details?: unknown) => void>(),
    noActiveRunbook: mockFn<(command?: string) => void>(),
    json: mockFn<(data: unknown) => void>(),
    message: mockFn<(text: string) => void>(),
    action: mockFn<(block: unknown) => void>(),
    complete: mockFn<(message?: string, position?: unknown) => void>(),
    stopped: mockFn<(message?: string, position?: unknown) => void>(),
    status: mockFn<(action: string, message?: string, data?: unknown) => void>(),
    warning: mockFn<(text: string) => void>(),
    isJson: mockFn<() => boolean>().mockReturnValue(json),
    flush: mockFn<() => void>(),
  } as unknown as MockOutput & OutputEmitter;
}

function makeState(overrides: Record<string, unknown> = {}): RunbookState {
  return {
    id: RUN_ID,
    step: '1',
    substep: undefined,
    lifecycle: 'running',
    activeEntry: 1,
    activeFrameKey: '1',
    ...overrides,
  } as unknown as RunbookState;
}

function running(state: RunbookState = makeState()): OwnedRunResolution {
  return { kind: 'running', run: { state, stateVersion: 3 as never } };
}

function stepEvent(
  overrides: Partial<Record<string, unknown>> = {},
): Extract<TransitionObservationEvent, { type: 'STEP_TRANSITIONED' }> {
  return {
    type: 'STEP_TRANSITIONED',
    payload: {
      action: 'CONTINUE',
      from: '1',
      at: '2',
      result: 'PASS',
      ...overrides,
    },
  } as unknown as Extract<TransitionObservationEvent, { type: 'STEP_TRANSITIONED' }>;
}

// Structural double for the branded, core-minted authority; only the value's
// identity matters (the suite pins verbatim pass-through).
const TEST_AUTHORITY = { runId: RUN_ID } as unknown as RunProgressionAuthority;
const TEST_ACTIVATION = {
  kind: 'activate',
  authority: TEST_AUTHORITY,
  runbook: { source: 'project', path: 'test.runbook.md' },
  steps: [],
  entryBoundary: { kind: 'after_observed_transition', lifecycle: 'running' },
} as const satisfies Extract<RunProgressionDirective, { kind: 'activate' }>;

function appliedOutcome(
  overrides: Partial<Extract<LifecycleTransitionOutcome, { kind: 'applied' }>> = {},
): LifecycleTransitionOutcome {
  return {
    kind: 'applied',
    runId: RUN_ID,
    status: 'continue',
    events: [],
    progression: TEST_ACTIVATION,
    ...overrides,
  } as unknown as LifecycleTransitionOutcome;
}

function seamInput(): Record<string, unknown> {
  return (mockRunTransition.mock.calls as unknown as [[Record<string, unknown>]])[0][0];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveOwnedRun.mockResolvedValue(running());
  mockManagerLoad.mockResolvedValue(makeState());
  mockDriveRunProgression.mockResolvedValue({ kind: 'completed', runId: RUN_ID });
});

describe('createPassTransitionConfig', () => {
  it('maps RETRY and STOP results to a false action-result but CONTINUE/NEXT to true', () => {
    const config = createPassTransitionConfig();
    expect(config.eventType).toBe('PASS');
    expect(config.commandName).toBe('pass');
    expect(config.lastResult).toBe('pass');
    expect(config.computeActionResult('RETRY')).toBe(false);
    expect(config.computeActionResult('STOP')).toBe(false);
    expect(config.computeActionResult('CONTINUE')).toBe(true);
    expect(config.computeActionResult('NEXT')).toBe(true);
  });
});

describe('createFailTransitionConfig', () => {
  it('always maps the action-result to false regardless of action type', () => {
    const config = createFailTransitionConfig();
    expect(config.eventType).toBe('FAIL');
    expect(config.commandName).toBe('fail');
    expect(config.lastResult).toBe('fail');
    for (const action of ['CONTINUE', 'NEXT', 'RETRY', 'STOP', 'COMPLETE'] as ActionType[]) {
      expect(config.computeActionResult(action)).toBe(false);
    }
  });
});

describe('runSeamTransition — token resolution', () => {
  it('resolves the token through core against the seam manager and hands the owned run through', async () => {
    const state = makeState();
    mockResolveOwnedRun.mockResolvedValue(running(state));
    mockRunTransition.mockResolvedValue(appliedOutcome({ updatedState: makeState({ step: '2' }) }));
    const output = makeOutput();

    const result = await runSeamTransition(output, '/cwd', createPassTransitionConfig(), {
      token: TOKEN,
      step: '1',
    });

    expect(mockResolveOwnedRun).toHaveBeenCalledWith(mockManager, TOKEN);
    expect(seamInput().command).toBe('pass');
    expect(seamInput().run).toEqual({ state, stateVersion: 3 });
    expect(result.applied?.runId).toBe(RUN_ID);
    expect(result.exitError).toBe(false);
  });

  it('renders UNKNOWN_TOKEN and never calls the seam when no run carries the token', async () => {
    mockResolveOwnedRun.mockResolvedValue({ kind: 'unknown_token' });
    const output = makeOutput();

    const result = await runSeamTransition(output, '/cwd', createPassTransitionConfig(), {
      token: TOKEN,
      step: '1',
    });

    expect(mockRunTransition).not.toHaveBeenCalled();
    expect(result).toEqual({ exitError: true });
    expect(output.error.mock.calls[0][1]).toBe('UNKNOWN_TOKEN');
    expect(output.error.mock.calls[0][0]).not.toContain(TOKEN);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.flush).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['completed', 'RD-303'],
    ['stopped', 'RD-304'],
    ['abandoned', 'RD-304'],
  ] as const)('renders a finished (%s) run as %s naming the command', async (lifecycle, code) => {
    mockResolveOwnedRun.mockResolvedValue({ kind: 'finished', state: makeState(), lifecycle });
    const output = makeOutput();

    const result = await runSeamTransition(output, '/cwd', createFailTransitionConfig(), {
      token: TOKEN,
      step: '1',
    });

    expect(mockRunTransition).not.toHaveBeenCalled();
    expect(result.exitError).toBe(true);
    const [message, renderedCode, details] = output.error.mock.calls[0];
    expect(renderedCode).toBe(code);
    expect(message).toContain('rundown fail');
    expect(details).toEqual({ runId: RUN_ID, lifecycle });
  });
});

describe('runSeamTransition — explicit --step target', () => {
  it('forwards the raw --step as the target without resolving it CLI-side', async () => {
    mockRunTransition.mockResolvedValue(appliedOutcome());

    await runSeamTransition(makeOutput(), '/cwd', createPassTransitionConfig(), {
      token: TOKEN,
      step: '2.1',
    });

    expect(seamInput().target).toEqual({ stepId: '2.1' });
  });

  it('carries the pre-parsed --index iteration on the forwarded target', async () => {
    mockRunTransition.mockResolvedValue(appliedOutcome());

    await runSeamTransition(makeOutput(), '/cwd', createPassTransitionConfig(), {
      token: TOKEN,
      step: '1.2',
      index: '3',
    });

    expect(seamInput().target).toEqual({ stepId: '1.2', iteration: 3 });
  });

  it('forwards an undefined target when --step is absent, so core composes the refusal', async () => {
    mockRunTransition.mockResolvedValue({
      kind: 'invalid_step_target',
      message: '--step is required; the current position is 1',
    });
    const output = makeOutput();

    const result = await runSeamTransition(output, '/cwd', createPassTransitionConfig(), {
      token: TOKEN,
    });

    expect(seamInput()).toHaveProperty('target', undefined);
    expect(result).toEqual({ exitError: true });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.error).toHaveBeenCalledWith(
      '--step is required; the current position is 1',
      'INVALID_STEP',
    );
  });

  it('refuses a malformed --index before reaching the seam', async () => {
    await expect(
      runSeamTransition(makeOutput(), '/cwd', createPassTransitionConfig(), {
        token: TOKEN,
        step: '1',
        index: 'zero',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SYNTAX' });
    expect(mockRunTransition).not.toHaveBeenCalled();
  });

  it('passes the config display policy into the seam', async () => {
    mockRunTransition.mockResolvedValue(appliedOutcome());

    await runSeamTransition(makeOutput(), '/cwd', createFailTransitionConfig(), {
      token: TOKEN,
      step: '1',
    });

    const compute = seamInput().computeActionResult as (a: ActionType) => boolean;
    expect(compute('CONTINUE')).toBe(false);
  });
});

describe('renderRefusal', () => {
  const config = createPassTransitionConfig();

  it('renders invalid_step_target as INVALID_STEP with the core message, exit non-zero', () => {
    const output = makeOutput();
    const exitError = renderRefusal(output, config, {
      kind: 'invalid_step_target',
      message: '--step 2 targets step "2" but the active step is "1"',
    });
    expect(exitError).toBe(true);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.error).toHaveBeenCalledWith(
      '--step 2 targets step "2" but the active step is "1"',
      'INVALID_STEP',
    );
  });

  it('renders run_finished as RD-303 / RD-304 naming the lifecycle', () => {
    const output = makeOutput();
    expect(
      renderRefusal(output, config, {
        kind: 'run_finished',
        runId: RUN_ID,
        lifecycle: 'completed',
      }),
    ).toBe(true);
    expect(
      renderRefusal(output, config, { kind: 'run_finished', runId: RUN_ID, lifecycle: 'stopped' }),
    ).toBe(true);
    expect(output.error.mock.calls.map((call) => call[1])).toEqual(['RD-303', 'RD-304']);
    expect(output.error.mock.calls[0][2]).toEqual({ runId: RUN_ID, lifecycle: 'completed' });
  });

  it('renders concurrent_modification as CONCURRENT_MODIFICATION with the run id', () => {
    const output = makeOutput();
    const exitError = renderRefusal(output, config, {
      kind: 'concurrent_modification',
      runId: RUN_ID,
      message: 'row moved',
    });
    expect(exitError).toBe(true);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.error).toHaveBeenCalledWith('row moved', 'CONCURRENT_MODIFICATION', {
      runId: RUN_ID,
    });
  });

  it('is what runSeamTransition renders for a refused seam outcome, then flushes', async () => {
    mockRunTransition.mockResolvedValue({
      kind: 'concurrent_modification',
      runId: RUN_ID,
      message: 'row moved',
    });
    const output = makeOutput();

    const result = await runSeamTransition(output, '/cwd', config, { token: TOKEN, step: '1' });

    expect(result).toEqual({ exitError: true });
    expect(output.error.mock.calls[0][1]).toBe('CONCURRENT_MODIFICATION');
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.flush).toHaveBeenCalledTimes(1);
    expect(mockDriveRunProgression).not.toHaveBeenCalled();
  });
});

describe('runSeamTransition — applied render (buildActionSink / renderTransitionEvents)', () => {
  it('renders a top-level STEP_TRANSITIONED event as a buffered action block', async () => {
    mockRunTransition.mockResolvedValue(
      appliedOutcome({
        events: [
          stepEvent({
            forIndex: 2,
            forEnd: 5,
            command: 'echo hi',
            retryAttempt: 1,
            retryMax: 3,
          }),
        ],
      }),
    );
    const output = makeOutput();

    await runSeamTransition(output, '/cwd', createPassTransitionConfig(), {
      token: TOKEN,
      step: '1',
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.action).toHaveBeenCalledWith({
      action: 'ACTION_LABEL',
      from: '1',
      at: '2',
      result: 'PASS',
      forIndex: 2,
      forEnd: 5,
      command: 'echo hi',
    });
    expect(mockSubstepSink.onStepTransitioned).not.toHaveBeenCalled();
  });

  it('omits forIndex/forEnd/command from the action block when absent', async () => {
    mockRunTransition.mockResolvedValue(appliedOutcome({ events: [stepEvent()] }));
    const output = makeOutput();

    await runSeamTransition(output, '/cwd', createPassTransitionConfig(), {
      token: TOKEN,
      step: '1',
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.action).toHaveBeenCalledWith({
      action: 'ACTION_LABEL',
      from: '1',
      at: '2',
      result: 'PASS',
    });
  });

  it('renders RUNBOOK_COMPLETED via output.complete', async () => {
    mockRunTransition.mockResolvedValue(
      appliedOutcome({
        status: 'done',
        events: [
          {
            type: 'RUNBOOK_COMPLETED',
            payload: { message: 'all done', finalPosition: { current: '2', total: 2 } },
          } as unknown as TransitionObservationEvent,
        ],
      }),
    );
    const output = makeOutput();

    const result = await runSeamTransition(output, '/cwd', createPassTransitionConfig(), {
      token: TOKEN,
      step: '2',
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.complete).toHaveBeenCalledWith('all done', { current: '2', total: 2 });
    expect(result.applied?.status).toBe('done');
  });

  it('renders RUNBOOK_STOPPED via output.stopped and fails closed on the stopped progression', async () => {
    mockRunTransition.mockResolvedValue(
      appliedOutcome({
        status: 'stopped',
        events: [
          {
            type: 'RUNBOOK_STOPPED',
            payload: { message: 'halt', position: { current: '1', total: 2 } },
          } as unknown as TransitionObservationEvent,
        ],
      }),
    );
    mockDriveRunProgression.mockResolvedValue({ kind: 'stopped', runId: RUN_ID });
    const output = makeOutput();

    const result = await runSeamTransition(output, '/cwd', createFailTransitionConfig(), {
      token: TOKEN,
      step: '1',
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.stopped).toHaveBeenCalledWith('halt', { current: '1', total: 2 });
    expect(result.applied?.status).toBe('stopped');
    expect(result.exitError).toBe(true);
  });

  it('renders ERROR_OCCURRED via output.error', async () => {
    mockRunTransition.mockResolvedValue(
      appliedOutcome({
        events: [
          {
            type: 'ERROR_OCCURRED',
            payload: { message: 'boom', code: 'RD-501' },
          } as unknown as TransitionObservationEvent,
        ],
      }),
    );
    const output = makeOutput();

    await runSeamTransition(output, '/cwd', createPassTransitionConfig(), {
      token: TOKEN,
      step: '1',
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.error).toHaveBeenCalledWith('boom', 'RD-501');
  });

  it('routes a substep transition through the emitter-bridged sink, not the action sink', async () => {
    mockResolveOwnedRun.mockResolvedValue(running(makeState({ substep: '1' })));
    mockRunTransition.mockResolvedValue(appliedOutcome({ events: [stepEvent()] }));
    const output = makeOutput();

    await runSeamTransition(output, '/cwd', createPassTransitionConfig(), {
      token: TOKEN,
      step: '1.1',
    });

    expect(mockSubstepSink.onStepTransitioned).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.action).not.toHaveBeenCalled();
    // The same bridged emitter then carries progression observations.
    expect(createBridgedEmitter).toHaveBeenCalledTimes(1);
    expect((mockDriveRunProgression.mock.calls[0][1] as { sink: unknown }).sink).toBe(mockEmitter);
  });

  it('activates Run Progression with the seam directive verbatim and the stream options', async () => {
    mockRunTransition.mockResolvedValue(appliedOutcome());
    const output = makeOutput();
    const commandStreamOptions = { commandOutput: 'stderr' as const };

    const result = await runSeamTransition(output, '/cwd', createPassTransitionConfig(), {
      token: TOKEN,
      step: '1',
      commandStreamOptions,
    });

    expect(mockDriveRunProgression).toHaveBeenCalledTimes(1);
    const [directive, ctx] = mockDriveRunProgression.mock.calls[0];
    expect(directive).toBe(TEST_ACTIVATION);
    expect(ctx).toMatchObject({ manager: mockManager, cwd: '/cwd', output, commandStreamOptions });
    expect(result.applied?.progression).toEqual({ kind: 'completed', runId: RUN_ID });
    expect(result.exitError).toBe(false);
  });

  it('does not fail closed on a waiting progression outcome', async () => {
    mockRunTransition.mockResolvedValue(appliedOutcome());
    mockDriveRunProgression.mockResolvedValue({
      kind: 'waiting',
      runId: RUN_ID,
      reason: 'awaiting_input',
    });

    const result = await runSeamTransition(makeOutput(), '/cwd', createPassTransitionConfig(), {
      token: TOKEN,
      step: '1',
    });

    expect(result.exitError).toBe(false);
    expect(result.applied?.progression?.kind).toBe('waiting');
  });

  it('fails closed on a refused progression without inventing a stopped status', async () => {
    mockRunTransition.mockResolvedValue(appliedOutcome());
    mockDriveRunProgression.mockResolvedValue({
      kind: 'refused',
      runId: RUN_ID,
      reason: 'command_not_committed',
      message: 'row moved',
      recovery: 'retryable',
    });

    const result = await runSeamTransition(makeOutput(), '/cwd', createPassTransitionConfig(), {
      token: TOKEN,
      step: '1',
    });

    expect(result.exitError).toBe(true);
    expect(result.applied?.status).toBe('continue');
  });

  it('still activates the directive when the post-transition reload finds no run', async () => {
    mockRunTransition.mockResolvedValue(appliedOutcome());
    mockManagerLoad.mockResolvedValue(null);
    const output = makeOutput();

    const result = await runSeamTransition(output, '/cwd', createPassTransitionConfig(), {
      token: TOKEN,
      step: '1',
    });

    expect(mockDriveRunProgression).toHaveBeenCalledTimes(1);
    expect(mockDriveRunProgression.mock.calls[0][1]).not.toHaveProperty('sink');
    expect(result.exitError).toBe(false);
  });

  it('reuses updatedState instead of reloading when the seam supplies it', async () => {
    mockRunTransition.mockResolvedValue(appliedOutcome({ updatedState: makeState({ step: '2' }) }));

    await runSeamTransition(makeOutput(), '/cwd', createPassTransitionConfig(), {
      token: TOKEN,
      step: '1',
    });

    expect(mockManagerLoad).not.toHaveBeenCalled();
    expect(createBridgedEmitter).toHaveBeenCalledWith(
      expect.objectContaining({ step: '2' }),
      expect.anything(),
    );
  });
});
