import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { mockErrorHelpers } from './mock-error-helpers.js';
import { mockFn } from './typed-mocks.js';
import type {
  ActionType,
  Frame,
  FrameKey,
  ResolvedCompletion,
  RunbookState,
} from '@rundown-org/core';
import type { ResolvedStep, StepId } from '@rundown-org/parser';

// Mock @rundown-org/core
jest.unstable_mockModule('@rundown-org/core', () => ({
  RunbookStateManager: jest.fn(),
  RunbookActorService: jest.fn(),
  RunbookCompletionService: jest.fn(),
  SessionService: jest.fn(),
  ExecutionLifecycleService: jest.fn(),
  extractLastAction: mockFn<(snapshot: unknown) => unknown>().mockReturnValue(undefined),
  formatTransitionAction: mockFn<(action: ActionType) => string>().mockReturnValue('CONTINUE'),
  parseActionType: mockFn<(action: unknown) => ActionType>().mockImplementation((action) => {
    if (
      typeof action === 'object' &&
      action !== null &&
      'type' in action &&
      typeof (action as { type?: unknown }).type === 'string'
    ) {
      return (action as { type: ActionType }).type;
    }
    return 'CONTINUE';
  }),
  parseStepIdFromString: mockFn<(input: string) => StepId | null>(),
  SENTINEL_ENTRY: 0,
  activeFrame: mockFn<
    (frameKey: FrameKey, entry: number) => { kind: 'active'; frameKey: FrameKey; entry: number }
  >().mockImplementation((frameKey, entry) => ({ kind: 'active', frameKey, entry })),
  exactFrame: mockFn<
    (frameKey: FrameKey, entry: number) => { kind: 'exact'; frameKey: FrameKey; entry: number }
  >().mockImplementation((frameKey, entry) => ({ kind: 'exact', frameKey, entry })),
  inactiveFrame: mockFn<
    (frameKey: FrameKey) => { kind: 'inactive'; frameKey: FrameKey }
  >().mockImplementation((frameKey) => ({ kind: 'inactive', frameKey })),
  completionEntryForFrame: mockFn<(frame: Frame) => number>().mockImplementation((frame) =>
    frame.kind === 'inactive' ? 0 : frame.entry,
  ),
  buildCompletionKey: mockFn<(frame: Frame, substep?: string) => string>().mockImplementation(
    (frame, substep) => {
      const entry = frame.kind === 'inactive' ? 0 : frame.entry;
      return `${String(frame.frameKey)}:${String(entry)}:${substep ?? ''}`;
    },
  ),
  buildFrameKey: mockFn<(step: string, iteration?: number) => FrameKey>().mockImplementation(
    (step, iteration) =>
      (iteration !== undefined ? `${step}[${String(iteration)}]` : step) as FrameKey,
  ),
  buildResolvedCompletion: mockFn<
    (fields: unknown) => Partial<ResolvedCompletion>
  >().mockReturnValue({ result: 'pass' }),
  deriveExecutionAt: mockFn<
    (step: string, substep?: string, iteration?: number) => string
  >().mockImplementation(
    (step, substep, iteration) =>
      `${step}${iteration !== undefined ? `[${String(iteration)}]` : ''}${substep ? `.${substep}` : ''}`,
  ),
  deriveActiveFrame: mockFn<
    (state: RunbookState) => { step: string; iteration?: number; frameKey: FrameKey }
  >().mockReturnValue({ step: '1', iteration: undefined, frameKey: '1' as FrameKey }),
  isRunId: mockFn<(value: unknown) => boolean>().mockImplementation(
    (value) => typeof value === 'string' && /^rd_[a-f0-9]{32}$/.test(value),
  ),
  logger: { warn: mockFn<(...args: unknown[]) => void>() },
  ...mockErrorHelpers,
}));

// Mock @rundown-org/parser
jest.unstable_mockModule('@rundown-org/parser', () => ({
  extractFrontmatter: mockFn<(content: string) => { frontmatter: null; content: string }>(),
  resolvedStepHasSubsteps: mockFn<(step: ResolvedStep) => boolean>(),
}));

// Mock runbook-loader
jest.unstable_mockModule('../../src/helpers/runbook-loader', () => ({
  getRunbookFromState: mockFn<() => readonly ResolvedStep[]>().mockReturnValue([]),
}));

// Mock execution service
jest.unstable_mockModule('../../src/services/execution', () => ({
  drainResolvedCompletions: mockFn<
    (...args: unknown[]) => Promise<{ status: string; applied: number; unresolved?: number }>
  >().mockResolvedValue({ status: 'done', applied: 0 }),
  findStepOrThrow: mockFn<(steps: readonly ResolvedStep[], stepName: string) => ResolvedStep>(),
  runExecutionLoop: mockFn<(...args: unknown[]) => Promise<string>>().mockResolvedValue('done'),
}));

// Mock execution-emitter
jest.unstable_mockModule('../../src/helpers/execution-emitter', () => ({
  createBridgedEmitter: mockFn<() => Record<string, unknown>>().mockReturnValue({}),
}));

// Mock transition-orchestrator
jest.unstable_mockModule('../../src/helpers/transition-orchestrator', () => ({
  orchestrateTransition: mockFn<
    (...args: unknown[]) => Promise<{ status: string }>
  >().mockResolvedValue({ status: 'done' }),
}));

// Mock actor-service factory to keep this unit test on structural service doubles.
jest.unstable_mockModule('../../src/helpers/actor-service-factory', () => ({
  createCliRunbookActorService: mockFn<() => Record<string, unknown>>().mockReturnValue({}),
}));

const core = await import('@rundown-org/core');
const { resolvedStepHasSubsteps } = await import('@rundown-org/parser');
const { findStepOrThrow, drainResolvedCompletions } = await import(
  '../../src/services/execution.js'
);
const { executeTransition, createPassTransitionConfig } = await import(
  '../../src/helpers/transitions.js'
);
import type { TransitionContext } from '../../src/helpers/transitions.js';

/**
 * Test ctx type — exposes only the fields executeTransition uses, with each
 * service method typed as a jest.Mock so test assertions can read .mock.calls.
 * Cast through unknown to TransitionContext at the makeCtx boundary so call
 * sites pass the ctx directly to executeTransition without per-test casts.
 */
type TestCtx = Omit<
  TransitionContext,
  'output' | 'manager' | 'actorService' | 'lifecycleService' | 'sessionService' | 'steps'
> & {
  output: {
    action: jest.Mock;
    flush: jest.Mock;
    status: jest.Mock;
    warning: jest.Mock;
  };
  manager: {
    update: jest.Mock<(...args: unknown[]) => Promise<unknown>>;
    load: jest.Mock<(...args: unknown[]) => Promise<unknown>>;
  };
  actorService: {
    assertFreshState: jest.Mock<(...args: unknown[]) => Promise<boolean>>;
    sendAndSync: jest.Mock<
      (...args: unknown[]) => Promise<{ state: Record<string, unknown>; snapshot: unknown } | null>
    >;
  };
  lifecycleService: {
    ensureActiveEntry: jest.Mock<(...args: unknown[]) => Promise<unknown>>;
  };
  sessionService: {
    getActive: jest.Mock<(...args: unknown[]) => Promise<unknown>>;
    pushRunbook: jest.Mock<(...args: unknown[]) => Promise<void>>;
  };
  // Loosely-typed step fixtures — the kernel only consumes the union shape at runtime.
  steps: ReadonlyArray<Record<string, unknown>>;
};

function makeCtx(stateOverrides: Record<string, unknown> = {}): TestCtx {
  const state = {
    id: 'run-1',
    step: '1',
    substep: '1',
    activeEntry: 1,
    activeFrameKey: '1',
    ...stateOverrides,
  };
  return {
    output: {
      action: mockFn<(...args: unknown[]) => void>(),
      flush: mockFn<() => void>(),
      status: mockFn<(...args: unknown[]) => void>(),
      warning: mockFn<(...args: unknown[]) => void>(),
    },
    manager: {
      update: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined),
      load: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(null),
    },
    actorService: {
      assertFreshState: mockFn<(...args: unknown[]) => Promise<boolean>>().mockResolvedValue(true),
      sendAndSync: mockFn<
        (...args: unknown[]) => Promise<{ state: Record<string, unknown>; snapshot: unknown }>
      >().mockResolvedValue({
        state: { ...state },
        snapshot: { context: { lastAction: { type: 'CONTINUE', origin: 'direct' } } },
      }),
    },
    sessionService: {
      getActive: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(null),
      pushRunbook: mockFn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
    },
    lifecycleService: {
      ensureActiveEntry: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({
        state,
        entryId: 1,
      }),
    },
    state,
    steps: [
      {
        name: '1',
        kind: 'substeps',
        substeps: [{ id: '1' }, { id: '2' }],
      },
    ],
    cwd: '/test',
  } as unknown as TestCtx;
}

/**
 * Cast helper at the executeTransition call boundary. The TestCtx is
 * intentionally partial (sessionService is empty, actor is simplified, etc.)
 * because executeTransition only consumes the fields we mock.
 */
function asCtx(ctx: TestCtx): TransitionContext {
  return ctx as unknown as TransitionContext;
}

/**
 * Configure findStepOrThrow to return a partial step shape. The kernel only
 * inspects a handful of fields (name/kind/substeps/forClause/outputs) so
 * fixtures elide the rest; cast through unknown at the boundary.
 */
function mockFindStep(step: Record<string, unknown>): void {
  jest.mocked(findStepOrThrow).mockReturnValue(step as unknown as ResolvedStep);
}

/**
 * Configure parseStepIdFromString to return a partial StepId shape (step,
 * substep, at) or null. The full StepId union has many variants, but tests
 * only need the field combinations the kernel inspects.
 */
function mockParseStepId(parsed: Record<string, unknown> | null): void {
  jest.mocked(core.parseStepIdFromString).mockReturnValue(parsed as unknown as StepId | null);
}

/**
 * Mock for the core `RunbookCompletionService.recordManualCompletion` seam.
 * Assigned fresh in `beforeEach` and exposed at module scope so tests can both
 * assert on its call arguments and drive its `{ status }` return value. Per
 * CLAUDE.md "Mock injected core services structurally", this is a plain stub —
 * the real recording/duplicate-suppression logic is owned by core and tested in
 * packages/core/__tests__/runbook/completion-service.test.ts.
 */
let recordManualCompletion: jest.Mock<
  (...args: unknown[]) => Promise<{ status: string; key: string }>
>;

beforeEach(() => {
  jest.clearAllMocks();
  // Default: step has substeps
  mockFindStep({
    name: '1',
    kind: 'substeps',
    substeps: [{ id: '1' }, { id: '2' }],
  });
  (resolvedStepHasSubsteps as jest.MockedFunction<typeof resolvedStepHasSubsteps>).mockReturnValue(
    true,
  );
  // Default: parseStepIdFromString returns valid parse
  jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', substep: '1' });
  // Reset buildCompletionKey
  jest.mocked(core.buildCompletionKey).mockImplementation((frame: Frame, substep?: string) => {
    const entry = frame.kind === 'inactive' ? 0 : frame.entry;
    return `${String(frame.frameKey)}:${String(entry)}:${substep ?? ''}`;
  });
  recordManualCompletion = mockFn<
    (...args: unknown[]) => Promise<{ status: string; key: string }>
  >().mockResolvedValue({ status: 'recorded', key: 'frame:1:1' });
  (core.RunbookCompletionService as unknown as jest.Mock).mockImplementation(() => ({
    recordManualCompletion,
  }));
});

describe('executeTransition with ExplicitTarget', () => {
  it('validates invalid state before recording substep completions', async () => {
    const ctx = makeCtx();
    const staleError = new Error(
      'Invalid runbook state for "run-1": missing frontmatter outputs declarations.',
    );
    ctx.actorService.assertFreshState.mockRejectedValue(staleError);
    const config = createPassTransitionConfig();

    await expect(executeTransition(asCtx(ctx), config, { stepId: '1.2' })).rejects.toThrow(
      /Invalid runbook state/,
    );

    expect(ctx.actorService.assertFreshState).toHaveBeenCalledWith('run-1', ctx.steps);
    expect(ctx.lifecycleService.ensureActiveEntry).not.toHaveBeenCalled();
    expect(recordManualCompletion).not.toHaveBeenCalled();
  });

  it('throws when explicitTarget is provided but not in substep mode', async () => {
    const ctx = makeCtx({ substep: undefined }); // No active substep
    mockFindStep({ name: '1', kind: 'base' });
    (
      resolvedStepHasSubsteps as jest.MockedFunction<typeof resolvedStepHasSubsteps>
    ).mockReturnValue(false);

    const config = createPassTransitionConfig();
    await expect(executeTransition(asCtx(ctx), config, { stepId: '1.1' })).rejects.toThrow(
      '--step requires the runbook to be at a substep',
    );
  });

  it('uses explicit target for completion key when provided', async () => {
    const ctx = makeCtx();
    const config = createPassTransitionConfig();

    await executeTransition(asCtx(ctx), config, { stepId: '1.1' });

    // Verify parseStepIdFromString was called with the explicit step ID
    expect(core.parseStepIdFromString).toHaveBeenCalledWith('1.1');
    // Verify completion was recorded (substep completion path was entered)
    expect(recordManualCompletion).toHaveBeenCalled();
  });

  it('uses explicit target with --index for iteration targeting', async () => {
    const forStep = {
      name: '1',
      kind: 'for',
      forClause: { start: 1, end: 5, source: undefined },
      substeps: [{ id: '1' }, { id: '2' }],
    };
    mockFindStep(forStep);
    const ctx = makeCtx();
    ctx.steps = [forStep];
    // parseStepIdFromString returns step without AT (index comes from --index flag)
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', substep: '1' });
    const config = createPassTransitionConfig();

    await executeTransition(asCtx(ctx), config, { stepId: '1.1', index: '3' });

    // buildFrameKey should have been called with iteration=3
    expect(core.buildFrameKey).toHaveBeenCalledWith('1', 3);
  });

  it('throws on invalid step ID in explicit target', async () => {
    const ctx = makeCtx();
    mockParseStepId(null);
    const config = createPassTransitionConfig();

    await expect(executeTransition(asCtx(ctx), config, { stepId: 'invalid!!!' })).rejects.toThrow(
      'Invalid step target: invalid!!!',
    );
  });

  it('throws when explicit target step does not match active step', async () => {
    const ctx = makeCtx({ step: '1', substep: '1' }); // Active step is '1'
    // Explicit target points to step '2'
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '2', substep: '1' });
    const config = createPassTransitionConfig();

    await expect(executeTransition(asCtx(ctx), config, { stepId: '2.1' })).rejects.toThrow(
      'targets step "2" but the active step is "1"',
    );
  });

  it('throws IndexOptionError on conflicting --index and AT', async () => {
    const ctx = makeCtx();
    jest.mocked(core.parseStepIdFromString).mockReturnValue({
      step: '1',
      substep: '1',
      at: 5,
    });
    const config = createPassTransitionConfig();

    await expect(
      executeTransition(asCtx(ctx), config, { stepId: '1.1', index: '3' }),
    ).rejects.toThrow('conflicts with AT');
  });

  it('uses cursor.substep (not activeState.substep) for completion key', async () => {
    const ctx = makeCtx({ substep: '1' }); // Active substep is '1'
    // Explicit target points to substep '2'
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', substep: '2' });
    const config = createPassTransitionConfig();

    await executeTransition(asCtx(ctx), config, { stepId: '1.2' });

    // recordManualCompletion should receive '2' (from explicit target), not '1' (from activeState)
    expect(recordManualCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ targetSubstep: '2' }),
    );
  });

  it('falls back to activeCursorTarget when no explicit target', async () => {
    const ctx = makeCtx({ substep: '1' });
    const config = createPassTransitionConfig();

    await executeTransition(asCtx(ctx), config); // No explicit target

    // recordManualCompletion should receive activeState.substep ('1')
    expect(recordManualCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ targetSubstep: '1' }),
    );
  });

  it('does not reactivate inline child when parent frame key is stale', async () => {
    const childRunId = `rd_${'c'.repeat(32)}`;
    const ctx = makeCtx({
      substep: '1',
      activeFrameKey: '1|',
      activeEntry: 1,
      substepStates: [
        {
          id: '1',
          frameKey: '1|',
          status: 'running',
          inline: { childRunId },
        },
      ],
    });
    ctx.manager.load.mockResolvedValue({
      id: childRunId,
      lifecycle: 'running',
      parentLinkage: {
        kind: 'inline',
        parentRunId: 'run-1',
        parentStep: '1',
        parentStepId: '1',
        parentFrameKey: '1|2',
        parentEntry: 1,
      },
    });
    const config = createPassTransitionConfig();

    await executeTransition(asCtx(ctx), config);

    expect(ctx.sessionService.pushRunbook).not.toHaveBeenCalled();
  });

  it('does not reactivate inline child when parent entry is stale', async () => {
    const childRunId = `rd_${'d'.repeat(32)}`;
    const ctx = makeCtx({
      substep: '1',
      activeFrameKey: '1|',
      activeEntry: 1,
      substepStates: [
        {
          id: '1',
          frameKey: '1|',
          status: 'running',
          inline: { childRunId },
        },
      ],
    });
    ctx.manager.load.mockResolvedValue({
      id: childRunId,
      lifecycle: 'running',
      parentLinkage: {
        kind: 'inline',
        parentRunId: 'run-1',
        parentStep: '1',
        parentStepId: '1',
        parentFrameKey: '1|',
        parentEntry: 2,
      },
    });
    const config = createPassTransitionConfig();

    await executeTransition(asCtx(ctx), config);

    expect(ctx.sessionService.pushRunbook).not.toHaveBeenCalled();
  });

  it('throws when target substep does not exist in the step', async () => {
    const ctx = makeCtx({ substep: '1' });
    // Step has substeps ['1', '2'], but target references substep '99'
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', substep: '99' });
    const config = createPassTransitionConfig();

    await expect(executeTransition(asCtx(ctx), config, { stepId: '1.99' })).rejects.toThrow(
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
    mockFindStep(forStep);
    const ctx = makeCtx({ substep: '1' });
    ctx.steps = [forStep];
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', substep: '1' });
    const config = createPassTransitionConfig();

    await expect(
      executeTransition(asCtx(ctx), config, { stepId: '1.1', index: '6' }),
    ).rejects.toThrow('exceeds FOR end 5');
  });

  it('throws when --index targets iteration below FOR start', async () => {
    const forStep = {
      name: '1',
      kind: 'for',
      forClause: { start: 3, end: 5, source: undefined },
      substeps: [{ id: '1' }, { id: '2' }],
    };
    mockFindStep(forStep);
    const ctx = makeCtx({ substep: '1' });
    ctx.steps = [forStep];
    // resolveIndexOption rejects < 1, but FOR start > 1 can still be below start
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', substep: '1' });
    const config = createPassTransitionConfig();

    await expect(
      executeTransition(asCtx(ctx), config, { stepId: '1.1', index: '2' }),
    ).rejects.toThrow('below FOR start 3');
  });

  it('allows --index within FOR bounds', async () => {
    const forStep = {
      name: '1',
      kind: 'for',
      forClause: { start: 1, end: 5, source: undefined },
      substeps: [{ id: '1' }, { id: '2' }],
    };
    mockFindStep(forStep);
    const ctx = makeCtx({ substep: '1' });
    ctx.steps = [forStep];
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', substep: '1' });
    const config = createPassTransitionConfig();

    // Should not throw
    await executeTransition(asCtx(ctx), config, { stepId: '1.1', index: '3' });

    expect(recordManualCompletion).toHaveBeenCalled();
  });

  it('skips upper bound check for open-window file source', async () => {
    const forStep = {
      name: '1',
      kind: 'for',
      forClause: { start: 1, source: 'items', variable: 'item' },
      substeps: [{ id: '1' }, { id: '2' }],
    };
    mockFindStep(forStep);
    const ctx = makeCtx({ substep: '1' });
    ctx.steps = [forStep];
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', substep: '1' });
    const config = createPassTransitionConfig();

    // Index 999 should succeed since FullSourceWindow has no end bound
    await executeTransition(asCtx(ctx), config, { stepId: '1.1', index: '999' });

    expect(recordManualCompletion).toHaveBeenCalled();
  });

  it('throws when --index provided but step is not a FOR or PROMPTED-FOR step', async () => {
    // Default step is kind: 'substeps' (not FOR)
    // This test also covers the delegate.ts validation path (Issue C),
    // which uses the same kind-check pattern with parsedTarget?.step.
    const ctx = makeCtx({ substep: '1' });
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', substep: '1' });
    const config = createPassTransitionConfig();

    await expect(
      executeTransition(asCtx(ctx), config, { stepId: '1.1', index: '3' }),
    ).rejects.toThrow('--index requires step "1" to be a FOR or PROMPTED-FOR step');
  });

  it('uses entry=0 sentinel when targeting non-active frame', async () => {
    const forStep = {
      name: '1',
      kind: 'for',
      forClause: { start: 1, end: 5, source: undefined },
      substeps: [{ id: '1' }, { id: '2' }],
    };
    mockFindStep(forStep);
    // Active frame is '1|' (iteration undefined), targeting '1|3' via --index 3
    const ctx = makeCtx({ substep: '1', activeFrameKey: '1|', activeEntry: 2 });
    ctx.steps = [forStep];
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', substep: '1' });
    // buildFrameKey mock returns '1[3]' for iteration 3, which differs from activeFrameKey '1|'
    const config = createPassTransitionConfig();

    await executeTransition(asCtx(ctx), config, { stepId: '1.1', index: '3' });

    // Targeting a non-active frame builds an inactive (sentinel) frame and
    // forwards it to recordManualCompletion as targetFrame.
    expect(recordManualCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        targetFrame: expect.objectContaining({ kind: 'inactive' }),
      }),
    );
  });

  it('uses activeEntry when targeting active frame', async () => {
    // Active frame is '1' (mock default), target resolves to same frame
    const ctx = makeCtx({ substep: '1', activeFrameKey: '1', activeEntry: 2 });
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', substep: '2' });
    // buildFrameKey('1', undefined) returns '1' which matches activeFrameKey
    const config = createPassTransitionConfig();

    await executeTransition(asCtx(ctx), config, { stepId: '1.2' });

    // Targeting the active frame forwards an active frame with entry=2.
    expect(recordManualCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        targetFrame: expect.objectContaining({ kind: 'active', entry: 2 }),
      }),
    );
  });

  it('throws when explicit target has no substep (bare step ID)', async () => {
    const ctx = makeCtx({ substep: '1' });
    // parseStepIdFromString('1') returns step without substep
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1' });
    const config = createPassTransitionConfig();

    await expect(executeTransition(asCtx(ctx), config, { stepId: '1' })).rejects.toThrow(
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
    mockFindStep(forStep);
    jest.mocked(core.deriveActiveFrame).mockReturnValue({
      step: '1',
      iteration: 3,
      frameKey: '1[3]' as FrameKey,
    });
    const ctx = makeCtx({
      substep: '1',
      activeFrameKey: '1[3]',
      activeEntry: 2,
    });
    ctx.steps = [forStep];
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', substep: '1' });
    const config = createPassTransitionConfig();

    await executeTransition(asCtx(ctx), config, { stepId: '1.1' }); // No --index

    // buildFrameKey should use iteration 3 (not undefined)
    expect(core.buildFrameKey).toHaveBeenCalledWith('1', 3);
    // Entry should be activeEntry (2), not sentinel (0), since the frame matches.
    expect(recordManualCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        targetFrame: expect.objectContaining({ kind: 'active', entry: 2 }),
      }),
    );
  });

  it('allows --index on prompted-for step without bounds check', async () => {
    const promptedForStep = {
      name: '1',
      kind: 'prompted-for',
      // No forClause — prompted-for has no executable bounds
      substeps: [{ id: '1' }, { id: '2' }],
    };
    mockFindStep(promptedForStep);
    const ctx = makeCtx({ substep: '1' });
    ctx.steps = [promptedForStep];
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', substep: '1' });
    const config = createPassTransitionConfig();

    // Should NOT throw — prompted-for accepts --index without bounds validation
    await executeTransition(asCtx(ctx), config, { stepId: '1.1', index: '3' });

    expect(core.buildFrameKey).toHaveBeenCalledWith('1', 3);
    expect(recordManualCompletion).toHaveBeenCalled();
  });

  it('defaults to active iteration when --step used in prompted-for loop without --index', async () => {
    const promptedForStep = {
      name: '1',
      kind: 'prompted-for',
      substeps: [{ id: '1' }, { id: '2' }],
    };
    mockFindStep(promptedForStep);
    jest.mocked(core.deriveActiveFrame).mockReturnValue({
      step: '1',
      iteration: 3,
      frameKey: '1[3]' as FrameKey,
    });
    const ctx = makeCtx({ substep: '1', activeFrameKey: '1[3]', activeEntry: 2 });
    ctx.steps = [promptedForStep];
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', substep: '1' });
    const config = createPassTransitionConfig();

    await executeTransition(asCtx(ctx), config, { stepId: '1.1' }); // No --index

    expect(core.buildFrameKey).toHaveBeenCalledWith('1', 3);
  });

  it('throws when --step uses template AT expression without --index', async () => {
    const forStep = {
      name: '1',
      kind: 'for',
      forClause: { start: 1, end: 5, source: undefined },
      substeps: [{ id: '1' }, { id: '2' }],
    };
    mockFindStep(forStep);
    const ctx = makeCtx({ substep: '1' });
    ctx.steps = [forStep];
    // parsed.at is a template string — not resolvable in pass/fail context
    jest.mocked(core.parseStepIdFromString).mockReturnValue({
      step: '1',
      substep: '1',
      at: '{{Index}}',
    });
    const config = createPassTransitionConfig();

    await expect(executeTransition(asCtx(ctx), config, { stepId: '1.1' })).rejects.toThrow(
      'template AT expression',
    );
  });

  it('emits completion_duplicate when the core service reports a duplicate', async () => {
    const ctx = makeCtx({ substep: '1', activeFrameKey: '1', activeEntry: 2 });
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', substep: '1' });
    // The core service owns duplicate detection (exact/sentinel suppression is
    // covered in completion-service.test.ts). Drive its result directly.
    recordManualCompletion.mockResolvedValue({ status: 'duplicate', key: 'dup-key' });
    const config = createPassTransitionConfig();

    await executeTransition(asCtx(ctx), config, { stepId: '1.1' });

    expect(recordManualCompletion).toHaveBeenCalled();
    // CLI's only duplicate-handling behavior: emit the reconciled
    // already-resolved envelope under the command name.
    expect(ctx.output.status).toHaveBeenCalledWith(
      config.commandName,
      expect.any(String),
      expect.objectContaining({ status: 'already-resolved' }),
    );
  });

  it('passes frameOverride to drain when explicit target provided', async () => {
    const forStep = {
      name: '1',
      kind: 'for',
      forClause: { start: 1, end: 5, source: undefined },
      substeps: [{ id: '1' }, { id: '2' }],
    };
    mockFindStep(forStep);
    const ctx = makeCtx({ substep: '1' });
    ctx.steps = [forStep];
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', substep: '1' });
    const config = createPassTransitionConfig();

    await executeTransition(asCtx(ctx), config, { stepId: '1.1', index: '3' });

    expect(drainResolvedCompletions).toHaveBeenCalledWith(
      expect.objectContaining({
        frameOverride: expect.objectContaining({ frameKey: core.buildFrameKey('1', 3) }),
      }),
    );
    // The override should be the cursor's frameKey (built from step + index)
    const drainCall = jest.mocked(drainResolvedCompletions).mock.calls[0]?.[0] as {
      frameOverride?: Frame;
    };
    expect(drainCall.frameOverride?.frameKey).toBe(core.buildFrameKey('1', 3));
  });

  it('drain consumes sentinel after explicit target on non-active frame with existing exact completion', async () => {
    const forStep = {
      name: '1',
      kind: 'for',
      forClause: { start: 1, end: 5, source: undefined },
      substeps: [{ id: '1' }, { id: '2' }],
    };
    mockFindStep(forStep);
    const ctx = makeCtx({
      substep: '1',
      activeFrameKey: '1[1]',
      activeEntry: 2,
    });
    ctx.steps = [forStep];
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', substep: '1' });
    const config = createPassTransitionConfig();

    await executeTransition(asCtx(ctx), config, { stepId: '1.1', index: '3' });

    // Drain should be called with frameOverride so it can observe the targeted frame
    expect(drainResolvedCompletions).toHaveBeenCalledWith(
      expect.objectContaining({
        frameOverride: expect.objectContaining({ frameKey: '1[3]' }),
      }),
    );
  });

  it('does not pass frameOverride when no explicit target', async () => {
    const ctx = makeCtx({ substep: '1' });
    const config = createPassTransitionConfig();

    await executeTransition(asCtx(ctx), config); // No explicit target

    expect(drainResolvedCompletions).toHaveBeenCalled();
    const drainCall = jest.mocked(drainResolvedCompletions).mock.calls[0]?.[0] as {
      frameOverride?: unknown;
    };
    expect(drainCall.frameOverride).toBeUndefined();
  });
});

describe('step-level PASS transition no longer triggers CLI-side OUTPUTS evaluation', () => {
  // Helper that creates a step-level (non-substep) ctx: substep is undefined so
  // executeTransition exercises the actor.send path (machine-owned storeStepOutputs).
  function makeStepLevelCtx(templateVars?: Record<string, unknown>): TestCtx {
    const state = {
      id: 'run-1',
      step: '1',
      substep: undefined,
      activeEntry: 1,
      activeFrameKey: '1',
    };
    return {
      output: {
        action: mockFn<(...args: unknown[]) => void>(),
        flush: mockFn<() => void>(),
        status: mockFn<(...args: unknown[]) => void>(),
        warning: mockFn<(...args: unknown[]) => void>(),
      },
      manager: {
        update: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined),
        load: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(null),
      },
      actorService: {
        assertFreshState:
          mockFn<(...args: unknown[]) => Promise<boolean>>().mockResolvedValue(true),
        sendAndSync: mockFn<
          (...args: unknown[]) => Promise<{ state: Record<string, unknown>; snapshot: unknown }>
        >().mockResolvedValue({
          state: { ...state, templateVars },
          snapshot: { context: { lastAction: { type: 'CONTINUE', origin: 'direct' } } },
        }),
      },
      sessionService: {},
      lifecycleService: {
        ensureActiveEntry: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({
          state,
          entryId: 1,
        }),
      },
      state,
      steps: [{ name: '1', kind: 'base' }],
      cwd: '/test',
    } as unknown as TestCtx;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (
      resolvedStepHasSubsteps as jest.MockedFunction<typeof resolvedStepHasSubsteps>
    ).mockReturnValue(false);
    mockFindStep({
      name: '1',
      kind: 'base',
      outputs: [{ name: 'PlanPath', value: '{{ path "plan.json" }}' }],
    });
  });

  it('runs PASS transition without errors when outputs declared', async () => {
    mockFindStep({
      name: '1',
      kind: 'base',
      outputs: [
        { name: 'Good', value: '"literal-value"' },
        { name: 'Bad', value: '{{ path "plan.json" }}' },
      ],
    });
    const ctx = makeStepLevelCtx({ ContextId: 'ctx-abc', WorkPath: '.rundown/work' });
    const config = createPassTransitionConfig();

    await executeTransition(asCtx(ctx), config);

    expect(ctx.actorService.sendAndSync).toHaveBeenCalledWith('run-1', ctx.steps, {
      type: 'PASS',
    });
  });

  it('throws when sendAndSync cannot initialize the runbook engine', async () => {
    const ctx = makeStepLevelCtx();
    ctx.actorService.sendAndSync.mockResolvedValue(null);
    const config = createPassTransitionConfig();

    await expect(executeTransition(asCtx(ctx), config)).rejects.toThrow(
      'Failed to dispatch transition to runbook engine',
    );
  });
});

describe('recordManualCompletion seam behavior', () => {
  it('RunbookCompletionService constructor receives manager, lifecycleService, and actorService', async () => {
    const ctx = makeCtx({ substep: '1', activeFrameKey: '1', activeEntry: 1 });
    const config = createPassTransitionConfig();

    await executeTransition(asCtx(ctx), config, { stepId: '1.1' });

    // The service is constructed with all three dependencies: manager, lifecycleService, actorService.
    // The previous seam wired getResolvedCompletion/upsertResolvedCompletion directly; now
    // those are implementation details owned by core and passed as the lifecycleService argument.
    expect(core.RunbookCompletionService).toHaveBeenCalledWith(
      ctx.manager,
      ctx.lifecycleService,
      ctx.actorService,
    );
  });

  it('recordManualCompletion receives agentId "manual"', async () => {
    const ctx = makeCtx({ substep: '1', activeFrameKey: '1', activeEntry: 1 });
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', substep: '1' });
    const config = createPassTransitionConfig();

    await executeTransition(asCtx(ctx), config, { stepId: '1.1' });

    expect(recordManualCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'manual' }),
    );
  });

  it('recordManualCompletion receives the full payload shape', async () => {
    const ctx = makeCtx({ substep: '1', activeFrameKey: '1', activeEntry: 1 });
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', substep: '1' });
    const config = createPassTransitionConfig();

    await executeTransition(asCtx(ctx), config, { stepId: '1.1' });

    expect(recordManualCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'manual',
        runbookId: 'run-1',
        targetStep: '1',
        targetSubstep: '1',
        result: config.lastResult,
        targetFrame: expect.objectContaining({ frameKey: '1' }),
      }),
    );
  });

  it('does not emit already-resolved status output when recordManualCompletion returns "recorded"', async () => {
    const ctx = makeCtx({ substep: '1', activeFrameKey: '1', activeEntry: 1 });
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', substep: '1' });
    // Default mock already returns 'recorded'; make it explicit for clarity.
    recordManualCompletion.mockResolvedValue({ status: 'recorded', key: '1:1:1' });
    const config = createPassTransitionConfig();

    await executeTransition(asCtx(ctx), config, { stepId: '1.1' });

    // 'recorded' means a fresh completion — no already-resolved status message expected.
    expect(ctx.output.status).not.toHaveBeenCalledWith(
      config.commandName,
      expect.any(String),
      expect.objectContaining({ status: 'already-resolved' }),
    );
  });

  it('drain is called after recordManualCompletion reports a duplicate', async () => {
    const ctx = makeCtx({ substep: '1', activeFrameKey: '1', activeEntry: 1 });
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', substep: '1' });
    recordManualCompletion.mockResolvedValue({ status: 'duplicate', key: 'dup-key' });
    const config = createPassTransitionConfig();

    await executeTransition(asCtx(ctx), config, { stepId: '1.1' });

    // The CLI still drains after a duplicate — the parent runbook may have pending completions.
    expect(drainResolvedCompletions).toHaveBeenCalled();
  });

  it('recordManualCompletion mock is fresh per test — no cross-test state leaks', async () => {
    // This test relies on the beforeEach reassigning recordManualCompletion to a new mock.
    // Verify the call count starts at zero at the start of a test (beforeEach worked).
    expect(recordManualCompletion.mock.calls.length).toBe(0);

    const ctx = makeCtx({ substep: '1' });
    const config = createPassTransitionConfig();

    await executeTransition(asCtx(ctx), config, { stepId: '1.1' });

    expect(recordManualCompletion.mock.calls.length).toBe(1);
  });

  it('lifecycleService in ctx does not require upsertResolvedCompletion or getResolvedCompletion', async () => {
    // After the PR, TestCtx.lifecycleService only exposes ensureActiveEntry.
    // Verify executeTransition completes successfully without those methods being present.
    const ctx = makeCtx({ substep: '1' });
    expect(
      (ctx.lifecycleService as Record<string, unknown>).upsertResolvedCompletion,
    ).toBeUndefined();
    expect((ctx.lifecycleService as Record<string, unknown>).getResolvedCompletion).toBeUndefined();

    const config = createPassTransitionConfig();

    // Should resolve (not reject) even though the two lifecycle methods are absent.
    const result = await executeTransition(asCtx(ctx), config, { stepId: '1.1' });
    expect(result).toBe('continue');
  });
});
