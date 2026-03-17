import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { mockErrorHelpers } from './mock-error-helpers';

// Mock @rundown-org/core
jest.unstable_mockModule('@rundown-org/core', () => ({
  RunbookStateManager: jest.fn(),
  RunbookActorService: jest.fn(),
  SessionService: jest.fn(),
  ExecutionLifecycleService: jest.fn(),
  extractLastAction: jest.fn().mockReturnValue(undefined),
  formatTransitionAction: jest.fn().mockReturnValue('CONTINUE'),
  parseActionType: jest.fn().mockReturnValue('CONTINUE'),
  parseStepIdFromString: jest.fn(),
  buildCompletionKey: jest.fn(
    (frameKey: string, entry: number, substep?: string) =>
      `${frameKey}:${String(entry)}:${substep ?? ''}`,
  ),
  buildFrameKey: jest.fn((step: string, iteration?: number) =>
    iteration !== undefined ? `${step}[${String(iteration)}]` : step,
  ),
  buildResolvedCompletion: jest.fn().mockReturnValue({ result: 'pass' }),
  deriveExecutionAt: jest.fn(
    (step: string, substep?: string, iteration?: number) =>
      `${step}${iteration !== undefined ? `[${String(iteration)}]` : ''}${substep ? `.${substep}` : ''}`,
  ),
  deriveActiveFrame: jest.fn().mockReturnValue({ step: '1', iteration: undefined, frameKey: '1' }),
  ...mockErrorHelpers,
}));

// Mock @rundown-org/parser
jest.unstable_mockModule('@rundown-org/parser', () => ({
  resolvedStepHasSubsteps: jest.fn(),
}));

// Mock runbook-loader
jest.unstable_mockModule('../../src/helpers/runbook-loader', () => ({
  getRunbookFromState: jest.fn().mockReturnValue([]),
}));

// Mock execution service
jest.unstable_mockModule('../../src/services/execution', () => ({
  drainResolvedCompletions: jest.fn().mockResolvedValue({ status: 'done', applied: 0 }),
  findStepOrThrow: jest.fn(),
  runExecutionLoop: jest.fn().mockResolvedValue('done'),
}));

// Mock execution-emitter
jest.unstable_mockModule('../../src/helpers/execution-emitter', () => ({
  createBridgedEmitter: jest.fn().mockReturnValue({}),
}));

// Mock transition-orchestrator
jest.unstable_mockModule('../../src/helpers/transition-orchestrator', () => ({
  orchestrateTransition: jest.fn().mockResolvedValue({ status: 'done' }),
}));

const core = await import('@rundown-org/core');
const { resolvedStepHasSubsteps } = await import('@rundown-org/parser');
const { findStepOrThrow } = await import('../../src/services/execution');
const { executeTransition, createPassTransitionConfig } = await import(
  '../../src/helpers/transitions'
);

function makeCtx(stateOverrides: Record<string, unknown> = {}): any {
  const state = {
    id: 'run-1',
    step: '1',
    substep: '1',
    activeEntry: 1,
    activeFrameKey: '1',
    ...stateOverrides,
  };
  return {
    output: { action: jest.fn(), flush: jest.fn(), status: jest.fn(), warning: jest.fn() },
    manager: { update: jest.fn<any>().mockResolvedValue(undefined) },
    actorService: {
      updateFromActor: jest.fn<any>().mockResolvedValue({
        state: { ...state },
        snapshot: {},
      }),
    },
    sessionService: {},
    lifecycleService: {
      ensureActiveEntry: jest.fn<any>().mockResolvedValue({ state, entryId: 1 }),
      getResolvedCompletion: jest.fn<any>().mockResolvedValue(null),
      upsertResolvedCompletion: jest.fn<any>().mockResolvedValue(undefined),
    },
    state,
    steps: [
      {
        name: '1',
        kind: 'substeps',
        substeps: [{ id: '1' }, { id: '2' }],
      },
    ],
    actor: { send: jest.fn(), stop: jest.fn() },
    cwd: '/test',
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: step has substeps
  (findStepOrThrow as jest.Mock).mockReturnValue({
    name: '1',
    kind: 'substeps',
    substeps: [{ id: '1' }, { id: '2' }],
  });
  (resolvedStepHasSubsteps as jest.MockedFunction<typeof resolvedStepHasSubsteps>).mockReturnValue(
    true,
  );
  // Default: parseStepIdFromString returns valid parse
  (core.parseStepIdFromString as jest.Mock).mockReturnValue({ step: '1', substep: '1' });
  // Reset buildCompletionKey
  (core.buildCompletionKey as jest.Mock).mockImplementation(
    (frameKey: string, entry: number, substep?: string) =>
      `${frameKey}:${String(entry)}:${substep ?? ''}`,
  );
});

describe('executeTransition with ExplicitTarget', () => {
  it('throws when explicitTarget is provided but not in substep mode', async () => {
    const ctx = makeCtx({ substep: undefined }); // No active substep
    (findStepOrThrow as jest.Mock).mockReturnValue({ name: '1', kind: 'base' });
    (
      resolvedStepHasSubsteps as jest.MockedFunction<typeof resolvedStepHasSubsteps>
    ).mockReturnValue(false);

    const config = createPassTransitionConfig();
    await expect(executeTransition(ctx, config, { stepId: '1.1' })).rejects.toThrow(
      '--step requires the runbook to be at a substep',
    );
  });

  it('uses explicit target for completion key when provided', async () => {
    const ctx = makeCtx();
    const config = createPassTransitionConfig();

    await executeTransition(ctx, config, { stepId: '1.1' });

    // Verify parseStepIdFromString was called with the explicit step ID
    expect(core.parseStepIdFromString).toHaveBeenCalledWith('1.1');
    // Verify completion was recorded (substep completion path was entered)
    expect(ctx.lifecycleService.upsertResolvedCompletion).toHaveBeenCalled();
  });

  it('uses explicit target with --index for iteration targeting', async () => {
    const ctx = makeCtx();
    // parseStepIdFromString returns step without AT (index comes from --index flag)
    (core.parseStepIdFromString as jest.Mock).mockReturnValue({ step: '1', substep: '1' });
    const config = createPassTransitionConfig();

    await executeTransition(ctx, config, { stepId: '1.1', index: '3' });

    // buildFrameKey should have been called with iteration=3
    expect(core.buildFrameKey).toHaveBeenCalledWith('1', 3);
  });

  it('throws on invalid step ID in explicit target', async () => {
    const ctx = makeCtx();
    (core.parseStepIdFromString as jest.Mock).mockReturnValue(null);
    const config = createPassTransitionConfig();

    await expect(executeTransition(ctx, config, { stepId: 'invalid!!!' })).rejects.toThrow(
      'Invalid step target: invalid!!!',
    );
  });

  it('throws when explicit target step does not match active step', async () => {
    const ctx = makeCtx({ step: '1', substep: '1' }); // Active step is '1'
    // Explicit target points to step '2'
    (core.parseStepIdFromString as jest.Mock).mockReturnValue({ step: '2', substep: '1' });
    const config = createPassTransitionConfig();

    await expect(executeTransition(ctx, config, { stepId: '2.1' })).rejects.toThrow(
      'targets step "2" but the active step is "1"',
    );
  });

  it('throws IndexOptionError on conflicting --index and AT', async () => {
    const ctx = makeCtx();
    (core.parseStepIdFromString as jest.Mock).mockReturnValue({ step: '1', substep: '1', at: 5 });
    const config = createPassTransitionConfig();

    await expect(executeTransition(ctx, config, { stepId: '1.1', index: '3' })).rejects.toThrow(
      'conflicts with AT',
    );
  });

  it('uses cursor.substep (not activeState.substep) for completion key', async () => {
    const ctx = makeCtx({ substep: '1' }); // Active substep is '1'
    // Explicit target points to substep '2'
    (core.parseStepIdFromString as jest.Mock).mockReturnValue({ step: '1', substep: '2' });
    const config = createPassTransitionConfig();

    await executeTransition(ctx, config, { stepId: '1.2' });

    // buildCompletionKey should use '2' (from explicit target), not '1' (from activeState)
    const completionKeyCall = (core.buildCompletionKey as jest.Mock).mock.calls[0];
    expect(completionKeyCall[2]).toBe('2'); // substep argument
  });

  it('falls back to activeCursorTarget when no explicit target', async () => {
    const ctx = makeCtx({ substep: '1' });
    const config = createPassTransitionConfig();

    await executeTransition(ctx, config); // No explicit target

    // buildCompletionKey should use activeState.substep ('1')
    const completionKeyCall = (core.buildCompletionKey as jest.Mock).mock.calls[0];
    expect(completionKeyCall[2]).toBe('1');
  });
});
