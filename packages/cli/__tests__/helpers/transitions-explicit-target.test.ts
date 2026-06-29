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
  RunbookLifecycleCommandService: jest.fn(),
  SessionService: jest.fn(),
  ExecutionLifecycleService: jest.fn(),
  // Used only by buildTransitionContext (not exercised here); the mocks exist to
  // satisfy the ESM named-import link check for transitions.ts.
  resolveCommandTarget: jest.fn(),
  resolveTransitionTarget: jest.fn(),
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
  transitionSinkFromEmitter: mockFn<
    (emitter: unknown) => Record<string, unknown>
  >().mockReturnValue({}),
}));

// Mock actor-service factory to keep this unit test on structural service doubles.
jest.unstable_mockModule('../../src/helpers/actor-service-factory', () => ({
  createCliRunbookActorService: mockFn<() => Record<string, unknown>>().mockReturnValue({}),
}));

const core = await import('@rundown-org/core');
const { resolvedStepHasSubsteps } = await import('@rundown-org/parser');
const { findStepOrThrow } = await import('../../src/services/execution.js');
const { resolveManualCompletionCursor } = await import('../../src/helpers/transitions.js');
import type { ExplicitTarget } from '../../src/helpers/transitions.js';

// `resolveManualCompletionCursor` is the pure Category-A cursor parser extracted
// from `executeTransition`: it turns raw `--step` / `--index` into the validated
// `ManualCompletionCursor` the core lifecycle seam consumes. The explicit target
// is required — the former live-cursor fallback was unreachable in production
// (the sole caller always supplies `--step`) and the active-cursor derivation now
// lives in the core seam's `activeCursor`. These tests pin that validation
// directly — the drive collaborators (recordManualCompletion / drain /
// sendAndSync) now live in the seam and are covered by
// packages/core/__tests__/runbook/lifecycle-command-service.test.ts.

/** Minimal runbook state — the cursor parser only reads step/substep/frame fields. */
function makeState(overrides: Record<string, unknown> = {}): RunbookState {
  return {
    id: 'run-1',
    step: '1',
    substep: '1',
    activeEntry: 1,
    activeFrameKey: '1',
    ...overrides,
  } as unknown as RunbookState;
}

// The parser reads the active step from `findStepOrThrow`, so the `steps` array
// argument is irrelevant — pass an empty array and configure `mockFindStep`.
const NO_STEPS: readonly ResolvedStep[] = [];

/**
 * Configure findStepOrThrow to return a partial step shape. The kernel only
 * inspects a handful of fields (name/kind/substeps/forClause) so fixtures elide
 * the rest; cast through unknown at the boundary.
 */
function mockFindStep(step: Record<string, unknown>): void {
  jest.mocked(findStepOrThrow).mockReturnValue(step as unknown as ResolvedStep);
}

/**
 * Configure parseStepIdFromString to return a partial StepId shape (step,
 * substep, at) or null. The full StepId union has many variants, but tests only
 * need the field combinations the parser inspects.
 */
function mockParseStepId(parsed: Record<string, unknown> | null): void {
  jest.mocked(core.parseStepIdFromString).mockReturnValue(parsed as unknown as StepId | null);
}

const target = (stepId: string, index?: string): ExplicitTarget =>
  index !== undefined ? { stepId, index } : { stepId };

beforeEach(() => {
  jest.clearAllMocks();
  // Default: active step has substeps ['1', '2'].
  mockFindStep({ name: '1', kind: 'substeps', substeps: [{ id: '1' }, { id: '2' }] });
  (resolvedStepHasSubsteps as jest.MockedFunction<typeof resolvedStepHasSubsteps>).mockReturnValue(
    true,
  );
  // Default: parseStepIdFromString returns a valid parse.
  jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', substep: '1' });
});

describe('resolveManualCompletionCursor', () => {
  it('builds a cursor from the explicit --step target', () => {
    mockParseStepId({ step: '1', substep: '1' });

    const cursor = resolveManualCompletionCursor(NO_STEPS, makeState(), target('1.1'));

    expect(core.parseStepIdFromString).toHaveBeenCalledWith('1.1');
    expect(cursor).toMatchObject({ step: '1', substep: '1' });
  });

  it('targets the explicit substep, not the active-state substep', () => {
    // Active substep is '1'; the explicit target points at substep '2'.
    mockParseStepId({ step: '1', substep: '2' });

    const cursor = resolveManualCompletionCursor(
      NO_STEPS,
      makeState({ substep: '1' }),
      target('1.2'),
    );

    expect(cursor.substep).toBe('2');
  });

  it('uses --index for iteration targeting', () => {
    const forStep = {
      name: '1',
      kind: 'for',
      forClause: { start: 1, end: 5, source: undefined },
      substeps: [{ id: '1' }, { id: '2' }],
    };
    mockFindStep(forStep);
    mockParseStepId({ step: '1', substep: '1' });

    const cursor = resolveManualCompletionCursor(
      NO_STEPS,
      makeState({ substep: '1' }),
      target('1.1', '3'),
    );

    expect(core.buildFrameKey).toHaveBeenCalledWith('1', 3);
    expect(cursor.iteration).toBe(3);
  });

  it('throws on an invalid step ID', () => {
    mockParseStepId(null);

    expect(() =>
      resolveManualCompletionCursor(NO_STEPS, makeState(), target('invalid!!!')),
    ).toThrow('Invalid step target: invalid!!!');
  });

  it('throws when the explicit step does not match the active step', () => {
    // Active step is '1'; the explicit target points at step '2'.
    mockParseStepId({ step: '2', substep: '1' });

    expect(() =>
      resolveManualCompletionCursor(
        NO_STEPS,
        makeState({ step: '1', substep: '1' }),
        target('2.1'),
      ),
    ).toThrow('targets step "2" but the active step is "1"');
  });

  it('throws when the explicit target has no substep (bare step ID)', () => {
    mockParseStepId({ step: '1' });

    expect(() =>
      resolveManualCompletionCursor(NO_STEPS, makeState({ substep: '1' }), target('1')),
    ).toThrow('must include a substep');
  });

  it('throws when the target substep does not exist in the step', () => {
    // Step has substeps ['1', '2'], but the target references substep '99'.
    mockParseStepId({ step: '1', substep: '99' });

    expect(() =>
      resolveManualCompletionCursor(NO_STEPS, makeState({ substep: '1' }), target('1.99')),
    ).toThrow('substep "99" does not exist');
  });

  it('throws when an explicit target is provided but not in substep mode', () => {
    mockFindStep({ name: '1', kind: 'base' });
    (
      resolvedStepHasSubsteps as jest.MockedFunction<typeof resolvedStepHasSubsteps>
    ).mockReturnValue(false);

    expect(() =>
      resolveManualCompletionCursor(NO_STEPS, makeState({ substep: undefined }), target('1.1')),
    ).toThrow('--step requires the runbook to be at a substep');
  });

  it('throws IndexOptionError on conflicting --index and AT', () => {
    mockParseStepId({ step: '1', substep: '1', at: 5 });

    expect(() =>
      resolveManualCompletionCursor(NO_STEPS, makeState({ substep: '1' }), target('1.1', '3')),
    ).toThrow('conflicts with AT');
  });

  it('throws when --step uses a template AT expression without --index', () => {
    const forStep = {
      name: '1',
      kind: 'for',
      forClause: { start: 1, end: 5, source: undefined },
      substeps: [{ id: '1' }, { id: '2' }],
    };
    mockFindStep(forStep);
    // parsed.at is a template string — not resolvable in pass/fail context.
    mockParseStepId({ step: '1', substep: '1', at: '{{Index}}' });

    expect(() =>
      resolveManualCompletionCursor(NO_STEPS, makeState({ substep: '1' }), target('1.1')),
    ).toThrow('template AT expression');
  });

  it('throws when --index targets an iteration above FOR end', () => {
    const forStep = {
      name: '1',
      kind: 'for',
      forClause: { start: 1, end: 5, source: undefined },
      substeps: [{ id: '1' }, { id: '2' }],
    };
    mockFindStep(forStep);
    mockParseStepId({ step: '1', substep: '1' });

    expect(() =>
      resolveManualCompletionCursor(NO_STEPS, makeState({ substep: '1' }), target('1.1', '6')),
    ).toThrow('exceeds FOR end 5');
  });

  it('throws when --index targets an iteration below FOR start', () => {
    const forStep = {
      name: '1',
      kind: 'for',
      forClause: { start: 3, end: 5, source: undefined },
      substeps: [{ id: '1' }, { id: '2' }],
    };
    mockFindStep(forStep);
    mockParseStepId({ step: '1', substep: '1' });

    expect(() =>
      resolveManualCompletionCursor(NO_STEPS, makeState({ substep: '1' }), target('1.1', '2')),
    ).toThrow('below FOR start 3');
  });

  it('allows --index within FOR bounds', () => {
    const forStep = {
      name: '1',
      kind: 'for',
      forClause: { start: 1, end: 5, source: undefined },
      substeps: [{ id: '1' }, { id: '2' }],
    };
    mockFindStep(forStep);
    mockParseStepId({ step: '1', substep: '1' });

    const cursor = resolveManualCompletionCursor(
      NO_STEPS,
      makeState({ substep: '1' }),
      target('1.1', '3'),
    );

    expect(cursor.iteration).toBe(3);
  });

  it('skips the upper-bound check for an open-window file source', () => {
    const forStep = {
      name: '1',
      kind: 'for',
      // FullSourceWindow: a file source with no `end` bound.
      forClause: { start: 1, source: 'items', variable: 'item' },
      substeps: [{ id: '1' }, { id: '2' }],
    };
    mockFindStep(forStep);
    mockParseStepId({ step: '1', substep: '1' });

    const cursor = resolveManualCompletionCursor(
      NO_STEPS,
      makeState({ substep: '1' }),
      target('1.1', '999'),
    );

    expect(cursor.iteration).toBe(999);
  });

  it('throws when --index is provided but the step is not a FOR/PROMPTED-FOR step', () => {
    // Default step is kind: 'substeps' (not FOR).
    mockParseStepId({ step: '1', substep: '1' });

    expect(() =>
      resolveManualCompletionCursor(NO_STEPS, makeState({ substep: '1' }), target('1.1', '3')),
    ).toThrow('--index requires step "1" to be a FOR or PROMPTED-FOR step');
  });

  it('builds an inactive (sentinel) frame when targeting a non-active frame', () => {
    const forStep = {
      name: '1',
      kind: 'for',
      forClause: { start: 1, end: 5, source: undefined },
      substeps: [{ id: '1' }, { id: '2' }],
    };
    mockFindStep(forStep);
    mockParseStepId({ step: '1', substep: '1' });
    // Active frame is '1|'; buildFrameKey('1', 3) => '1[3]' differs, so the target
    // frame is inactive.
    const cursor = resolveManualCompletionCursor(
      NO_STEPS,
      makeState({ substep: '1', activeFrameKey: '1|', activeEntry: 2 }),
      target('1.1', '3'),
    );

    expect(cursor.frame).toMatchObject({ kind: 'inactive' });
  });

  it('builds an active frame with activeEntry when targeting the active frame', () => {
    // buildFrameKey('1', undefined) => '1' matches the active frame key '1'.
    mockParseStepId({ step: '1', substep: '2' });

    const cursor = resolveManualCompletionCursor(
      NO_STEPS,
      makeState({ substep: '1', activeFrameKey: '1', activeEntry: 2 }),
      target('1.2'),
    );

    expect(cursor.frame).toMatchObject({ kind: 'active', entry: 2 });
  });

  it('defaults to the active iteration when --step is used in a FOR loop without --index', () => {
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
    mockParseStepId({ step: '1', substep: '1' });

    const cursor = resolveManualCompletionCursor(
      NO_STEPS,
      makeState({ substep: '1', activeFrameKey: '1[3]', activeEntry: 2 }),
      target('1.1'),
    );

    // Frame key uses iteration 3 (not undefined), and the matching frame is active.
    expect(core.buildFrameKey).toHaveBeenCalledWith('1', 3);
    expect(cursor.iteration).toBe(3);
    expect(cursor.frame).toMatchObject({ kind: 'active', entry: 2 });
  });

  it('allows --index on a prompted-for step without a bounds check', () => {
    const promptedForStep = {
      name: '1',
      kind: 'prompted-for',
      // No forClause — prompted-for has no executable bounds.
      substeps: [{ id: '1' }, { id: '2' }],
    };
    mockFindStep(promptedForStep);
    mockParseStepId({ step: '1', substep: '1' });

    const cursor = resolveManualCompletionCursor(
      NO_STEPS,
      makeState({ substep: '1' }),
      target('1.1', '3'),
    );

    expect(core.buildFrameKey).toHaveBeenCalledWith('1', 3);
    expect(cursor.iteration).toBe(3);
  });

  it('defaults to the active iteration on a prompted-for step without --index', () => {
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
    mockParseStepId({ step: '1', substep: '1' });

    const cursor = resolveManualCompletionCursor(
      NO_STEPS,
      makeState({ substep: '1', activeFrameKey: '1[3]', activeEntry: 2 }),
      target('1.1'),
    );

    expect(core.buildFrameKey).toHaveBeenCalledWith('1', 3);
    expect(cursor.iteration).toBe(3);
  });
});
