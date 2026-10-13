import { brandInitialTemplateVarsForTest } from './brand-helpers.js';
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { ResolvedStep, Substep, ForClause, Transitions } from '@rundown-org/parser';
import type {
  LifecycleNavigationMutationOutcome,
  LifecycleNavigationCapability,
  OwnedRunResolution,
  OwnerToken,
  RunProgressionDirective,
  RunProgressionOutcome,
  RunbookLifecycleCommandService,
  RunbookState,
  RunbookStateManager,
  StepId,
} from '@rundown-org/core';
import type { OutputEmitter } from '../../src/services/output-emitter.js';
import { brandRunIdForTest } from './brand-helpers.js';
import { mockErrorHelpers } from './mock-error-helpers.js';
import { mockFn } from './typed-mocks.js';

const DEFAULT_RUNBOOK_ID = brandRunIdForTest(`rd_${'6'.repeat(32)}`);
const TOKEN = 'rdo_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as OwnerToken;

/** The refusal half of a fenced navigation outcome, minus the applied arm. */
type NavigationRefusal = Exclude<LifecycleNavigationMutationOutcome, { kind: 'applied' }>;

// Mock @rundown-org/core. The real module is spread back so the token-option
// renderers keep their real codes; the collaborators goto drives are jest fns.
const actualCore = await import('@rundown-org/core');
const mockResolveOwnedRun =
  mockFn<(manager: RunbookStateManager, token: OwnerToken) => Promise<OwnedRunResolution>>();
jest.unstable_mockModule('@rundown-org/core', () => ({
  ...actualCore,
  resolveOwnedRun: mockResolveOwnedRun,
  parseStepIdFromString: jest.fn(),
  stepIdToString: jest.fn((id: { step: string; substep?: string }) =>
    id.substep ? `${id.step}.${id.substep}` : id.step,
  ),
  deriveGotoActionBlock: jest.fn(({ target }: { target: { step: string; substep?: string } }) => ({
    action: `GOTO ${target.substep ? `${target.step}.${target.substep}` : target.step}`,
    from: '1',
    at: target.step,
  })),
  ...mockErrorHelpers,
}));

// Mock the lifecycle seam factory: buildGotoContext dispatches into the core
// navigation seam through it (not exercised by these unit tests); mocking the
// factory keeps this suite off the seam's core-service import graph.
jest.unstable_mockModule('../../src/helpers/lifecycle-seam-factory', () => ({
  buildLifecycleSeam: jest.fn(),
}));

// GOTO owns only rendering and verbatim directive forwarding. Keep the shared
// driver structural so these tests cannot accidentally pin its internal loop.
// ONE mirror of the production predicate, used by the module factory and by
// the per-test reset below. Two copies could drift, and a factory copy that
// no longer matched the reset copy would silently change what "failed closed"
// means half-way through the suite.
const failedClosed = (outcome: RunProgressionOutcome): boolean =>
  ['refused', 'failed', 'stopped'].includes(outcome.kind);

jest.unstable_mockModule('../../src/helpers/run-progression-adapters', () => ({
  driveRunProgression: mockFn<() => Promise<RunProgressionOutcome>>(),
  progressionFailedClosed: jest.fn(failedClosed),
}));

// Mock runbook-loader
jest.unstable_mockModule('../../src/helpers/runbook-loader', () => ({
  getRunbookFromState: mockFn<() => readonly ResolvedStep[]>().mockReturnValue([]),
}));

// Mock execution-emitter
jest.unstable_mockModule('../../src/helpers/execution-emitter', () => ({
  createBridgedEmitter: mockFn<() => Record<string, unknown>>().mockReturnValue({}),
}));

// Keep the actor-service factory structural: the seam factory is mocked, but
// the module graph still links it.
jest.unstable_mockModule('../../src/helpers/actor-service-factory', () => ({
  createCliRunbookActorService: mockFn<() => Record<string, unknown>>().mockReturnValue({}),
}));

// Import after mocking
const core = await import('@rundown-org/core');
const { driveRunProgression, progressionFailedClosed } = await import(
  '../../src/helpers/run-progression-adapters.js'
);
const {
  validateGotoTarget,
  executeGoto,
  gotoResultRequiresFailureExit,
  renderNavigationRefusal,
  buildGotoContext,
} = await import('../../src/helpers/goto-workflow.js');
const { buildLifecycleSeam } = await import('../../src/helpers/lifecycle-seam-factory.js');

const DEFAULT_TRANSITIONS: Transitions = {
  pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
  fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
};

interface MakeStepOverrides {
  name?: string;
  description?: string;
  transitions?: Transitions;
  substeps?: readonly Substep[];
  forClause?: ForClause;
  command?: { code: string; lang?: string };
  kind?: ResolvedStep['kind'];
}

function makeStep(overrides: MakeStepOverrides = {}): ResolvedStep {
  const base = {
    name: overrides.name ?? '1',
    description: overrides.description ?? 'Test Step',
    transitions: overrides.transitions ?? DEFAULT_TRANSITIONS,
  };
  const explicitKind = overrides.kind;
  if (explicitKind === 'prompted-for' && overrides.substeps) {
    return {
      kind: 'prompted-for',
      ...base,
      substeps: overrides.substeps,
    };
  }
  if (overrides.forClause !== undefined) {
    return {
      kind: 'for',
      ...base,
      forClause: overrides.forClause,
      substeps: overrides.substeps ?? [],
    };
  }
  if (Array.isArray(overrides.substeps) && overrides.substeps.length > 0) {
    return {
      kind: 'substeps',
      ...base,
      substeps: overrides.substeps,
    };
  }
  if (overrides.command !== undefined) {
    return {
      kind: 'command',
      ...base,
      command: overrides.command,
    };
  }
  return {
    kind: 'base',
    ...base,
  };
}

function makeSubstep(id: string, description: string): Substep {
  return { id, description, transitions: DEFAULT_TRANSITIONS };
}

function makeNumericFor(start: number, end: number, variable = 'x'): ForClause {
  return { variable, start, end };
}

beforeEach(() => {
  jest.resetAllMocks();
  // Re-establish default mock implementations after reset
  jest
    .mocked(core.stepIdToString)
    .mockImplementation((id) => (id.substep ? `${id.step}.${id.substep}` : id.step));
  jest.mocked(core.deriveGotoActionBlock).mockImplementation(({ target }) => ({
    action: `GOTO ${target.substep ? `${target.step}.${target.substep}` : target.step}`,
    from: '1',
    at: target.step,
  }));
  jest.mocked(driveRunProgression).mockResolvedValue({
    kind: 'waiting',
    runId: DEFAULT_RUNBOOK_ID,
    reason: 'awaiting_input',
  });
  jest.mocked(progressionFailedClosed).mockImplementation(failedClosed);
});

// ACCEPTED MUTATION SURVIVORS in goto-workflow.ts (#485).
//
//  - The `default:` arm of `executeGoto`'s refusal switch (`goto-workflow.ts:394`),
//    `ConditionalExpression` + `BlockStatement`. Unreachable by construction: the
//    arm exists only to bind `const _exhaustive: never = mutation`, so reaching it
//    is a compile error, not a runtime state a test could drive.

describe('buildGotoContext', () => {
  const manager = { load: jest.fn() } as unknown as RunbookStateManager;
  const resolveRunNavigation = mockFn<RunbookLifecycleCommandService['resolveRunNavigation']>();
  const seam = { resolveRunNavigation } as unknown as RunbookLifecycleCommandService;
  const output = {} as OutputEmitter;
  const state = { id: DEFAULT_RUNBOOK_ID, step: '1', lifecycle: 'running' } as RunbookState;
  const run = { state, stateVersion: 2 as never };

  beforeEach(() => {
    jest.mocked(buildLifecycleSeam).mockReturnValue({ manager, seam });
    mockResolveOwnedRun.mockReset();
    resolveRunNavigation.mockReset();
  });

  it('resolves the token through core and hands the owned run to the navigation seam', async () => {
    mockResolveOwnedRun.mockResolvedValue({ kind: 'running', run });
    const navigation = { authority: { runId: DEFAULT_RUNBOOK_ID }, steps: [], run } as never;
    resolveRunNavigation.mockResolvedValue({
      kind: 'allowed',
      runId: DEFAULT_RUNBOOK_ID,
      state,
      navigation,
    });

    const result = await buildGotoContext(output, '/cwd', {
      token: TOKEN,
      commandStreamOptions: { commandOutput: 'stderr' },
    });

    expect(mockResolveOwnedRun).toHaveBeenCalledWith(manager, TOKEN);
    expect(resolveRunNavigation.mock.calls).toEqual([[{ run }]]);
    expect(result.kind).toBe('ready');
    if (result.kind === 'ready') {
      expect(result.ctx.output).toBe(output);
      expect(result.ctx.manager).toBe(manager);
      expect(result.ctx.seam).toBe(seam);
      expect(result.ctx.state).toBe(state);
      expect(result.ctx.cwd).toBe('/cwd');
      expect(result.ctx.commandStreamOptions).toEqual({ commandOutput: 'stderr' });
      expect(result.ctx.navigation).toBe(navigation);
    }
  });

  it('passes an unknown_token resolution straight through without reaching the seam', async () => {
    mockResolveOwnedRun.mockResolvedValue({ kind: 'unknown_token' });

    const result = await buildGotoContext(output, '/cwd', { token: TOKEN });

    expect(result).toEqual({ kind: 'unknown_token' });
    expect(resolveRunNavigation).not.toHaveBeenCalled();
  });

  it('passes a finished resolution straight through without reaching the seam', async () => {
    mockResolveOwnedRun.mockResolvedValue({ kind: 'finished', state, lifecycle: 'completed' });

    const result = await buildGotoContext(output, '/cwd', { token: TOKEN });

    expect(result).toEqual({ kind: 'finished', state, lifecycle: 'completed' });
    expect(resolveRunNavigation).not.toHaveBeenCalled();
  });

  it('passes a run_finished seam refusal straight through', async () => {
    mockResolveOwnedRun.mockResolvedValue({ kind: 'running', run });
    resolveRunNavigation.mockResolvedValue({
      kind: 'run_finished',
      runId: DEFAULT_RUNBOOK_ID,
      lifecycle: 'stopped',
    });

    const result = await buildGotoContext(output, '/cwd', { token: TOKEN });

    expect(result).toEqual({
      kind: 'run_finished',
      runId: DEFAULT_RUNBOOK_ID,
      lifecycle: 'stopped',
    });
  });
});

describe('renderNavigationRefusal', () => {
  /** Recording OutputEmitter double capturing the rendered envelope. */
  function refusalEmitter(): {
    output: OutputEmitter;
    errors: readonly unknown[][];
    noActive: readonly unknown[][];
  } {
    const errors: unknown[][] = [];
    const noActive: unknown[][] = [];
    const output = {
      error: (...args: unknown[]) => errors.push(args),
      noActiveRunbook: (...args: unknown[]) => noActive.push(args),
    } as unknown as OutputEmitter;
    return { output, errors, noActive };
  }

  it('renders unknown_token as UNKNOWN_TOKEN, exit non-zero', () => {
    const { output, errors } = refusalEmitter();

    expect(renderNavigationRefusal(output, { kind: 'unknown_token' })).toBe(true);
    expect(errors[0]?.[1]).toBe('UNKNOWN_TOKEN');
    expect(errors[0]?.[0]).toContain('owner_token');
  });

  it('renders a finished resolution as RD-303 / RD-304 naming goto and the lifecycle', () => {
    const state = { id: DEFAULT_RUNBOOK_ID } as RunbookState;
    const completed = refusalEmitter();
    expect(
      renderNavigationRefusal(completed.output, {
        kind: 'finished',
        state,
        lifecycle: 'completed',
      }),
    ).toBe(true);
    expect(completed.errors[0]?.[1]).toBe('RD-303');
    expect(completed.errors[0]?.[0]).toContain('rundown goto');
    expect(completed.errors[0]?.[2]).toEqual({ runId: DEFAULT_RUNBOOK_ID, lifecycle: 'completed' });

    const stopped = refusalEmitter();
    expect(
      renderNavigationRefusal(stopped.output, { kind: 'finished', state, lifecycle: 'stopped' }),
    ).toBe(true);
    expect(stopped.errors[0]?.[1]).toBe('RD-304');
  });

  it('renders the seam run_finished refusal the same way', () => {
    const { output, errors } = refusalEmitter();

    expect(
      renderNavigationRefusal(output, {
        kind: 'run_finished',
        runId: DEFAULT_RUNBOOK_ID,
        lifecycle: 'abandoned',
      }),
    ).toBe(true);
    expect(errors[0]?.[1]).toBe('RD-304');
    expect(errors[0]?.[2]).toEqual({ runId: DEFAULT_RUNBOOK_ID, lifecycle: 'abandoned' });
  });

  it('names the invoking command, so the run --prompted --step path does not say goto', () => {
    // `run --prompted --step` routes its launch-local jump through this same
    // navigation seam. The remedial advice is identical either way, but naming
    // `rundown goto` to someone who typed `rundown run` points at a command
    // they never invoked.
    const { output, errors } = refusalEmitter();

    expect(
      renderNavigationRefusal(
        output,
        { kind: 'run_finished', runId: DEFAULT_RUNBOOK_ID, lifecycle: 'completed' },
        'run',
      ),
    ).toBe(true);
    expect(errors[0]?.[0]).toContain('rundown run');
    expect(errors[0]?.[0]).not.toContain('rundown goto');
  });

  it('fails closed on an unrecognized kind rather than exiting zero', () => {
    const { output, errors, noActive } = refusalEmitter();

    // Unreachable through the typed API — the union is exhausted above. Reachable
    // from an untyped frontend, or from a core version that adds a refusal this
    // build does not know. The exhaustiveness guard's runtime consequence is what
    // matters: the caller must still exit non-zero. A guard that fell through
    // would return undefined and silently succeed, turning an unknown refusal
    // into a successful goto.
    const exitError = renderNavigationRefusal(output, {
      kind: 'unrecognized_future_refusal',
    } as unknown as Parameters<typeof renderNavigationRefusal>[1]);

    // `toBe(true)`, not `toBeTruthy()`: the signature promises a boolean, so the
    // unreachable arm must honour it too. A truthiness assertion would also pass
    // for an arm that returned the refusal object, leaving a `=== true` call
    // site free to break on it.
    expect(exitError).toBe(true);
    // Nothing is rendered for a kind we cannot describe — no guessed envelope.
    expect(errors).toEqual([]);
    expect(noActive).toEqual([]);
  });
});

describe('validateGotoTarget', () => {
  it('rejects invalid format', () => {
    jest.mocked(core.parseStepIdFromString).mockReturnValue(null);

    const result = validateGotoTarget('abc', [makeStep()]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_SYNTAX');
      expect(result.details).toEqual({ provided: 'abc' });
    }
  });

  it('rejects missing step', () => {
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '99' });

    const steps = [makeStep({ name: '1' }), makeStep({ name: '2' })];
    const result = validateGotoTarget('99', steps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('STEP_NOT_FOUND');
      expect(result.details?.available).toEqual(['1', '2']);
    }
  });

  it('rejects AT on non-FOR step', () => {
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', at: 3 });

    const steps = [makeStep({ name: '1' })]; // No forClause
    const result = validateGotoTarget('1', steps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_AT_TARGET');
    }
  });

  it('accepts AT on FOR step', () => {
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', at: 3 });

    const steps = [makeStep({ name: '1', forClause: makeNumericFor(1, 5) })];
    const result = validateGotoTarget('1', steps);

    expect(result.ok).toBe(true);
  });

  it('rejects substep on step without substeps', () => {
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', substep: '2' });

    const steps = [makeStep({ name: '1' })]; // No substeps
    const result = validateGotoTarget('1.2', steps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('STEP_NOT_FOUND');
    }
  });

  it('rejects nonexistent substep', () => {
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', substep: '3' });

    const steps = [
      makeStep({
        name: '1',
        substeps: [makeSubstep('1', 'Sub 1'), makeSubstep('2', 'Sub 2')],
      }),
    ];
    const result = validateGotoTarget('1.3', steps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('STEP_NOT_FOUND');
      expect(result.details?.available).toEqual(['1', '2']);
    }
  });

  it('accepts substep target on prompted-for step', () => {
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', substep: '1' });

    const steps = [
      makeStep({
        name: '1',
        kind: 'prompted-for',
        substeps: [makeSubstep('1', 'Sub 1'), makeSubstep('2', 'Sub 2')],
      }),
    ];
    const result = validateGotoTarget('1.1', steps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target).toEqual({ step: '1', substep: '1' });
    }
  });

  it('rejects AT on prompted-for step', () => {
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', at: 3 });

    const steps = [
      makeStep({
        name: '1',
        kind: 'prompted-for',
        substeps: [makeSubstep('1', 'Sub 1')],
      }),
    ];
    const result = validateGotoTarget('1', steps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_AT_TARGET');
    }
  });

  it('accepts valid step', () => {
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '2' });

    const steps = [makeStep({ name: '1' }), makeStep({ name: '2' })];
    const result = validateGotoTarget('2', steps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target).toEqual({ step: '2' });
    }
  });

  it('accepts self-referencing GOTO as valid target', () => {
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1' });

    const steps = [makeStep({ name: '1' }), makeStep({ name: '2' })];
    const result = validateGotoTarget('1', steps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target).toEqual({ step: '1' });
    }
  });

  it('accepts valid substep', () => {
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', substep: '2' });

    const steps = [
      makeStep({
        name: '1',
        substeps: [makeSubstep('1', 'Sub 1'), makeSubstep('2', 'Sub 2')],
      }),
    ];
    const result = validateGotoTarget('1.2', steps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target).toEqual({ step: '1', substep: '2' });
    }
  });

  describe('--index option', () => {
    it('sets target.at from --index on FOR step', () => {
      jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1' });

      const steps = [makeStep({ name: '1', forClause: makeNumericFor(1, 5) })];
      const result = validateGotoTarget('1', steps, '3');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.target.at).toBe(3);
      }
    });

    it('rejects --index on non-FOR step', () => {
      jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1' });

      const steps = [makeStep({ name: '1' })]; // No forClause
      const result = validateGotoTarget('1', steps, '3');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_AT_TARGET');
      }
    });

    it('rejects conflicting --index and AT', () => {
      jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', at: 5 });

      const steps = [makeStep({ name: '1', forClause: makeNumericFor(1, 10) })];
      const result = validateGotoTarget('1 AT 5', steps, '3');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('CONFLICTING_INDEX');
      }
    });

    it('accepts matching --index and AT (idempotent)', () => {
      jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', at: 3 });

      const steps = [makeStep({ name: '1', forClause: makeNumericFor(1, 5) })];
      const result = validateGotoTarget('1 AT 3', steps, '3');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.target.at).toBe(3);
      }
    });

    it('rejects invalid --index value', () => {
      jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1' });

      const steps = [makeStep({ name: '1', forClause: makeNumericFor(1, 5) })];
      const result = validateGotoTarget('1', steps, 'abc');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_SYNTAX');
      }
    });
  });
});

describe('executeGoto', () => {
  // Build a state for the goto context. Includes the minimum required RunbookState
  // fields; tests exercise only the specific fields each path consults.
  function makeState(overrides: Partial<RunbookState> = {}): RunbookState {
    return {
      templateVars: brandInitialTemplateVarsForTest({}),
      id: DEFAULT_RUNBOOK_ID,
      runbook: { source: 'project', path: 'test.md' },
      runbookPath: 'test.md',
      step: '1',
      stepName: 'Step 1',
      retryCount: 0,
      variables: {} as RunbookState['variables'],
      steps: [],
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      prompted: false,
      ...overrides,
    };
  }

  const gotoSteps = [makeStep({ name: '1' }), makeStep({ name: '2' })];
  const navigation = {
    authority: { runId: DEFAULT_RUNBOOK_ID },
    steps: gotoSteps,
  } as unknown as LifecycleNavigationCapability;
  const progressionDirective = {
    kind: 'activate',
    authority: navigation.authority,
    runbook: { source: 'project', path: 'goto.runbook.md' },
    steps: navigation.steps,
    entryBoundary: { kind: 'after_observed_transition', lifecycle: 'running' },
  } as const satisfies Extract<RunProgressionDirective, { kind: 'activate' }>;
  const waitingProgression = {
    kind: 'waiting',
    runId: DEFAULT_RUNBOOK_ID,
    reason: 'awaiting_input',
  } as const satisfies RunProgressionOutcome;

  function appliedMutation(): Extract<LifecycleNavigationMutationOutcome, { kind: 'applied' }> {
    return {
      kind: 'applied',
      runId: DEFAULT_RUNBOOK_ID,
      previousState: makeState(),
      updatedState: makeState({ step: '2' }),
      snapshot: {},
      progression: progressionDirective,
    };
  }

  // The one refusal the navigation mutation can return under one writer per
  // run: a conditional save that found the row moved. The message is forwarded
  // verbatim alongside the code, not merely "the goto failed".
  it.each<{
    readonly label: string;
    readonly outcome: NavigationRefusal;
    readonly code: string;
  }>([
    {
      label: 'a concurrent state change',
      outcome: {
        kind: 'concurrent_modification',
        runId: DEFAULT_RUNBOOK_ID,
        message: 'The run changed while this goto was deciding.',
      },
      code: 'CONCURRENT_MODIFICATION',
    },
  ])('returns $code when the fenced core mutation refuses with $label', async (refusal) => {
    const update = mockFn<RunbookStateManager['update']>();
    const runNavigationMutation = mockFn<RunbookLifecycleCommandService['runNavigationMutation']>();
    runNavigationMutation.mockResolvedValue(refusal.outcome);

    const ctx = {
      output: {
        action: jest.fn(),
        flush: jest.fn(),
      } as unknown as OutputEmitter,
      manager: {
        update,
        load: mockFn<RunbookStateManager['load']>().mockResolvedValue(null),
      } as unknown as RunbookStateManager,
      seam: { runNavigationMutation } as unknown as RunbookLifecycleCommandService,
      state: makeState(),
      steps: [makeStep()],
      cwd: '/test',
      navigation,
    };

    const result = await executeGoto(ctx, { step: '2' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(refusal.code);
      expect(result.error).toBe(refusal.outcome.message);
    }
    // A refused navigation must not write: the fence owns the commit, so a CLI
    // fallback write would be the shadow persistence path the fence replaced.
    expect(update).not.toHaveBeenCalled();
  });

  it('renders GOTO before forwarding the core directive verbatim to shared progression', async () => {
    const update = mockFn<RunbookStateManager['update']>();
    update.mockImplementation(async (_id, _patch) => makeState({ step: '2' }));
    const runNavigationMutation = mockFn<RunbookLifecycleCommandService['runNavigationMutation']>();
    runNavigationMutation.mockResolvedValue(appliedMutation());
    jest.mocked(driveRunProgression).mockResolvedValue(waitingProgression);

    const action = jest.fn();
    const ctx = {
      output: {
        action,
        flush: jest.fn(),
      } as unknown as OutputEmitter,
      manager: {
        update,
        load: mockFn<RunbookStateManager['load']>().mockResolvedValue(null),
      } as unknown as RunbookStateManager,
      seam: { runNavigationMutation } as unknown as RunbookLifecycleCommandService,
      state: makeState(),
      steps: [makeStep({ name: '1' }), makeStep({ name: '2' })],
      cwd: '/test',
      navigation,
    };

    const target: StepId = { step: '2' };
    const result = await executeGoto(ctx, target);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.progression).toEqual(waitingProgression);
    }
    expect(action).toHaveBeenCalled();
    expect(runNavigationMutation).toHaveBeenCalledTimes(1);
    // The seam applies the GOTO from this input alone — the CLI performs no
    // navigation write of its own — so an input that silently lost a field
    // would hand the seam a different mutation.
    expect(runNavigationMutation.mock.calls[0]?.[0]).toEqual({ navigation, target });
    expect(driveRunProgression).toHaveBeenCalledWith(
      progressionDirective,
      expect.objectContaining({ manager: ctx.manager, cwd: '/test' }),
    );
    expect(jest.mocked(driveRunProgression).mock.calls[0]?.[1]).not.toHaveProperty('steps');
    expect(action.mock.invocationCallOrder[0]).toBeLessThan(
      jest.mocked(driveRunProgression).mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(update).not.toHaveBeenCalledWith(
      DEFAULT_RUNBOOK_ID,
      expect.objectContaining({ lastAction: expect.anything() }),
    );
  });

  it('does not call clearLastResult after core GOTO synchronization', async () => {
    const clearLastResult = jest.fn(async () => undefined);
    const runNavigationMutation = mockFn<RunbookLifecycleCommandService['runNavigationMutation']>();
    runNavigationMutation.mockResolvedValue(appliedMutation());

    const outputAction = jest.fn();
    const output = {
      action: outputAction,
      flush: jest.fn(),
    } as unknown as OutputEmitter;
    const ctx = {
      output,
      manager: {
        load: mockFn<RunbookStateManager['load']>().mockResolvedValue(null),
      } as unknown as RunbookStateManager,
      seam: { runNavigationMutation } as unknown as RunbookLifecycleCommandService,
      state: makeState(),
      steps: [makeStep({ name: '1' }), makeStep({ name: '2' })],
      cwd: '/test',
      navigation,
    };

    const result = await executeGoto(ctx, { step: '2' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.progression).toEqual(waitingProgression);
    }
    expect(clearLastResult).not.toHaveBeenCalled();
    expect(outputAction).toHaveBeenCalledWith({
      action: 'GOTO 2',
      from: '1',
      at: '2',
    });
  });

  it('returns the shared progression stopped outcome without a second terminal branch', async () => {
    const update = mockFn<RunbookStateManager['update']>();
    update.mockImplementation(async (_id, _patch) => makeState({ step: '2' }));
    const runNavigationMutation = mockFn<RunbookLifecycleCommandService['runNavigationMutation']>();
    runNavigationMutation.mockResolvedValue(appliedMutation());
    jest.mocked(driveRunProgression).mockResolvedValue({
      kind: 'stopped',
      runId: DEFAULT_RUNBOOK_ID,
    });

    const ctx = {
      output: {
        action: jest.fn(),
        flush: jest.fn(),
      } as unknown as OutputEmitter,
      manager: {
        update,
        load: mockFn<RunbookStateManager['load']>().mockResolvedValue(null),
      } as unknown as RunbookStateManager,
      seam: { runNavigationMutation } as unknown as RunbookLifecycleCommandService,
      state: makeState(),
      steps: [makeStep({ name: '1' }), makeStep({ name: '2' })],
      cwd: '/test',
      navigation,
    };

    const result = await executeGoto(ctx, { step: '2' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.progression).toEqual({
        kind: 'stopped',
        runId: DEFAULT_RUNBOOK_ID,
      });
    }
  });
});

describe('gotoResultRequiresFailureExit', () => {
  // GOTO delegates the exit decision to the same predicate used by every
  // directive-driven frontend; it does not reinterpret terminal propagation.
  type OkResult = Parameters<typeof gotoResultRequiresFailureExit>[0];

  it.each([
    [{ kind: 'waiting', runId: DEFAULT_RUNBOOK_ID, reason: 'awaiting_input' }, false],
    [{ kind: 'completed', runId: DEFAULT_RUNBOOK_ID }, false],
    [{ kind: 'stopped', runId: DEFAULT_RUNBOOK_ID }, true],
    [
      {
        kind: 'refused',
        runId: DEFAULT_RUNBOOK_ID,
        reason: 'run_missing',
        message: 'the run no longer exists',
        recovery: 'permanent',
      },
      true,
    ],
  ] as const)('returns %s for progression %p', (progression, expected) => {
    const result: OkResult = { ok: true, progression };
    expect(gotoResultRequiresFailureExit(result)).toBe(expected);
    expect(progressionFailedClosed).toHaveBeenLastCalledWith(progression);
  });
});
