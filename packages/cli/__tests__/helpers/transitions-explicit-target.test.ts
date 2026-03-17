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
  SENTINEL_ENTRY: 0,
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
    const forStep = {
      name: '1',
      kind: 'for',
      forClause: { start: 1, end: 5, source: undefined },
      substeps: [{ id: '1' }, { id: '2' }],
    };
    (findStepOrThrow as jest.Mock).mockReturnValue(forStep);
    const ctx = makeCtx();
    ctx.steps = [forStep];
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

  it('throws when target substep does not exist in the step', async () => {
    const ctx = makeCtx({ substep: '1' });
    // Step has substeps ['1', '2'], but target references substep '99'
    (core.parseStepIdFromString as jest.Mock).mockReturnValue({ step: '1', substep: '99' });
    const config = createPassTransitionConfig();

    await expect(executeTransition(ctx, config, { stepId: '1.99' })).rejects.toThrow(
      'substep "99" does not exist',
    );
  });

  it('throws when --index targets iteration above FOR end', async () => {
    const forStep = {
      name: '1',
      kind: 'for',
      forClause: { start: 1, end: 5, source: undefined },
      substeps: [{ id: '1' }, { id: '2' }],
    };
    (findStepOrThrow as jest.Mock).mockReturnValue(forStep);
    const ctx = makeCtx({ substep: '1' });
    ctx.steps = [forStep];
    (core.parseStepIdFromString as jest.Mock).mockReturnValue({ step: '1', substep: '1' });
    const config = createPassTransitionConfig();

    await expect(executeTransition(ctx, config, { stepId: '1.1', index: '6' })).rejects.toThrow(
      'exceeds FOR end 5',
    );
  });

  it('throws when --index targets iteration below FOR start', async () => {
    const forStep = {
      name: '1',
      kind: 'for',
      forClause: { start: 3, end: 5, source: undefined },
      substeps: [{ id: '1' }, { id: '2' }],
    };
    (findStepOrThrow as jest.Mock).mockReturnValue(forStep);
    const ctx = makeCtx({ substep: '1' });
    ctx.steps = [forStep];
    // resolveIndexOption rejects < 1, but FOR start > 1 can still be below start
    (core.parseStepIdFromString as jest.Mock).mockReturnValue({ step: '1', substep: '1' });
    const config = createPassTransitionConfig();

    await expect(executeTransition(ctx, config, { stepId: '1.1', index: '2' })).rejects.toThrow(
      'below FOR start 3',
    );
  });

  it('allows --index within FOR bounds', async () => {
    const forStep = {
      name: '1',
      kind: 'for',
      forClause: { start: 1, end: 5, source: undefined },
      substeps: [{ id: '1' }, { id: '2' }],
    };
    (findStepOrThrow as jest.Mock).mockReturnValue(forStep);
    const ctx = makeCtx({ substep: '1' });
    ctx.steps = [forStep];
    (core.parseStepIdFromString as jest.Mock).mockReturnValue({ step: '1', substep: '1' });
    const config = createPassTransitionConfig();

    // Should not throw
    await executeTransition(ctx, config, { stepId: '1.1', index: '3' });

    expect(ctx.lifecycleService.upsertResolvedCompletion).toHaveBeenCalled();
  });

  it('skips upper bound check for open-window file source', async () => {
    const forStep = {
      name: '1',
      kind: 'for',
      forClause: { start: 1, source: 'items', variable: 'item' },
      substeps: [{ id: '1' }, { id: '2' }],
    };
    (findStepOrThrow as jest.Mock).mockReturnValue(forStep);
    const ctx = makeCtx({ substep: '1' });
    ctx.steps = [forStep];
    (core.parseStepIdFromString as jest.Mock).mockReturnValue({ step: '1', substep: '1' });
    const config = createPassTransitionConfig();

    // Index 999 should succeed since FullSourceWindow has no end bound
    await executeTransition(ctx, config, { stepId: '1.1', index: '999' });

    expect(ctx.lifecycleService.upsertResolvedCompletion).toHaveBeenCalled();
  });

  it('throws when --index provided but step is not a FOR or PROMPTED-FOR step', async () => {
    // Default step is kind: 'substeps' (not FOR)
    // This test also covers the delegate.ts validation path (Issue C),
    // which uses the same kind-check pattern with parsedTarget?.step.
    const ctx = makeCtx({ substep: '1' });
    (core.parseStepIdFromString as jest.Mock).mockReturnValue({ step: '1', substep: '1' });
    const config = createPassTransitionConfig();

    await expect(executeTransition(ctx, config, { stepId: '1.1', index: '3' })).rejects.toThrow(
      '--index requires step "1" to be a FOR or PROMPTED-FOR step',
    );
  });

  it('uses entry=0 sentinel when targeting non-active frame', async () => {
    const forStep = {
      name: '1',
      kind: 'for',
      forClause: { start: 1, end: 5, source: undefined },
      substeps: [{ id: '1' }, { id: '2' }],
    };
    (findStepOrThrow as jest.Mock).mockReturnValue(forStep);
    // Active frame is '1|' (iteration undefined), targeting '1|3' via --index 3
    const ctx = makeCtx({ substep: '1', activeFrameKey: '1|', activeEntry: 2 });
    ctx.steps = [forStep];
    (core.parseStepIdFromString as jest.Mock).mockReturnValue({ step: '1', substep: '1' });
    // buildFrameKey mock returns '1[3]' for iteration 3, which differs from activeFrameKey '1|'
    const config = createPassTransitionConfig();

    await executeTransition(ctx, config, { stepId: '1.1', index: '3' });

    // buildCompletionKey should have been called with entry=0 (sentinel)
    const completionKeyCalls = (core.buildCompletionKey as jest.Mock).mock.calls;
    // The toRuntimeTarget call uses buildCompletionKey; check entry argument
    const runtimeTargetCall = completionKeyCalls.find((c: unknown[]) => c[1] === 0);
    expect(runtimeTargetCall).toBeDefined();
  });

  it('uses activeEntry when targeting active frame', async () => {
    // Active frame is '1' (mock default), target resolves to same frame
    const ctx = makeCtx({ substep: '1', activeFrameKey: '1', activeEntry: 2 });
    (core.parseStepIdFromString as jest.Mock).mockReturnValue({ step: '1', substep: '2' });
    // buildFrameKey('1', undefined) returns '1' which matches activeFrameKey
    const config = createPassTransitionConfig();

    await executeTransition(ctx, config, { stepId: '1.2' });

    // buildCompletionKey should have been called with entry=2 (activeEntry)
    const completionKeyCalls = (core.buildCompletionKey as jest.Mock).mock.calls;
    const runtimeTargetCall = completionKeyCalls.find((c: unknown[]) => c[1] === 2);
    expect(runtimeTargetCall).toBeDefined();
  });

  it('throws when explicit target has no substep (bare step ID)', async () => {
    const ctx = makeCtx({ substep: '1' });
    // parseStepIdFromString('1') returns step without substep
    (core.parseStepIdFromString as jest.Mock).mockReturnValue({ step: '1' });
    const config = createPassTransitionConfig();

    await expect(executeTransition(ctx, config, { stepId: '1' })).rejects.toThrow(
      'must include a substep',
    );
  });

  it('defaults to active iteration when --step used in FOR loop without --index', async () => {
    const forStep = {
      name: '1',
      kind: 'for',
      forClause: { start: 1, end: 5, source: undefined },
      substeps: [{ id: '1' }, { id: '2' }],
    };
    (findStepOrThrow as jest.Mock).mockReturnValue(forStep);
    (core.deriveActiveFrame as jest.Mock).mockReturnValue({
      step: '1',
      iteration: 3,
      frameKey: '1[3]',
    });
    const ctx = makeCtx({
      substep: '1',
      activeFrameKey: '1[3]',
      activeEntry: 2,
    });
    ctx.steps = [forStep];
    (core.parseStepIdFromString as jest.Mock).mockReturnValue({ step: '1', substep: '1' });
    const config = createPassTransitionConfig();

    await executeTransition(ctx, config, { stepId: '1.1' }); // No --index

    // buildFrameKey should use iteration 3 (not undefined)
    expect(core.buildFrameKey).toHaveBeenCalledWith('1', 3);
    // Entry should be activeEntry (2), not sentinel (0), since frame matches
    const completionKeyCalls = (core.buildCompletionKey as jest.Mock).mock.calls;
    const call = completionKeyCalls.find((c: unknown[]) => c[1] === 2);
    expect(call).toBeDefined();
  });

  it('allows --index on prompted-for step without bounds check', async () => {
    const promptedForStep = {
      name: '1',
      kind: 'prompted-for',
      // No forClause — prompted-for has no executable bounds
      substeps: [{ id: '1' }, { id: '2' }],
    };
    (findStepOrThrow as jest.Mock).mockReturnValue(promptedForStep);
    const ctx = makeCtx({ substep: '1' });
    ctx.steps = [promptedForStep];
    (core.parseStepIdFromString as jest.Mock).mockReturnValue({ step: '1', substep: '1' });
    const config = createPassTransitionConfig();

    // Should NOT throw — prompted-for accepts --index without bounds validation
    await executeTransition(ctx, config, { stepId: '1.1', index: '3' });

    expect(core.buildFrameKey).toHaveBeenCalledWith('1', 3);
    expect(ctx.lifecycleService.upsertResolvedCompletion).toHaveBeenCalled();
  });

  it('defaults to active iteration when --step used in prompted-for loop without --index', async () => {
    const promptedForStep = {
      name: '1',
      kind: 'prompted-for',
      substeps: [{ id: '1' }, { id: '2' }],
    };
    (findStepOrThrow as jest.Mock).mockReturnValue(promptedForStep);
    (core.deriveActiveFrame as jest.Mock).mockReturnValue({
      step: '1',
      iteration: 3,
      frameKey: '1[3]',
    });
    const ctx = makeCtx({ substep: '1', activeFrameKey: '1[3]', activeEntry: 2 });
    ctx.steps = [promptedForStep];
    (core.parseStepIdFromString as jest.Mock).mockReturnValue({ step: '1', substep: '1' });
    const config = createPassTransitionConfig();

    await executeTransition(ctx, config, { stepId: '1.1' }); // No --index

    expect(core.buildFrameKey).toHaveBeenCalledWith('1', 3);
  });

  it('throws when --step uses template AT expression without --index', async () => {
    const forStep = {
      name: '1',
      kind: 'for',
      forClause: { start: 1, end: 5, source: undefined },
      substeps: [{ id: '1' }, { id: '2' }],
    };
    (findStepOrThrow as jest.Mock).mockReturnValue(forStep);
    const ctx = makeCtx({ substep: '1' });
    ctx.steps = [forStep];
    // parsed.at is a template string — not resolvable in pass/fail context
    (core.parseStepIdFromString as jest.Mock).mockReturnValue({
      step: '1',
      substep: '1',
      at: '{{Index}}',
    });
    const config = createPassTransitionConfig();

    await expect(executeTransition(ctx, config, { stepId: '1.1' })).rejects.toThrow(
      'template AT expression',
    );
  });

  it('detects duplicate when sentinel completion already exists for same substep', async () => {
    const ctx = makeCtx({ substep: '1', activeFrameKey: '1', activeEntry: 2 });
    (core.parseStepIdFromString as jest.Mock).mockReturnValue({ step: '1', substep: '1' });
    // Track which keys were built so we can identify the cross-check key
    const builtKeys: Array<{ frameKey: string; entry: number; substep?: string; key: string }> = [];
    (core.buildCompletionKey as jest.Mock).mockImplementation(
      (frameKey: string, entry: number, substep?: string) => {
        const key = `${frameKey}:${String(entry)}:${substep ?? ''}`;
        builtKeys.push({ frameKey, entry, substep, key });
        return key;
      },
    );
    ctx.lifecycleService.getResolvedCompletion.mockImplementation(
      async (_id: string, key: string) => {
        // Return match for the cross-check (sentinel) key, miss for the exact key
        const sentinelCall = builtKeys.find((k) => k.entry === 0);
        if (sentinelCall?.key === key) return { result: 'pass' };
        return null;
      },
    );
    const config = createPassTransitionConfig();

    await executeTransition(ctx, config, { stepId: '1.1' });

    // Should NOT write a new completion (sentinel already covers it)
    expect(ctx.lifecycleService.upsertResolvedCompletion).not.toHaveBeenCalled();
    // Should emit duplicate status
    expect(ctx.output.status).toHaveBeenCalledWith(
      'completion_duplicate',
      expect.any(String),
      expect.any(Object),
    );
  });
});
