import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type {
  ExecutionEventEmitter,
  ExecutionLifecycleService,
  ReleaseRunbookResult,
  RunbookActorService,
  RunbookStateManager,
  RunId,
  SessionMutationResult,
} from '@rundown-org/core';
import type { ResolvedStep } from '@rundown-org/parser';
import type { ExecutionTerminalReleaseMode } from '../../src/services/execution.js';
import { mockFn } from '../helpers/typed-mocks.js';
import { committed } from '../helpers/session-mutation-fixtures.js';

// The recovery-required refusal arm, so a fixture epoch carries core's brand
// without core having to export it. Reaching it through the union also means a
// change to the arm surfaces here rather than in a cast that keeps compiling.
type RecoveryRefusal = Extract<
  SessionMutationResult<ReleaseRunbookResult>,
  { readonly kind: 'recovery_required' }
>;

// Permissive runbook-state shape used by lifecycle / actor mocks. The real
// runtime types include branded fields whose constructors are tied to the
// state machine; tests only need to flow `step`, `activeEntry`, and
// `activeFrameKey` through, so we narrow to a small structural surface.
type LifecycleStateLike = {
  step?: string;
  activeEntry?: number;
  activeFrameKey?: string;
  [key: string]: unknown;
};

// Mock dependencies
const mockActorService = {
  sendAndSync: mockFn<
    (id: string, steps: unknown, event: unknown) => Promise<Record<string, unknown>>
  >() as any,
  getContextSnapshot: mockFn<
    (id: string, steps: unknown) => Promise<Record<string, unknown> | null>
  >() as any,
  observeExecutionUnitEntry: mockFn<
    (id: string, steps: unknown, entry: Record<string, unknown>) => Promise<unknown[]>
  >() as any,
  prepareActorMutation: mockFn<RunbookActorService['prepareActorMutation']>(),
};

const mockActorMutationRunner = {
  run: mockFn<
    (input: {
      runId: string;
      compute: (state: Record<string, unknown>) => Promise<{
        previousState: Record<string, unknown>;
        nextState: Record<string, unknown>;
        snapshot: unknown;
        effects: unknown[];
      }>;
    }) => Promise<Record<string, unknown>>
  >(),
};

const mockSessionService = {
  getActive: mockFn<() => Promise<{ id: string } | null>>().mockResolvedValue(null),
  pushRunbook: mockFn<(id: string) => Promise<void>>().mockResolvedValue(undefined),
  popRunbook: mockFn<() => Promise<unknown>>().mockResolvedValue(committed(null)),
  releaseRunbook:
    mockFn<
      (
        id: RunId,
        options?: { readonly retainClaimsAsTerminal?: boolean },
      ) => Promise<SessionMutationResult<ReleaseRunbookResult>>
    >(),
};

const ensureActiveEntryFn =
  mockFn<
    (
      id: string,
      prev: unknown,
      state: LifecycleStateLike | null | undefined,
    ) => Promise<{ state: LifecycleStateLike; frameKey: string; entry: number }>
  >();
ensureActiveEntryFn.mockImplementation(async (_id, _prev, state) => ({
  state: {
    ...(state ?? {}),
    activeEntry: state?.activeEntry ?? 1,
    activeFrameKey: `${state?.step ?? '1'}|`,
  },
  frameKey: `${state?.step ?? '1'}|`,
  entry: state?.activeEntry ?? 1,
}));
const listResolvedCompletionsFn = mockFn<(id: string) => Promise<unknown[]>>();
listResolvedCompletionsFn.mockResolvedValue([]);
const consumeResolvedCompletionFn = mockFn<(id: string) => Promise<unknown>>();
consumeResolvedCompletionFn.mockResolvedValue(null);
const completionDrainResolvedCompletionsFn =
  mockFn<(args: Record<string, unknown>) => Promise<Record<string, unknown>>>();
const recordChildCompletionFn =
  mockFn<(args: Record<string, unknown>) => Promise<'recorded' | 'blocked'>>();
const mockCompletionService = {
  drainResolvedCompletions: completionDrainResolvedCompletionsFn,
  recordChildCompletion: recordChildCompletionFn,
};

const mockLifecycleService = {
  setLastResult: jest.fn() as any,
  ensureActiveEntry: ensureActiveEntryFn,
  deriveActiveEntry: mockFn<ExecutionLifecycleService['deriveActiveEntry']>(),
  listResolvedCompletions: listResolvedCompletionsFn,
  consumeResolvedCompletion: consumeResolvedCompletionFn,
};

// Capture the real @rundown-org/core module before the mock is registered.
// jest.unstable_mockModule does NOT hoist (unlike jest.mock), so this top-level
// await executes first and captures the real implementations. The mock factory
// then closure-captures `actualCore` and spreads it — `await import` inside the
// factory would recurse through the registered mock and OOM the heap.
const actualCore = await import('@rundown-org/core');

jest.unstable_mockModule('@rundown-org/core', () => {
  return {
    ...actualCore,
    // I/O — fork shell processes
    executeCommand: jest.fn(),
    executeCommandWithEnv: (jest.fn() as any).mockResolvedValue({ success: true, exitCode: 0 }),
    executeCommandWithPolicy: jest.fn(),

    // Pass/fail evaluators — introspected via jest.mocked(core.evaluate*Condition)
    evaluatePassCondition: jest.fn(),
    evaluateFailCondition: jest.fn(),

    // Print / terminal output
    printActionBlock: jest.fn(),
    printStepBlock: jest.fn(),
    printStepSeparator: jest.fn(),
    printCommandExec: jest.fn(),
    printRunbookComplete: jest.fn(),
    printRunbookStoppedAtStep: jest.fn(),
    printPolicyDenied: jest.fn(),

    // Actor / session / lifecycle services — replaced by test doubles
    RunbookActorService: jest.fn(() => mockActorService),
    createEffectfulActorMutationRunner: jest.fn(() => mockActorMutationRunner),
    SessionService: jest.fn(() => mockSessionService),
    ExecutionLifecycleService: jest.fn(() => mockLifecycleService),
    RunbookCompletionService: jest.fn(() => mockCompletionService),
    // Delegation factory — introspected via jest.mocked(core.createDelegation)
    createDelegation: jest.fn(),

    // Run-id generator — deterministic for assertions
    generateRunId: jest.fn(() => 'rd_0123456789abcdef0123456789abcdef'),

    // Resolver — depends on filesystem in real impl
    resolveCurrentExecutionUnit: jest.fn((step: any, substepId: string | undefined) => {
      if (!substepId || !Array.isArray(step?.substeps)) return step;
      return step.substeps.find((s: any) => s.id === substepId) ?? step;
    }),
  };
});

jest.unstable_mockModule('../../src/helpers/resolve-runbook', () => ({
  resolveRunbookFile: (jest.fn() as any).mockResolvedValue(null),
  buildRunbookRef: jest.fn((resolved: { source: string; path: string; sourceRoot?: string }) => ({
    source: resolved.source,
    path:
      resolved.sourceRoot && resolved.path.startsWith(`${resolved.sourceRoot}/`)
        ? resolved.path.slice(resolved.sourceRoot.length + 1)
        : resolved.path,
  })),
}));

jest.unstable_mockModule('../../src/services/internal-commands', () => ({
  isInternalRdCommand: (jest.fn() as any).mockReturnValue(false),
  executeRdCommandInternal: jest.fn(),
}));

jest.unstable_mockModule('../../src/services/policy-context', () => ({
  getPolicyEvaluator: jest.fn(),
  getPolicyPrompter: jest.fn(),
  isPolicyEnforced: (jest.fn() as any).mockReturnValue(false),
  getSandboxOptions: (jest.fn() as any).mockReturnValue({ sandbox: true, sandboxStrict: false }),
}));

// Import after mocking
const core = await import('@rundown-org/core');
const policyContext = await import('../../src/services/policy-context.js');
const { getHelperRegistry, resetHelperRegistry, setHelperRegistry } = await import(
  '../../src/services/helper-registry.js'
);
const { runExecutionLoop, executeCommandWithPolicyCheck, drainResolvedCompletions } = await import(
  '../../src/services/execution.js'
);
const mockedPolicyContext = jest.mocked(policyContext);

// Production types — used solely for the `as unknown as` casts below.
type RunbookStateManagerType = RunbookStateManager;
type ExecutionEventEmitterType = ExecutionEventEmitter;
type ResolvedStepType = ResolvedStep;

// Permissive shapes used in tests to seed the loop. Real types live in core
// (RunbookStateManager, ExecutionEventEmitter, ResolvedStep) but the tests
// only exercise narrow surfaces — typing those surfaces structurally keeps
// the test in line with what `runExecutionLoop` actually inspects.
type LoadFn = jest.Mock<(id: string) => Promise<Record<string, unknown> | null>>;
type UpdateFn = jest.Mock<(id: string, patch: Record<string, unknown>) => Promise<void>>;
type EmitFn = jest.Mock<(input: { type: string; payload?: unknown }) => void>;
type MockManagerLike = {
  cwd: string;
  load: LoadFn;
  update: UpdateFn;
  delete: jest.Mock<(id: string) => Promise<void>>;
};
type MockEmitterLike = {
  emit: EmitFn;
};
// `unknown` is the strongest type we can give the steps array without
// hand-rolling every ResolvedStep variant — the loop receives them via
// `as ResolvedStep[]` casts at call sites.
type LooseStep = Record<string, unknown>;

/**
 * Narrow `as unknown as` cast for the mock manager. The runbook state
 * manager has dozens of fields the loop never inspects on this code path;
 * the mock only stubs `load` and `update`. Casting at the call site keeps
 * this explicit at every invocation rather than smuggling it into the
 * mock's own type. Same idea applies to the emitter and steps casts.
 */
const asManager = (m: MockManagerLike): RunbookStateManagerType =>
  m as unknown as RunbookStateManagerType;
const asEmitter = (e: MockEmitterLike): ExecutionEventEmitterType =>
  e as unknown as ExecutionEventEmitterType;
const asSteps = (s: readonly LooseStep[]): ResolvedStepType[] => s as unknown as ResolvedStepType[];

describe('runExecutionLoop', () => {
  let mockManager: MockManagerLike;
  let mockEmitter: MockEmitterLike;
  const runbookId = actualCore.assertRunId(`rd_${'1'.repeat(32)}`);
  const steps: LooseStep[] = [
    {
      kind: 'command',
      name: '1',
      description: 'Step 1',
      command: { code: 'echo hello', lang: 'sh' },
      transitions: {
        pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' }, next: '2' },
        fail: { kind: 'fail', retry: 0, action: { type: 'STOP' }, next: 'STOP' },
      },
    },
    {
      kind: 'command',
      name: '2',
      description: 'Step 2',
      command: { code: 'echo world', lang: 'sh' },
      transitions: {
        pass: {
          kind: 'pass',
          retry: 0,
          action: { type: 'COMPLETE', message: 'Success' },
          next: 'COMPLETE',
        },
        fail: { kind: 'fail', retry: 0, action: { type: 'STOP' }, next: 'STOP' },
      },
    },
  ];
  const makeLoopState = (
    step = '1',
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => {
    const baseTemplateVars = {
      RunId: runbookId,
      RunbookRef: { source: 'project', path: 'test.runbook.md' },
      ContextId: 'ctx-unit',
      WorkPath: '.rundown/work',
    };
    return {
      id: runbookId,
      runbook: { source: 'project', path: 'test.runbook.md' },
      runbookPath: 'test.runbook.md',
      step,
      status: 'running',
      ...overrides,
      templateVars: {
        ...baseTemplateVars,
        ...(overrides.templateVars ?? {}),
      },
    };
  };
  const commandCompletedEffect = (result: 'pass' | 'fail' = 'pass') => ({
    kind: 'execution_observation',
    event: {
      type: 'COMMAND_COMPLETED',
      payload: {
        command: 'echo hello',
        success: result === 'pass',
        exitCode: result === 'pass' ? 0 : 1,
        position: { current: '1', total: 2 },
      },
    },
    commandOutput: {
      kind: 'completed',
      command: 'echo hello',
      displayCommand: 'echo hello',
      success: result === 'pass',
      result,
      exitCode: result === 'pass' ? 0 : 1,
      channels: [],
    },
  });
  const policyDeniedEffect = (reason = 'Not allowed') => ({
    kind: 'execution_observation',
    event: {
      type: 'POLICY_DENIED',
      payload: {
        command: 'echo hello',
        reason,
        position: { current: '1', total: 2 },
      },
    },
    commandOutput: {
      kind: 'policy_denied',
      command: 'echo hello',
      displayCommand: 'echo hello',
      success: false,
      exitCode: 126,
      policyDenied: true,
      denialReason: reason,
      channels: [],
    },
  });
  const commandStartedEffectFixture = () => ({
    kind: 'execution_observation' as const,
    event: {
      type: 'COMMAND_STARTED' as const,
      payload: {
        command: 'echo hello',
        displayCommand: 'echo hello',
        position: { current: '1', total: 2 },
      },
    },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    resetHelperRegistry();

    mockedPolicyContext.isPolicyEnforced.mockReturnValue(false);
    mockedPolicyContext.getSandboxOptions.mockReturnValue({ sandbox: true, sandboxStrict: false });
    mockedPolicyContext.getPolicyEvaluator.mockReturnValue({
      setRunbookPath: jest.fn(),
    } as unknown as ReturnType<typeof policyContext.getPolicyEvaluator>);
    mockedPolicyContext.getPolicyPrompter.mockReturnValue(
      {} as unknown as ReturnType<typeof policyContext.getPolicyPrompter>,
    );
    (core.executeCommand as any).mockReset();
    (core.executeCommandWithPolicy as any).mockReset();

    mockManager = {
      cwd: process.env.TMPDIR ?? '/tmp',
      load: mockFn<(id: string) => Promise<Record<string, unknown> | null>>(),
      update: mockFn<(id: string, patch: Record<string, unknown>) => Promise<void>>(),
      delete: mockFn<(id: string) => Promise<void>>(),
    };
    mockManager.update.mockResolvedValue(undefined);
    mockManager.delete.mockResolvedValue(undefined);

    mockLifecycleService.ensureActiveEntry.mockReset();
    mockLifecycleService.ensureActiveEntry.mockImplementation(
      async (_id: string, _prev: unknown, state: any) => ({
        state: {
          ...(state ?? {}),
          activeEntry: state?.activeEntry ?? 1,
          activeFrameKey: `${String(state?.step ?? '1')}|`,
        },
        frameKey: `${String(state?.step ?? '1')}|`,
        entry: state?.activeEntry ?? 1,
      }),
    );
    mockLifecycleService.deriveActiveEntry.mockReset();
    mockLifecycleService.deriveActiveEntry.mockImplementation((state) => {
      const step = state.step;
      const frameKey = actualCore.buildFrameKey(step);
      const entry = state.activeEntry ?? 1;
      return {
        state: {
          ...state,
          activeEntry: entry,
          activeFrameKey: frameKey,
        },
        frameKey,
        entry,
      };
    });
    mockLifecycleService.listResolvedCompletions.mockReset();
    mockLifecycleService.listResolvedCompletions.mockResolvedValue([]);
    mockLifecycleService.consumeResolvedCompletion.mockReset();
    mockLifecycleService.consumeResolvedCompletion.mockResolvedValue(null);
    mockCompletionService.drainResolvedCompletions.mockReset();
    mockCompletionService.drainResolvedCompletions.mockImplementation(async (args) => ({
      status: 'continue',
      state: args.currentState,
      unresolved: 0,
      applied: [],
    }));
    mockCompletionService.recordChildCompletion.mockReset();
    mockCompletionService.recordChildCompletion.mockResolvedValue('recorded');

    mockActorService.sendAndSync.mockReset();
    mockActorService.prepareActorMutation.mockReset();
    mockActorService.prepareActorMutation.mockImplementation(
      async (id, previousState, actorSteps, event) => {
        const synchronized = await mockActorService.sendAndSync(id, actorSteps, event);
        if (!synchronized) throw new Error('Actor synchronization failed');
        return {
          previousState,
          nextState: synchronized.state,
          snapshot: synchronized.snapshot,
          effects: synchronized.effects ?? [],
        };
      },
    );
    mockActorMutationRunner.run.mockReset();
    mockActorMutationRunner.run.mockImplementation(async (input) => {
      const capturedState = await mockManager.load(input.runId);
      if (!capturedState) {
        return { kind: 'missing', runId: input.runId, message: 'Runbook not found' };
      }
      const prepared = await input.compute(capturedState);
      return {
        kind: 'committed',
        value: {
          state: prepared.nextState,
          snapshot: prepared.snapshot,
          effects: prepared.effects,
        },
      };
    });
    mockActorService.getContextSnapshot.mockReset();
    mockActorService.getContextSnapshot.mockResolvedValue(null);
    mockActorService.observeExecutionUnitEntry.mockReset();
    mockActorService.observeExecutionUnitEntry.mockImplementation(
      async (id: string, steps: unknown, entry: Record<string, unknown>) => {
        const context = await mockActorService.getContextSnapshot(id, steps);
        return [
          {
            kind: 'execution_observation',
            event: {
              type: 'STEP_ENTERED',
              payload: {
                position: entry.position,
                stepName: entry.stepName,
                description: entry.description,
                prompt: entry.prompt,
                hasCommand: entry.commandCode !== undefined,
                commandCode: entry.commandCode,
                commandLang: entry.commandLang,
                isSubstep: entry.isSubstep,
                prompted: entry.prompted,
                artifacts:
                  context &&
                  typeof context === 'object' &&
                  'enteredArtifacts' in context &&
                  context.enteredArtifacts &&
                  typeof context.enteredArtifacts === 'object'
                    ? actualCore.toPublicArtifactMap(
                        context.enteredArtifacts as Parameters<
                          typeof actualCore.toPublicArtifactMap
                        >[0],
                        { cwd: '/tmp', workPath: actualCore.WORK_DIR },
                      )
                    : {},
                delegateFrontier: entry.delegateFrontier,
              },
            },
          },
        ];
      },
    );

    mockEmitter = {
      emit: mockFn<(input: { type: string; payload?: unknown }) => void>(),
    };
    mockSessionService.getActive.mockReset();
    mockSessionService.getActive.mockResolvedValue(null);
    mockSessionService.pushRunbook.mockReset();
    mockSessionService.pushRunbook.mockResolvedValue(undefined);
    mockSessionService.releaseRunbook.mockReset();
    mockSessionService.releaseRunbook.mockResolvedValue(
      committed({
        status: 'released',
        runbookId,
        removedFromDefaultStack: true,
        nextDefaultRunbookId: null,
      }),
    );
    mockSessionService.popRunbook.mockReset();
    mockSessionService.popRunbook.mockResolvedValue(committed(null));

    // Default evaluate behavior. ConditionResult requires `action`; the test
    // bodies only check the `message` field so we cast through `unknown` to
    // a partial — this asserts the test contract while still exercising the
    // real return type at the call site.
    jest
      .mocked(core.evaluatePassCondition)
      .mockReturnValue({ message: 'Success' } as unknown as ReturnType<
        typeof core.evaluatePassCondition
      >);
    jest
      .mocked(core.evaluateFailCondition)
      .mockReturnValue({ message: 'Failed' } as unknown as ReturnType<
        typeof core.evaluateFailCondition
      >);
  });

  it('renders runtime Step and helper expressions through the core renderer before command execution', () => {
    setHelperRegistry(new Map([['wrap', (value: string) => `[${value}]`]]));

    const result = core.expandLoopVariablesForCommand(
      'echo {{ wrap Step }}',
      { Step: '2.1' },
      { helpers: getHelperRegistry() },
    );

    expect(result).toBe("echo '[2.1]'");
  });

  it('stops if state cannot be loaded', async () => {
    mockManager.load.mockResolvedValue(null);
    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(steps),
      '/tmp',
      false,
      asEmitter(mockEmitter),
    );
    expect(result).toBe('stopped');
  });

  it('observes each drained completion before applying the next one', async () => {
    const order: string[] = [];
    const substepSteps: LooseStep[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Parent',
        aggregation: { strategy: 'ALL' },
        substeps: [
          {
            id: '1',
            description: 'First',
            transitions: {
              pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' }, next: '1.2' },
              fail: { kind: 'fail', retry: 0, action: { type: 'STOP' }, next: 'STOP' },
            },
          },
          {
            id: '2',
            description: 'Second',
            transitions: {
              pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' }, next: 'COMPLETE' },
              fail: { kind: 'fail', retry: 0, action: { type: 'STOP' }, next: 'STOP' },
            },
          },
        ],
        transitions: {
          pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' }, next: 'COMPLETE' },
          fail: { kind: 'fail', retry: 0, action: { type: 'STOP' }, next: 'STOP' },
        },
      },
    ];
    const beforeFirst = makeLoopState('1', {
      substep: '1',
      retryCount: 0,
      lifecycle: 'running',
      activeFrameKey: '1|',
      activeEntry: 1,
    });
    const afterFirst = makeLoopState('1', {
      substep: '2',
      retryCount: 0,
      lifecycle: 'running',
      activeFrameKey: '1|',
      activeEntry: 1,
    });
    const afterSecond = makeLoopState('1', {
      substep: undefined,
      retryCount: 0,
      lifecycle: 'running',
      activeFrameKey: '1|',
      activeEntry: 1,
    });

    mockCompletionService.drainResolvedCompletions
      .mockImplementationOnce(async (args) => {
        order.push('apply-1');
        expect(args).toEqual(expect.objectContaining({ currentState: beforeFirst, maxApplied: 1 }));
        return {
          status: 'continue',
          state: afterFirst,
          unresolved: 1,
          applied: [
            {
              key: '1|1|1',
              completion: { result: 'pass', targetSubstep: '1' },
              stateBefore: beforeFirst,
              stateAfter: afterFirst,
              snapshot: { status: 'active', context: { lastAction: { type: 'CONTINUE' } } },
            },
          ],
        };
      })
      .mockImplementationOnce(async (args) => {
        order.push('apply-2');
        expect(args).toEqual(expect.objectContaining({ currentState: afterFirst, maxApplied: 1 }));
        return {
          status: 'continue',
          state: afterSecond,
          unresolved: 0,
          applied: [
            {
              key: '1|1|2',
              completion: { result: 'pass', targetSubstep: '2' },
              stateBefore: afterFirst,
              stateAfter: afterSecond,
              snapshot: { status: 'active', context: { lastAction: { type: 'CONTINUE' } } },
            },
          ],
        };
      })
      .mockImplementationOnce(async (args) => {
        order.push('empty');
        expect(args).toEqual(expect.objectContaining({ currentState: afterSecond, maxApplied: 1 }));
        return {
          status: 'continue',
          state: afterSecond,
          unresolved: 0,
          applied: [],
        };
      });
    mockLifecycleService.ensureActiveEntry.mockImplementation(
      async (_id: string, previous: unknown, next: any) => {
        order.push(`observe-${String(next?.substep ?? 'step')}`);
        return {
          state: next,
          frameKey: '1|',
          entry: 1,
          previous,
        };
      },
    );

    const drained = await drainResolvedCompletions({
      actorService: mockActorService as any,
      manager: asManager(mockManager),
      sessionService: mockSessionService as any,
      lifecycleService: mockLifecycleService as any,
      emitter: asEmitter(mockEmitter),
      runbookId: runbookId,
      steps: asSteps(substepSteps),
      currentState: beforeFirst as any,
      transitionPolicy: {
        onComplete: { releaseRunbook: false },
        onStopped: { releaseRunbook: false },
      },
    });

    expect(drained).toEqual({
      status: 'continue',
      state: afterSecond,
      unresolved: 0,
      applied: 2,
    });
    expect(order).toEqual(['apply-1', 'observe-2', 'apply-2', 'observe-step', 'empty']);
    expect(mockLifecycleService.ensureActiveEntry).toHaveBeenNthCalledWith(
      1,
      runbookId,
      beforeFirst,
      afterFirst,
    );
    expect(mockLifecycleService.ensureActiveEntry).toHaveBeenNthCalledWith(
      2,
      runbookId,
      afterFirst,
      afterSecond,
    );
  });

  it('preserves unresolved completion count when draining fails', async () => {
    const currentState = makeLoopState('1', {
      lifecycle: 'running',
      activeFrameKey: '1|',
      activeEntry: 1,
    });

    mockCompletionService.drainResolvedCompletions.mockResolvedValueOnce({
      status: 'failed',
      reason: 'stale_state',
      message: 'Runbook state is stale',
      unresolved: 2,
      applied: [],
    });

    const drained = await drainResolvedCompletions({
      actorService: mockActorService as any,
      manager: asManager(mockManager),
      sessionService: mockSessionService as any,
      lifecycleService: mockLifecycleService as any,
      emitter: asEmitter(mockEmitter),
      runbookId: runbookId,
      steps: asSteps(steps),
      currentState: currentState as any,
      transitionPolicy: {
        onComplete: { releaseRunbook: false },
        onStopped: { releaseRunbook: false },
      },
    });

    expect(drained).toEqual({
      status: 'failed',
      reason: 'stale_state',
      message: 'Runbook state is stale',
      unresolved: 2,
      applied: 0,
    });
  });

  it('preserves observed progress when an override frame becomes inactive after a drain', async () => {
    const substepSteps: LooseStep[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Parent',
        aggregation: { strategy: 'ALL' },
        substeps: [
          {
            id: '1',
            description: 'Only',
            transitions: {
              pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' }, next: '2' },
              fail: { kind: 'fail', retry: 0, action: { type: 'STOP' }, next: 'STOP' },
            },
          },
        ],
        transitions: {
          pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' }, next: '2' },
          fail: { kind: 'fail', retry: 0, action: { type: 'STOP' }, next: 'STOP' },
        },
      },
      {
        kind: 'base',
        name: '2',
        description: 'Next',
        transitions: {
          pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' }, next: 'COMPLETE' },
          fail: { kind: 'fail', retry: 0, action: { type: 'STOP' }, next: 'STOP' },
        },
      },
    ];
    const before = makeLoopState('1', {
      substep: '1',
      retryCount: 0,
      lifecycle: 'running',
      activeFrameKey: '1|',
      activeEntry: 1,
    });
    const after = makeLoopState('2', {
      substep: undefined,
      retryCount: 0,
      lifecycle: 'running',
      activeFrameKey: '2|',
      activeEntry: 1,
    });

    mockCompletionService.drainResolvedCompletions
      .mockResolvedValueOnce({
        status: 'continue',
        state: after,
        unresolved: 0,
        applied: [
          {
            key: '1|1|1',
            completion: { result: 'pass', targetSubstep: '1' },
            stateBefore: before,
            stateAfter: after,
            snapshot: { status: 'active', context: { lastAction: { type: 'CONTINUE' } } },
          },
        ],
      })
      .mockResolvedValueOnce({
        status: 'not_active',
        frameKey: '1|',
        activeFrameKey: '2|',
        unresolved: 0,
        applied: [],
      });
    mockLifecycleService.ensureActiveEntry.mockResolvedValue({
      state: after,
      frameKey: '2|',
      entry: 1,
    });

    const drained = await drainResolvedCompletions({
      actorService: mockActorService as any,
      manager: asManager(mockManager),
      sessionService: mockSessionService as any,
      lifecycleService: mockLifecycleService as any,
      emitter: asEmitter(mockEmitter),
      runbookId: runbookId,
      steps: asSteps(substepSteps),
      currentState: before as any,
      transitionPolicy: {
        onComplete: { releaseRunbook: false },
        onStopped: { releaseRunbook: false },
      },
      frameOverride: { kind: 'inactive', frameKey: '1|' } as any,
    });

    expect(drained).toEqual({
      status: 'continue',
      state: after,
      unresolved: 0,
      applied: 1,
    });
  });

  it('emits derived completion without entering a step when initialization already completed', async () => {
    mockManager.load.mockResolvedValue(
      makeLoopState('2', {
        lifecycle: 'completed',
        snapshot: {
          status: 'done',
          value: 'COMPLETE',
          context: {
            lastAction: { type: 'COMPLETE', origin: 'direct' },
          },
        },
      }),
    );
    jest.mocked(core.executeCommand).mockResolvedValue({ success: true, exitCode: 0 });

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(steps),
      '/tmp',
      false,
      asEmitter(mockEmitter),
    );

    expect(result).toBe('done');
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'RUNBOOK_COMPLETED',
      payload: expect.objectContaining({
        message: 'Success',
        finalPosition: { current: '2', total: 2 },
      }),
    });
    const emittedEvents = mockEmitter.emit.mock.calls.map(([event]) => event.type);
    expect(emittedEvents).not.toContain('STEP_ENTERED');
    expect(emittedEvents).not.toContain('COMMAND_STARTED');
    expect(emittedEvents).not.toContain('COMMAND_COMPLETED');
    expect(core.executeCommand).not.toHaveBeenCalled();
    expect(mockSessionService.popRunbook).toHaveBeenCalledWith();
  });

  it('returns waiting if prompted mode is on', async () => {
    mockManager.load.mockResolvedValue(makeLoopState());

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(steps),
      '/tmp',
      true,
      asEmitter(mockEmitter),
    );

    expect(result).toBe('waiting');
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'STEP_ENTERED',
      payload: expect.objectContaining({
        stepName: '1',
        prompted: true,
      }),
    });
  });

  it('emits STEP_ENTERED.artifacts from the actor snapshot working set', async () => {
    const artifact = {
      kind: 'artifact-record' as const,
      uri: 'rd://artifacts/ctx1/rd_22222222222222222222222222222222/plan.json',
      runId: 'rd_22222222222222222222222222222222',
      contextId: 'ctx1',
      runbook: { source: 'project' as const, path: 'plan.md' },
      key: 'plan.json',
      timestamp: '2026-05-12T00:00:00.000Z',
    };
    mockManager.load.mockResolvedValue(makeLoopState());
    mockActorService.getContextSnapshot.mockResolvedValue({
      enteredArtifacts: { PlanPath: artifact },
    });

    await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(steps),
      '/tmp',
      true,
      asEmitter(mockEmitter),
    );

    const stepEntered = mockEmitter.emit.mock.calls.find((call) => call[0].type === 'STEP_ENTERED');
    expect(stepEntered?.[0]?.payload).toEqual(
      expect.objectContaining({
        artifacts: {
          PlanPath: expect.objectContaining({
            kind: 'artifact-record',
            uri: artifact.uri,
            path: expect.stringContaining(
              '.rundown/work/.rd-ctx1/rd_22222222222222222222222222222222/plan.json',
            ),
          }),
        },
      }),
    );
  });

  it('emits STEP_ENTERED.artifacts as an empty object when no ARTIFACTS resolved', async () => {
    mockManager.load.mockResolvedValue(makeLoopState());
    mockActorService.getContextSnapshot.mockResolvedValue({
      enteredArtifacts: undefined,
    });

    await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(steps),
      '/tmp',
      true,
      asEmitter(mockEmitter),
    );

    const stepEntered = mockEmitter.emit.mock.calls.find((call) => call[0].type === 'STEP_ENTERED');
    expect(stepEntered?.[0]?.payload).toEqual(expect.objectContaining({ artifacts: {} }));
  });

  it('returns waiting if step has no command', async () => {
    const stepsNoCmd = [
      {
        kind: 'base',
        name: '1',
        description: 'No command',
        transitions: { pass: { next: 'COMPLETE' } },
      },
    ];
    mockManager.load.mockResolvedValue(makeLoopState());

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(stepsNoCmd),
      '/tmp',
      false,
      asEmitter(mockEmitter),
    );

    expect(result).toBe('waiting');
  });

  it('executes command and advances to next step', async () => {
    mockManager.load
      .mockResolvedValueOnce(makeLoopState('1'))
      .mockResolvedValueOnce(makeLoopState('2'));

    mockActorService.sendAndSync.mockResolvedValue({
      state: makeLoopState('2'),
      snapshot: {
        status: 'active',
        value: '2',
        context: { lastAction: { type: 'CONTINUE', origin: 'direct' } },
      },
      effects: [commandCompletedEffect('pass')],
    });

    const testSteps = [
      steps[0],
      {
        kind: 'base',
        name: '2',
        description: 'Step 2',
        transitions: { pass: { next: 'COMPLETE' } },
      },
    ];

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(testSteps),
      '/tmp',
      false,
      asEmitter(mockEmitter),
    );

    expect(result).toBe('waiting');
    expect(mockActorService.sendAndSync).toHaveBeenCalledWith(
      runbookId,
      asSteps(testSteps),
      expect.objectContaining({ type: 'EXECUTE_COMMAND', command: 'echo hello' }),
    );
  });

  it('injects canonical RD_RUN_ID from template vars and persisted runbook identity', async () => {
    // Downstream tools (e.g. rdpath) treat these env vars as a structurally
    // paired triple. Asserting them here keeps a regression in the injection
    // gates at execution.ts (`if (typeof workPath === 'string') ...`) from
    // silently dropping one half of the pair without any test failing.
    mockManager.load.mockResolvedValue({
      id: runbookId,
      runbook: { source: 'project', path: 'test.runbook.md' },
      step: '1',
      status: 'running',
      templateVars: {
        WorkPath: '/tmp/work',
        ContextId: 'ctx-abc',
        RunId: runbookId,
      },
    });

    jest.mocked(core.executeCommand).mockResolvedValue({ success: true, exitCode: 0 });
    jest.mocked(core.executeCommandWithEnv).mockResolvedValue({ success: true, exitCode: 0 });

    mockActorService.sendAndSync.mockResolvedValue({
      state: {
        id: runbookId,
        step: '1',
        status: 'done',
        variables: {},
        runbook: { source: 'project', path: 'test.runbook.md' },
        templateVars: {
          WorkPath: '/tmp/work',
          ContextId: 'ctx-abc',
          RunId: runbookId,
        },
      },
      snapshot: {
        status: 'done',
        value: 'COMPLETE',
        context: { lastAction: { type: 'COMPLETE', origin: 'direct' }, lastMessage: 'Success' },
      },
      effects: [commandCompletedEffect('pass')],
    });

    await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps([steps[0]]),
      '/tmp',
      false,
      asEmitter(mockEmitter),
    );

    expect(mockActorService.sendAndSync).toHaveBeenCalledTimes(1);
    const envArg = (
      mockActorService.sendAndSync.mock.calls[0][2] as { rdInjected: Record<string, string> }
    ).rdInjected;
    expect(envArg.RD_WORK_PATH).toBe('/tmp/work');
    expect(envArg.RD_CONTEXT_ID).toBe('ctx-abc');
    expect(envArg.RD_RUN_ID).toBe(runbookId);
    expect(envArg.RD_RUNBOOK_REF).toBe('test.runbook.md');
    expect(envArg.RD_RUNBOOK_SOURCE).toBe('project');
  });

  it.each([
    { source: 'plugin', path: 'planning/review.runbook.md' },
    { source: 'external', path: '/tmp/review.runbook.md' },
  ])('injects persisted $source runbook identity into RD env', async (runbook) => {
    mockManager.load.mockResolvedValue({
      id: runbookId,
      runbook,
      step: '1',
      status: 'running',
      templateVars: {
        WorkPath: '/tmp/work',
        ContextId: 'ctx-abc',
        RunId: runbookId,
      },
    });

    jest.mocked(core.executeCommand).mockResolvedValue({ success: true, exitCode: 0 });
    jest.mocked(core.executeCommandWithEnv).mockResolvedValue({ success: true, exitCode: 0 });

    mockActorService.sendAndSync.mockResolvedValue({
      state: {
        id: runbookId,
        step: '1',
        status: 'done',
        variables: {},
        runbook,
        templateVars: {
          WorkPath: '/tmp/work',
          ContextId: 'ctx-abc',
          RunId: runbookId,
        },
      },
      snapshot: {
        status: 'done',
        value: 'COMPLETE',
        context: { lastAction: { type: 'COMPLETE', origin: 'direct' }, lastMessage: 'Success' },
      },
      effects: [commandCompletedEffect('pass')],
    });

    await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps([steps[0]]),
      '/tmp',
      false,
      asEmitter(mockEmitter),
    );

    expect(mockActorService.sendAndSync).toHaveBeenCalledTimes(1);
    const envArg = (
      mockActorService.sendAndSync.mock.calls[0][2] as { rdInjected: Record<string, string> }
    ).rdInjected;
    expect(envArg.RD_RUNBOOK_REF).toBe(runbook.path);
    expect(envArg.RD_RUNBOOK_SOURCE).toBe(runbook.source);
  });

  it('handles policy denial', async () => {
    mockManager.load.mockResolvedValue(makeLoopState());
    jest.mocked(policyContext.isPolicyEnforced).mockReturnValue(true);

    mockActorService.sendAndSync.mockResolvedValue({
      state: makeLoopState('1', {
        lifecycle: 'stopped',
        lastAction: { type: 'POLICY_DENIED', message: 'Not allowed' },
      }),
      snapshot: {
        status: 'done',
        value: 'STOPPED',
        context: { lastAction: { type: 'POLICY_DENIED', message: 'Not allowed' } },
      },
      effects: [policyDeniedEffect('Not allowed')],
    });

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(steps),
      '/tmp',
      false,
      asEmitter(mockEmitter),
    );

    expect(result).toBe('stopped');
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'POLICY_DENIED',
      payload: expect.objectContaining({
        reason: 'Not allowed',
      }),
    });
  });

  it('emits COMMAND_STARTED then COMMAND_COMPLETED from effects when executing a command', async () => {
    mockManager.load.mockResolvedValue(makeLoopState());

    mockActorService.sendAndSync.mockResolvedValue({
      state: {
        id: runbookId,
        step: '1',
        status: 'done',
        variables: {},
        runbookPath: '/tmp/test.md',
      },
      snapshot: {
        status: 'done',
        value: 'COMPLETE',
        context: { lastAction: { type: 'COMPLETE' }, lastMessage: 'Done' },
      },
      effects: [commandStartedEffectFixture(), commandCompletedEffect('pass')],
    });

    await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps([steps[0]]),
      '/tmp',
      false,
      asEmitter(mockEmitter),
    );

    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'COMMAND_STARTED',
      payload: expect.objectContaining({ command: 'echo hello', displayCommand: 'echo hello' }),
    });
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'COMMAND_COMPLETED',
      payload: expect.objectContaining({ command: 'echo hello', success: true, exitCode: 0 }),
    });

    const emitCalls = mockEmitter.emit.mock.calls;
    const startedIdx = emitCalls.findIndex((c) => c[0].type === 'COMMAND_STARTED');
    const completedIdx = emitCalls.findIndex((c) => c[0].type === 'COMMAND_COMPLETED');
    expect(startedIdx).toBeGreaterThanOrEqual(0);
    expect(completedIdx).toBeGreaterThan(startedIdx);
  });

  it('completes the runbook', async () => {
    mockManager.load.mockResolvedValue(makeLoopState());
    jest.mocked(core.executeCommand).mockResolvedValue({ success: true, exitCode: 0 });

    mockActorService.sendAndSync.mockResolvedValue({
      state: {
        id: runbookId,
        step: '1',
        status: 'done',
        variables: {},
        runbookPath: '/tmp/test.md',
      },
      snapshot: {
        status: 'done',
        value: 'COMPLETE',
        context: { lastAction: { type: 'COMPLETE', origin: 'direct' }, lastMessage: 'Success' },
      },
      effects: [commandCompletedEffect('pass')],
    });

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(steps),
      '/tmp',
      false,
      asEmitter(mockEmitter),
    );

    expect(result).toBe('done');
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'RUNBOOK_COMPLETED',
      payload: expect.objectContaining({
        message: 'Success',
      }),
    });
    // 'stack-pop' retains the claim exactly as 'release-runbook' does: the run
    // reached terminal under its own steam, so its bearer becomes a tombstone
    // rather than being deleted. Pinned end-to-end against a real store by
    // `run.test.ts` "retains the run-control claim as a terminal tombstone" —
    // this mocked runner ignores `terminalRelease`, so it can only pin the
    // request, never the release itself.
    expect(mockActorMutationRunner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalRelease: {
          onComplete: true,
          onStopped: true,
          retainClaimsAsTerminal: true,
        },
      }),
    );
    expect(mockSessionService.releaseRunbook).not.toHaveBeenCalled();
    expect(mockSessionService.popRunbook).not.toHaveBeenCalled();
  });

  describe('terminal release refused for execution ownership (#608)', () => {
    /**
     * Every RUNBOOK_STOPPED the emitter received this test.
     *
     * `toHaveBeenCalledWith` passes when ANY call matches, so it cannot tell a
     * single correct stop from one accompanied by a spurious second. These
     * paths differ precisely in how many stops they emit.
     *
     * @returns The stopped events, in emission order.
     */
    function stoppedEmissions(): { type: string }[] {
      return mockEmitter.emit.mock.calls
        .map(([event]) => event as { type: string })
        .filter((event) => event.type === 'RUNBOOK_STOPPED');
    }

    /** Drive the loop to a COMPLETE terminal so the release is the only variable. */
    function seedCompletingRun(): void {
      mockManager.load.mockResolvedValue(makeLoopState());
      jest.mocked(core.executeCommand).mockResolvedValue({ success: true, exitCode: 0 });
      mockActorService.sendAndSync.mockResolvedValue({
        state: {
          id: runbookId,
          step: '1',
          status: 'done',
          variables: {},
          runbookPath: '/tmp/test.md',
        },
        snapshot: {
          status: 'done',
          value: 'COMPLETE',
          context: { lastAction: { type: 'COMPLETE', origin: 'direct' }, lastMessage: 'Success' },
        },
        effects: [commandCompletedEffect('pass')],
      });
    }

    it.each([
      {
        label: 'execution_in_progress',
        refusal: {
          kind: 'execution_in_progress' as const,
          runId: runbookId,
          message: `Run ${runbookId} has an execution in progress.`,
        },
        code: 'EXECUTION_IN_PROGRESS',
      },
      {
        label: 'recovery_required',
        refusal: {
          kind: 'recovery_required' as const,
          runId: runbookId,
          epoch: 4 as RecoveryRefusal['epoch'],
          message: `Run ${runbookId} ended execution with an unknown outcome at epoch 4; run recovery before continuing.`,
        },
        code: 'RECOVERY_REQUIRED',
      },
    ])('reports $label and returns stopped instead of done', async ({ refusal, code }) => {
      mockManager.load.mockResolvedValue(makeLoopState());
      mockActorMutationRunner.run.mockResolvedValueOnce(refusal);

      const result = await runExecutionLoop(
        asManager(mockManager),
        runbookId,
        asSteps(steps),
        '/tmp',
        false,
        asEmitter(mockEmitter),
      );

      expect(result).toBe('stopped');
      expect(mockEmitter.emit).toHaveBeenCalledWith({
        type: 'ERROR_OCCURRED',
        payload: { message: refusal.message, code },
      });
      expect(mockSessionService.releaseRunbook).not.toHaveBeenCalled();
      expect(mockSessionService.popRunbook).not.toHaveBeenCalled();
    });

    it('reports a refused stack pop and downgrades an already-completed run', async () => {
      // The stack-pop disposition of the same release. The run is already
      // terminal at loop entry, so the pop is the loop's only session write —
      // and a refused pop must not report `done`.
      mockManager.load.mockResolvedValue(
        makeLoopState('2', {
          lifecycle: 'completed',
          snapshot: {
            status: 'done',
            value: 'COMPLETE',
            context: { lastAction: { type: 'COMPLETE', origin: 'direct' } },
          },
        }),
      );
      const refusal = {
        kind: 'execution_in_progress' as const,
        runId: runbookId,
        message: `Run ${runbookId} has an execution in progress.`,
      };
      mockSessionService.popRunbook.mockResolvedValue(refusal);

      const result = await runExecutionLoop(
        asManager(mockManager),
        runbookId,
        asSteps(steps),
        '/tmp',
        false,
        asEmitter(mockEmitter),
      );

      expect(result).toBe('stopped');
      expect(mockSessionService.popRunbook).toHaveBeenCalledWith();
      expect(mockEmitter.emit).toHaveBeenCalledWith({
        type: 'ERROR_OCCURRED',
        payload: { message: refusal.message, code: 'EXECUTION_IN_PROGRESS' },
      });
      // The stream must not claim the run completed: the release it owed was
      // refused, so the run is still on the session stack. A consumer reading
      // only the events would otherwise see a clean completion.
      expect(mockEmitter.emit).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'RUNBOOK_COMPLETED' }),
      );
      // The stop names where the run halted rather than being a bare marker,
      // and it is the ONLY one: this path suppresses the completion rather than
      // correcting it, so the helper must not add a second stop on top.
      expect(mockEmitter.emit).toHaveBeenCalledWith({
        type: 'RUNBOOK_STOPPED',
        payload: { position: { current: '2', total: 2 } },
      });
      expect(stoppedEmissions()).toHaveLength(1);
    });

    it('does not release the winner when a stale command claimant is refused', async () => {
      mockManager.load.mockResolvedValue(makeLoopState());
      const refusal = {
        kind: 'claim_superseded' as const,
        runId: runbookId,
        message: `Claim authority for run ${runbookId} was superseded.`,
      };
      mockActorMutationRunner.run.mockResolvedValueOnce(refusal);

      const result = await runExecutionLoop(
        asManager(mockManager),
        runbookId,
        asSteps(steps),
        '/tmp',
        false,
        asEmitter(mockEmitter),
        { terminalReleaseMode: 'release-runbook' },
      );

      expect(result).toBe('stopped');
      expect(mockEmitter.emit).toHaveBeenCalledWith({
        type: 'ERROR_OCCURRED',
        payload: { message: refusal.message, code: 'STALE_CLAIM' },
      });
      expect(mockSessionService.releaseRunbook).not.toHaveBeenCalled();
      expect(mockSessionService.popRunbook).not.toHaveBeenCalled();
    });

    it('returns done and emits no stop when the command path release commits', async () => {
      // The committing half of the command path. Without it nothing pins that
      // this site reports `done`: the refusal tests return `stopped` whatever
      // the committed outcome would have been.
      seedCompletingRun();

      const result = await runExecutionLoop(
        asManager(mockManager),
        runbookId,
        asSteps(steps),
        '/tmp',
        false,
        asEmitter(mockEmitter),
        { terminalReleaseMode: 'release-runbook' },
      );

      expect(result).toBe('done');
      expect(mockActorMutationRunner.run).toHaveBeenCalledWith(
        expect.objectContaining({
          terminalRelease: {
            onComplete: true,
            onStopped: true,
            retainClaimsAsTerminal: true,
          },
        }),
      );
      expect(mockSessionService.releaseRunbook).not.toHaveBeenCalled();
      expect(stoppedEmissions()).toHaveLength(0);
    });

    it.each([
      { label: 'commits', refuse: false, expected: 'done', stops: 0 },
      { label: 'is refused', refuse: true, expected: 'stopped', stops: 1 },
    ])(
      'drives the drain terminal through the release when it $label',
      async ({ refuse, expected, stops }) => {
        // The drain reaches its own terminal release site, distinct from the
        // command path. It was uncovered in `release-runbook` mode entirely.
        mockManager.load.mockResolvedValue(makeLoopState());
        mockCompletionService.drainResolvedCompletions.mockResolvedValue({
          status: 'done',
          applied: [],
          unresolved: 0,
        });
        if (refuse) {
          mockSessionService.releaseRunbook.mockResolvedValue({
            kind: 'execution_in_progress' as const,
            runId: runbookId,
            message: `Run ${runbookId} has an execution in progress.`,
          });
        }

        const result = await runExecutionLoop(
          asManager(mockManager),
          runbookId,
          asSteps(steps),
          '/tmp',
          false,
          asEmitter(mockEmitter),
          { terminalReleaseMode: 'release-runbook' },
        );

        expect(result).toBe(expected);
        expect(mockSessionService.releaseRunbook).toHaveBeenCalledWith(runbookId, {
          retainClaimsAsTerminal: true,
        });
        expect(stoppedEmissions()).toHaveLength(stops);
      },
    );

    it('does not fabricate a corrective stop when the refused terminal was already stopped', async () => {
      // The correction exists only to contradict a completion that was already
      // announced. A terminal that stopped emitted its own stop, so adding a
      // second one would double-report the same halt.
      mockManager.load.mockResolvedValue(
        makeLoopState('2', {
          lifecycle: 'stopped',
          snapshot: {
            status: 'done',
            value: 'STOPPED',
            context: { lastAction: { type: 'STOP', origin: 'direct' } },
          },
        }),
      );
      const refusal = {
        kind: 'execution_in_progress' as const,
        runId: runbookId,
        message: `Run ${runbookId} has an execution in progress.`,
      };
      mockSessionService.popRunbook.mockResolvedValue(refusal);

      const result = await runExecutionLoop(
        asManager(mockManager),
        runbookId,
        asSteps(steps),
        '/tmp',
        false,
        asEmitter(mockEmitter),
      );

      expect(result).toBe('stopped');
      expect(mockEmitter.emit).toHaveBeenCalledWith({
        type: 'ERROR_OCCURRED',
        payload: { message: refusal.message, code: 'EXECUTION_IN_PROGRESS' },
      });
      expect(stoppedEmissions()).toHaveLength(1);
    });

    it('announces completion from state when the snapshot is not recognizably terminal', async () => {
      // A completed run whose snapshot does not read as terminal takes the
      // fallback: the completion payload is derived from the run state rather
      // than from a transition observation. Both branches announce completion,
      // so only the payload distinguishes them.
      mockManager.load.mockResolvedValue(
        makeLoopState('2', {
          lifecycle: 'completed',
          snapshot: {
            status: 'active',
            value: { 'step::2': 'idle' },
            context: { lastAction: { type: 'CONTINUE', origin: 'direct' }, lastMessage: 'Wrapped' },
          },
        }),
      );

      const result = await runExecutionLoop(
        asManager(mockManager),
        runbookId,
        asSteps(steps),
        '/tmp',
        false,
        asEmitter(mockEmitter),
      );

      expect(result).toBe('done');
      expect(mockEmitter.emit).toHaveBeenCalledWith({
        type: 'RUNBOOK_COMPLETED',
        payload: { message: 'Wrapped', finalPosition: { current: '2', total: 2 } },
      });
    });

    it('emits the completion and returns done when the pre-loop release commits', async () => {
      // The committed half of the same branch. Without it, forcing the refusal
      // path always-on would still pass: nothing else drives an already-terminal
      // run through this branch with a release that succeeds.
      mockManager.load.mockResolvedValue(
        makeLoopState('2', {
          lifecycle: 'completed',
          snapshot: {
            status: 'done',
            value: 'COMPLETE',
            context: { lastAction: { type: 'COMPLETE', origin: 'direct' } },
          },
        }),
      );

      const result = await runExecutionLoop(
        asManager(mockManager),
        runbookId,
        asSteps(steps),
        '/tmp',
        false,
        asEmitter(mockEmitter),
      );

      expect(result).toBe('done');
      expect(mockEmitter.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'RUNBOOK_COMPLETED' }),
      );
      expect(mockEmitter.emit).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'RUNBOOK_STOPPED' }),
      );
    });
  });

  describe("terminalReleaseMode 'defer-to-caller' (#598)", () => {
    it('drives a run to done without releasing — caller owns release', async () => {
      // Mirror the "completes the runbook" fixture: an in-loop command drive to
      // a 'done' terminal. Under 'defer-to-caller' the drain policy is
      // non-releasing AND the in-loop guard skips applyExecutionTerminalRelease,
      // so NEITHER releaseRunbook NOR popRunbook fires — the caller (the inline
      // parent-advance core seam) owns the single terminal release.
      mockManager.load.mockResolvedValue(makeLoopState());
      jest.mocked(core.executeCommand).mockResolvedValue({ success: true, exitCode: 0 });
      mockActorService.sendAndSync.mockResolvedValue({
        state: {
          id: runbookId,
          step: '1',
          status: 'done',
          variables: {},
          runbookPath: '/tmp/test.md',
        },
        snapshot: {
          status: 'done',
          value: 'COMPLETE',
          context: { lastAction: { type: 'COMPLETE', origin: 'direct' }, lastMessage: 'Success' },
        },
        effects: [commandCompletedEffect('pass')],
      });

      const result = await runExecutionLoop(
        asManager(mockManager),
        runbookId,
        asSteps(steps),
        '/tmp',
        false,
        asEmitter(mockEmitter),
        { terminalReleaseMode: 'defer-to-caller' },
      );

      expect(result).toBe('done');
      expect(mockSessionService.releaseRunbook).not.toHaveBeenCalled();
      expect(mockSessionService.popRunbook).not.toHaveBeenCalled();
      // The release is folded INTO the fenced command mutation, so "the caller
      // owns it" has to be visible in the request the fence received — not only
      // in the absence of a separate session call, which would also hold if the
      // fence had released it inside its own transaction.
      expect(mockActorMutationRunner.run).toHaveBeenCalledWith(
        expect.objectContaining({
          terminalRelease: {
            onComplete: false,
            onStopped: false,
            retainClaimsAsTerminal: true,
          },
        }),
      );
    });

    it('drives a run to stopped without releasing', async () => {
      // Pre-loaded stopped state (CLI-owned stop recovery). Under
      // 'defer-to-caller' applyExecutionTerminalRelease no-ops, so the terminal
      // return releases nothing.
      mockManager.load.mockResolvedValue(
        makeLoopState('1', {
          lifecycle: 'stopped',
          snapshot: {
            status: 'active',
            value: { 'step::1': 'idle' },
            context: { lastAction: { type: 'CONTINUE', origin: 'direct' } },
          },
        }),
      );

      const result = await runExecutionLoop(
        asManager(mockManager),
        runbookId,
        asSteps(steps),
        '/tmp',
        false,
        asEmitter(mockEmitter),
        { terminalReleaseMode: 'defer-to-caller' },
      );

      expect(result).toBe('stopped');
      expect(mockSessionService.releaseRunbook).not.toHaveBeenCalled();
      expect(mockSessionService.popRunbook).not.toHaveBeenCalled();
    });

    it("'release-runbook' releases the run and retains the claim as a terminal tombstone", async () => {
      // No test drove this mode through runExecutionLoop before: the suite's
      // other retainClaimsAsTerminal assertion is satisfied by a release from a
      // different module, and the loop's default mode is 'stack-pop'. That left
      // the flag unpinned here — a mutant flipping it to `false` survived, even
      // though the disposition is load-bearing: retaining the tombstone is what
      // lets a later `--claim-id` confirm-or-conflict resolve `terminal` rather
      // than `missing` (RD-598).
      mockManager.load.mockResolvedValue(
        makeLoopState('1', {
          lifecycle: 'stopped',
          snapshot: {
            status: 'active',
            value: { 'step::1': 'idle' },
            context: { lastAction: { type: 'CONTINUE', origin: 'direct' } },
          },
        }),
      );

      const result = await runExecutionLoop(
        asManager(mockManager),
        runbookId,
        asSteps(steps),
        '/tmp',
        false,
        asEmitter(mockEmitter),
        { terminalReleaseMode: 'release-runbook' },
      );

      expect(result).toBe('stopped');
      expect(mockSessionService.releaseRunbook).toHaveBeenCalledWith(runbookId, {
        retainClaimsAsTerminal: true,
      });
      expect(mockSessionService.popRunbook).not.toHaveBeenCalled();
    });

    it('refuses an unrecognized release mode instead of falling through to a stack pop', async () => {
      // The mode dispatch must not treat "not release-runbook" as "stack-pop":
      // a future ExecutionTerminalReleaseMode added to the union would then
      // silently pop the default stack, releasing a run its owner still holds.
      // The `never` check makes the compiler the primary gate; this pins the
      // runtime half, which is what a cast at a call site would slip past.
      // Pre-loaded stopped state, mirroring the sibling test: that path reaches
      // applyExecutionTerminalRelease unconditionally, whereas the in-loop
      // transition sites guard the call on the mode and would never reach it.
      mockManager.load.mockResolvedValue(
        makeLoopState('1', {
          lifecycle: 'stopped',
          snapshot: {
            status: 'active',
            value: { 'step::1': 'idle' },
            context: { lastAction: { type: 'CONTINUE', origin: 'direct' } },
          },
        }),
      );

      await expect(
        runExecutionLoop(
          asManager(mockManager),
          runbookId,
          asSteps(steps),
          '/tmp',
          false,
          asEmitter(mockEmitter),
          { terminalReleaseMode: 'future-mode' as ExecutionTerminalReleaseMode },
        ),
      ).rejects.toThrow(/future-mode/);

      expect(mockSessionService.popRunbook).not.toHaveBeenCalled();
      expect(mockSessionService.releaseRunbook).not.toHaveBeenCalled();
    });
  });

  describe('claim authority threaded into the fenced command mutation', () => {
    /** Drive one command step and return the fence input the loop built. */
    async function fenceInputForCommand(
      options: Record<string, unknown> = {},
    ): Promise<Record<string, unknown>> {
      mockManager.load.mockResolvedValue(makeLoopState());
      jest.mocked(core.executeCommand).mockResolvedValue({ success: true, exitCode: 0 });
      mockActorService.sendAndSync.mockResolvedValue({
        state: {
          id: runbookId,
          step: '1',
          status: 'done',
          variables: {},
          runbookPath: '/tmp/test.md',
        },
        snapshot: {
          status: 'done',
          value: 'COMPLETE',
          context: { lastAction: { type: 'COMPLETE', origin: 'direct' }, lastMessage: 'Success' },
        },
        effects: [commandCompletedEffect('pass')],
      });

      await runExecutionLoop(
        asManager(mockManager),
        runbookId,
        asSteps(steps),
        '/tmp',
        false,
        asEmitter(mockEmitter),
        options,
      );

      return mockActorMutationRunner.run.mock.calls[0][0];
    }

    it('presents the caller claim key as the fence authority when one was supplied', async () => {
      // A delegated child runs its commands under its bearer. Losing the key here
      // downgrades the commit to a bare capture, which resolves whatever claim
      // currently controls the run rather than the one the caller presented.
      const claimKey = 'rdclk_11111111111111111111111111111111';

      const input = await fenceInputForCommand({ claimKey });

      expect(input.claimKey).toBe(claimKey);
    });

    it('omits the key entirely for a bare caller rather than presenting undefined', async () => {
      const input = await fenceInputForCommand();

      expect(Object.hasOwn(input, 'claimKey')).toBe(false);
    });

    // `displayCommand` is what the operator sees attributed to the step, while
    // `command` stays the string actually executed. An `rd echo` wrapper is
    // scaffolding, so the display strips it — unless stripping leaves nothing,
    // in which case showing an empty command is worse than showing the wrapper.
    it.each([
      {
        label: 'strips an rd echo wrapper for display',
        code: 'rd echo --result pass npm run build',
        displayCommand: 'npm run build',
      },
      {
        label: 'falls back to the raw command when stripping leaves nothing',
        code: 'rd echo --result pass',
        displayCommand: 'rd echo --result pass',
      },
    ])('$label', async ({ code, displayCommand }) => {
      const commandSteps = [{ ...steps[0], command: { code, lang: 'sh' } }, steps[1]];
      mockManager.load.mockResolvedValue(makeLoopState());
      jest.mocked(core.executeCommand).mockResolvedValue({ success: true, exitCode: 0 });
      mockActorService.sendAndSync.mockResolvedValue({
        state: {
          id: runbookId,
          step: '1',
          status: 'done',
          variables: {},
          runbookPath: '/tmp/test.md',
        },
        snapshot: {
          status: 'done',
          value: 'COMPLETE',
          context: { lastAction: { type: 'COMPLETE', origin: 'direct' }, lastMessage: 'Success' },
        },
        effects: [commandCompletedEffect('pass')],
      });

      await runExecutionLoop(
        asManager(mockManager),
        runbookId,
        asSteps(commandSteps),
        '/tmp',
        false,
        asEmitter(mockEmitter),
      );

      expect(mockActorService.prepareActorMutation).toHaveBeenCalledWith(
        runbookId,
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ type: 'EXECUTE_COMMAND', command: code, displayCommand }),
      );
    });
  });

  it('emits ERROR_OCCURRED when the state machine stops with a RETRY_ERROR lastAction', async () => {
    // Seed the actor to report a stopped lifecycle with a RETRY_ERROR
    // lastAction variant on the returned snapshot. runExecutionLoop should
    // emit ERROR_OCCURRED with the hook error's code + message before the
    // terminal RUNBOOK_STOPPED event.
    mockManager.load.mockResolvedValue(makeLoopState());
    jest.mocked(core.executeCommand).mockResolvedValue({ success: false, exitCode: 1 });

    mockActorService.sendAndSync.mockResolvedValue({
      state: {
        id: runbookId,
        step: '1',
        status: 'done',
        lifecycle: 'stopped',
        variables: {},
        runbookPath: '/tmp/test.md',
      },
      snapshot: {
        status: 'done',
        value: 'STOPPED',
        context: {
          lastAction: {
            type: 'RETRY_ERROR' as const,
            origin: 'direct',
            code: 'RD-902',
            message: 'hook failed: createDelegation returned step_not_found',
          },
          lifecycle: 'stopped',
        },
      },
      effects: [],
    });

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(steps),
      '/tmp',
      false,
      asEmitter(mockEmitter),
    );

    expect(result).toBe('stopped');

    // ERROR_OCCURRED is emitted with the RETRY_ERROR lastAction payload fields.
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'ERROR_OCCURRED',
      payload: expect.objectContaining({
        code: 'RD-902',
        message: 'hook failed: createDelegation returned step_not_found',
      }),
    });

    // RUNBOOK_STOPPED still fires afterwards with a reason distinct from an
    // author-configured FAIL STOP transition.
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'RUNBOOK_STOPPED',
      payload: expect.objectContaining({ reason: 'retry_error_failed' }),
    });

    // Ordering: ERROR_OCCURRED precedes RUNBOOK_STOPPED.
    const emitCalls = mockEmitter.emit.mock.calls;
    const errorIdx = emitCalls.findIndex((c) => c[0].type === 'ERROR_OCCURRED');
    const stoppedIdx = emitCalls.findIndex((c) => c[0].type === 'RUNBOOK_STOPPED');
    expect(errorIdx).toBeGreaterThanOrEqual(0);
    expect(stoppedIdx).toBeGreaterThanOrEqual(0);
    expect(errorIdx).toBeLessThan(stoppedIdx);

    // Invariant: STEP_TRANSITIONED is NEVER emitted with action: 'RETRY_ERROR'.
    // RETRY_ERROR is a machine-internal failure signal already surfaced via
    // ERROR_OCCURRED + RUNBOOK_STOPPED; leaking it through STEP_TRANSITIONED
    // would widen the public action enum beyond the scenario schema
    // (CONTINUE/DEFER/GOTO/STOP/COMPLETE/RETRY/BREAK/NEXT).
    const stepTransitionedCalls = emitCalls.filter((c) => c[0].type === 'STEP_TRANSITIONED');
    for (const call of stepTransitionedCalls) {
      const payload = call[0].payload as { action?: string } | undefined;
      expect(payload?.action).not.toBe('RETRY_ERROR');
    }
  });

  it('emits ERROR_OCCURRED when the state machine stops with an OUTPUT_CAPTURE_FAILED lastAction', async () => {
    mockManager.load.mockResolvedValue(makeLoopState());
    jest.mocked(core.executeCommand).mockResolvedValue({ success: false, exitCode: 1 });

    mockActorService.sendAndSync.mockResolvedValue({
      state: {
        id: runbookId,
        step: '1',
        status: 'done',
        lifecycle: 'stopped',
        variables: {},
        runbookPath: '/tmp/test.md',
      },
      snapshot: {
        status: 'done',
        value: 'STOPPED',
        context: {
          lastAction: {
            type: 'OUTPUT_CAPTURE_FAILED' as const,
            origin: 'direct',
            message: 'failed to read channel file: /tmp/outputs/Foo',
          },
          lifecycle: 'stopped',
        },
      },
      effects: [],
    });

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(steps),
      '/tmp',
      false,
      asEmitter(mockEmitter),
    );

    expect(result).toBe('stopped');

    // ERROR_OCCURRED is emitted with the OUTPUT_CAPTURE_FAILED message.
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'ERROR_OCCURRED',
      payload: expect.objectContaining({
        message: 'failed to read channel file: /tmp/outputs/Foo',
      }),
    });

    // RUNBOOK_STOPPED still fires afterwards so terminal state is reported.
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'RUNBOOK_STOPPED',
      payload: expect.any(Object),
    });

    // Ordering: ERROR_OCCURRED precedes RUNBOOK_STOPPED.
    const emitCalls = mockEmitter.emit.mock.calls;
    const errorIdx = emitCalls.findIndex((c) => c[0].type === 'ERROR_OCCURRED');
    const stoppedIdx = emitCalls.findIndex((c) => c[0].type === 'RUNBOOK_STOPPED');
    expect(errorIdx).toBeGreaterThanOrEqual(0);
    expect(stoppedIdx).toBeGreaterThanOrEqual(0);
    expect(errorIdx).toBeLessThan(stoppedIdx);
  });

  it('emits ERROR_OCCURRED + RUNBOOK_STOPPED when loaded state is already stopped with ARTIFACT_RESOLUTION_FAILED', async () => {
    // Batch-2 introduced the pre-loop stopped-on-entry projection so artifact
    // resolution failures surfaced during initializeState() (before the loop
    // sends any machine event) still route through deriveTransitionObservation
    // and emit ERROR_OCCURRED before RUNBOOK_STOPPED. STEP_TRANSITIONED is
    // suppressed because the failure is machine-internal.
    mockManager.load.mockResolvedValue(
      makeLoopState('1', {
        lifecycle: 'stopped',
        snapshot: {
          status: 'done',
          value: 'STOPPED',
          context: {
            lastAction: {
              type: 'ARTIFACT_RESOLUTION_FAILED' as const,
              origin: 'direct',
              message: 'artifact "PlanPath" failed to resolve',
            },
            lifecycle: 'stopped',
          },
        },
      }),
    );

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(steps),
      '/tmp',
      false,
      asEmitter(mockEmitter),
    );

    expect(result).toBe('stopped');
    expect(mockActorService.sendAndSync).not.toHaveBeenCalled();

    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'ERROR_OCCURRED',
      payload: expect.objectContaining({
        message: 'artifact "PlanPath" failed to resolve',
      }),
    });
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'RUNBOOK_STOPPED',
      payload: expect.objectContaining({
        message: 'artifact "PlanPath" failed to resolve',
        reason: 'artifact_resolution_failed',
      }),
    });

    const emitCalls = mockEmitter.emit.mock.calls;
    const errorIdx = emitCalls.findIndex((c) => c[0].type === 'ERROR_OCCURRED');
    const stoppedIdx = emitCalls.findIndex((c) => c[0].type === 'RUNBOOK_STOPPED');
    expect(errorIdx).toBeGreaterThanOrEqual(0);
    expect(stoppedIdx).toBeGreaterThan(errorIdx);

    const stepTransitionedCalls = emitCalls.filter((c) => c[0].type === 'STEP_TRANSITIONED');
    expect(stepTransitionedCalls).toHaveLength(0);
  });

  it('emits RUNBOOK_STOPPED when lifecycle is stopped but XState snapshot is non-terminal (CLI-owned stop recovery)', async () => {
    // Regression: policy denial / delegation-resolution failure patches only
    // lifecycle:'stopped' without driving the XState machine to its terminal STOPPED
    // state. The snapshot stays active. deriveTransitionObservation must not be used
    // for this path — it returns { status:'continue' } for non-terminal snapshots
    // and RUNBOOK_STOPPED is never emitted.
    mockManager.load.mockResolvedValue(
      makeLoopState('1', {
        lifecycle: 'stopped',
        snapshot: {
          status: 'active',
          value: { 'step::1': 'idle' },
          context: { lastAction: { type: 'CONTINUE', origin: 'direct' } },
        },
      }),
    );

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(steps),
      '/tmp',
      false,
      asEmitter(mockEmitter),
    );

    expect(result).toBe('stopped');
    expect(mockActorService.sendAndSync).not.toHaveBeenCalled();
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'RUNBOOK_STOPPED',
      payload: expect.objectContaining({
        position: expect.any(Object),
        reason: expect.any(String),
      }),
    });
    expect(
      (mockEmitter.emit as jest.Mock).mock.calls.filter(
        (c) => (c[0] as { type?: string } | undefined)?.type === 'STEP_TRANSITIONED',
      ),
    ).toHaveLength(0);
  });

  it('emits command_execution_failed for stopped command infrastructure state without transition events', async () => {
    mockManager.load.mockResolvedValue(
      makeLoopState('1', {
        lifecycle: 'stopped',
        lastAction: {
          type: 'COMMAND_EXECUTION_FAILED',
          origin: 'direct',
          message: 'Timeout of 30000 ms exceeded',
        },
        snapshot: {
          status: 'active',
          value: { 'step::1': 'idle' },
          context: {
            lastAction: {
              type: 'COMMAND_EXECUTION_FAILED',
              origin: 'direct',
              message: 'Timeout of 30000 ms exceeded',
            },
          },
        },
      }),
    );

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(steps),
      '/tmp',
      false,
      asEmitter(mockEmitter),
    );

    expect(result).toBe('stopped');
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'RUNBOOK_STOPPED',
      payload: expect.objectContaining({
        reason: 'command_execution_failed',
        message: 'Timeout of 30000 ms exceeded',
      }),
    });
    expect(
      (mockEmitter.emit as jest.Mock).mock.calls.filter(
        (c) => (c[0] as { type?: string } | undefined)?.type === 'STEP_TRANSITIONED',
      ),
    ).toHaveLength(0);
  });

  it('emits RUNBOOK_STOPPED when lifecycle is stopped and snapshot has no lastAction', async () => {
    mockManager.load.mockResolvedValue(
      makeLoopState('1', {
        lifecycle: 'stopped',
        snapshot: { status: 'active', value: { 'step::1': 'idle' }, context: {} },
      }),
    );

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(steps),
      '/tmp',
      false,
      asEmitter(mockEmitter),
    );

    expect(result).toBe('stopped');
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'RUNBOOK_STOPPED',
      payload: expect.objectContaining({ position: expect.any(Object) }),
    });
    expect(
      (mockEmitter.emit as jest.Mock).mock.calls.filter(
        (c) => (c[0] as { type?: string } | undefined)?.type === 'STEP_TRANSITIONED',
      ),
    ).toHaveLength(0);
  });

  it('prompted-for step returns waiting without CLI prompted mode', async () => {
    const promptedForSteps = [
      {
        kind: 'prompted-for',
        name: '1',
        description: 'Process items',
        prompt: 'FOR item IN 1 TO {{N}}',
        substeps: [
          {
            id: '1',
            description: 'Handle {{item}}',
            command: { code: 'rd echo item={{item}}', lang: 'bash' },
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
        ],
        transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
      },
    ];

    mockManager.load.mockResolvedValue(makeLoopState('1', { substep: '1' }));

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(promptedForSteps),
      '/tmp',
      false, // prompted=false — step itself gates execution
      asEmitter(mockEmitter),
    );

    expect(result).toBe('waiting');
  });

  it('prompted-for step emits STEP_ENTERED with prompted: true', async () => {
    const promptedForSteps = [
      {
        kind: 'prompted-for',
        name: '1',
        description: 'Process items',
        prompt: 'FOR item IN 1 TO {{N}}',
        substeps: [
          {
            id: '1',
            description: 'Handle {{item}}',
            command: { code: 'rd echo item={{item}}', lang: 'bash' },
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
        ],
        transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
      },
    ];

    mockManager.load.mockResolvedValue(makeLoopState('1', { substep: '1' }));

    await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(promptedForSteps),
      '/tmp',
      false,
      asEmitter(mockEmitter),
    );

    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'STEP_ENTERED',
      payload: expect.objectContaining({
        prompted: true,
      }),
    });
  });

  it('prompted-for step falls back to step-level prompt', async () => {
    const promptedForSteps = [
      {
        kind: 'prompted-for',
        name: '1',
        description: 'Process items',
        prompt: 'FOR item IN 1 TO {{N}}',
        substeps: [
          {
            id: '1',
            description: 'Handle {{item}}',
            // substep has no prompt field — falls back to step prompt
            command: { code: 'rd echo item={{item}}', lang: 'bash' },
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
        ],
        transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
      },
    ];

    mockManager.load.mockResolvedValue(makeLoopState('1', { substep: '1' }));

    await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(promptedForSteps),
      '/tmp',
      false,
      asEmitter(mockEmitter),
    );

    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'STEP_ENTERED',
      payload: expect.objectContaining({
        prompt: 'FOR item IN 1 TO {{N}}',
      }),
    });
  });

  it('prompted-for step does not inject loop variables', async () => {
    const promptedForSteps = [
      {
        kind: 'prompted-for',
        name: '1',
        description: 'Process items',
        prompt: 'FOR item IN 1 TO {{N}}',
        substeps: [
          {
            id: '1',
            description: 'Handle {{item}}',
            command: { code: 'rd echo item={{item}}', lang: 'bash' },
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
        ],
        transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
      },
    ];

    mockManager.load.mockResolvedValue(makeLoopState('1', { substep: '1' }));

    await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(promptedForSteps),
      '/tmp',
      false,
      asEmitter(mockEmitter),
    );

    // {{item}} should stay literal since no forClause drives variable injection
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'STEP_ENTERED',
      payload: expect.objectContaining({
        description: 'Handle {{item}}',
        commandCode: 'rd echo item={{item}}',
      }),
    });
  });

  it('emits expanded command text in STEP_ENTERED payload for prompted mode', async () => {
    const forSteps = [
      {
        kind: 'for',
        name: '1',
        description: 'Process',
        forClause: { variable: 'item', start: 1, end: 1 },
        substeps: [
          {
            id: '1',
            description: 'Handle {{item}}',
            command: { code: 'rd echo item={{item}}', lang: 'bash' },
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
        ],
        transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
      },
    ];

    mockManager.load.mockResolvedValue(makeLoopState('1', { substep: '1' }));

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(forSteps),
      '/tmp',
      true,
      asEmitter(mockEmitter),
    );

    expect(result).toBe('waiting');
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'STEP_ENTERED',
      payload: expect.objectContaining({
        description: 'Handle 1',
        commandCode: 'rd echo item=1',
        prompted: true,
      }),
    });
  });

  describe('machine-driven auto-execution does not break on a step declaring OUTPUTS', () => {
    const stepsWithOutputs: any[] = [
      {
        kind: 'command',
        name: '1',
        description: 'Step 1 with outputs',
        command: { code: 'rd echo --result pass', lang: 'sh' },
        outputs: [{ name: 'PlanPath', value: '"plan-value"' }],
        transitions: {
          pass: { next: '2' },
          fail: { next: 'STOP' },
        },
      },
      {
        kind: 'base',
        name: '2',
        description: 'Step 2',
        transitions: {
          pass: { next: 'COMPLETE' },
          fail: { next: 'STOP' },
        },
      },
    ];

    it('runs command step auto-execution with PASS without errors when outputs declared', async () => {
      // orchestrateTransition calls manager.load once more (for the reloaded continue state),
      // so we need two sequential returns: step 1 (initial load) → step 2 (reload after transition).
      mockManager.load
        .mockResolvedValueOnce(makeLoopState('1', { templateVars: { ContextId: 'ctx-unit' } }))
        .mockResolvedValueOnce(makeLoopState('2', { templateVars: { ContextId: 'ctx-unit' } }));

      jest.mocked(core.executeCommand).mockResolvedValue({ success: true, exitCode: 0 });

      // Non-terminal snapshot (active/CONTINUE) → orchestrateTransition takes the reload path
      mockActorService.sendAndSync.mockResolvedValue({
        state: {
          ...makeLoopState('2', { templateVars: { ContextId: 'ctx-unit' } }),
        },
        snapshot: {
          status: 'active',
          value: '2',
          context: { lastAction: { type: 'CONTINUE', origin: 'direct' } },
        },
        effects: [commandCompletedEffect('pass')],
      });

      const result = await runExecutionLoop(
        asManager(mockManager),
        runbookId,
        asSteps(stepsWithOutputs),
        '/tmp',
        false,
        asEmitter(mockEmitter),
      );

      // OUTPUTS evaluation lives in the state machine; this is a regression
      // guard that the CLI auto-execution path still runs to completion when
      // a step declares outputs. Behavioral coverage is in integration tests.
      expect(result).not.toBe('stopped');
    });

    it('sends COMMAND_RESULT, not SET_VARIABLES or PASS, after a successful command with OUTPUTS', async () => {
      // Use the file-local `LooseStep` shape (Record<string, unknown>) — the
      // ExecutionLoop only inspects narrow surfaces, and `asSteps(...)` at
      // the call site casts through to `ResolvedStep[]` for the function
      // signature. This replaces a prior `any[]` annotation with a typed
      // structural mock.
      const stepsWithOutputsForCommandResult: LooseStep[] = [
        {
          kind: 'command',
          name: '1',
          description: 'Capture version',
          command: { code: 'printf v1 > "$RD_OUTPUTS_Version"', lang: 'sh' },
          outputs: [{ name: 'Version' }],
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' }, next: '2' },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' }, next: 'STOP' },
          },
        },
        {
          kind: 'base',
          name: '2',
          description: 'After capture',
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' }, next: 'COMPLETE' },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' }, next: 'STOP' },
          },
        },
      ];

      mockManager.load
        .mockResolvedValueOnce(makeLoopState('1', { templateVars: { ContextId: 'ctx-unit' } }))
        .mockResolvedValueOnce(
          makeLoopState('2', {
            variables: { Version: 'v1' },
            templateVars: { ContextId: 'ctx-unit' },
          }),
        );
      jest.mocked(core.executeCommand).mockResolvedValue({ success: true, exitCode: 0 });
      mockActorService.sendAndSync.mockResolvedValue({
        state: makeLoopState('2', {
          variables: { Version: 'v1' },
          templateVars: { ContextId: 'ctx-unit' },
        }),
        snapshot: {
          status: 'active',
          value: 'step::2',
          context: {
            lastAction: { type: 'CONTINUE', origin: 'direct' },
            variables: { Version: 'v1' },
          },
        },
        effects: [commandCompletedEffect('pass')],
      });

      const result = await runExecutionLoop(
        asManager(mockManager),
        runbookId,
        asSteps(stepsWithOutputsForCommandResult),
        '/tmp',
        false,
        asEmitter(mockEmitter),
      );

      expect(result).not.toBe('stopped');
      const events = mockActorService.sendAndSync.mock.calls.map((call: unknown[]) => call[2]);
      expect(events).toEqual([
        expect.objectContaining({
          type: 'EXECUTE_COMMAND',
          nakedOutputs: [{ name: 'Version' }],
        }),
      ]);
      expect(events).not.toContainEqual(expect.objectContaining({ type: 'SET_VARIABLES' }));
      expect(events).not.toContainEqual(expect.objectContaining({ type: 'PASS' }));
      expect(events).not.toContainEqual(expect.objectContaining({ type: 'FAIL' }));
      expect(mockLifecycleService.setLastResult).not.toHaveBeenCalled();
    });
  });

  it('includes machine-owned delegateFrontier in STEP_ENTERED when entering a DELEGATE step', async () => {
    const delegateSteps: any[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Parallel work',
        substeps: [
          {
            id: '1',
            description: 'First task',
            delegate: true,
            runbooks: ['child-a.runbook.md'],
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
          {
            id: '2',
            description: 'Second task',
            delegate: true,
            runbooks: ['child-b.runbook.md'],
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
        ],
        transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
      },
    ];

    mockManager.load.mockResolvedValue(makeLoopState('1', { substep: '1', substepStates: [] }));

    mockActorService.getContextSnapshot.mockResolvedValue({
      delegateFrontier: [
        { id: '1.1', runbook: 'child-a.runbook.md', token: 'rdtk_aaaa1111' },
        { id: '1.2', runbook: 'child-b.runbook.md', token: 'rdtk_bbbb2222' },
      ],
    });
    mockActorService.sendAndSync.mockResolvedValue({
      state: { id: runbookId, step: '1', substep: '1', status: 'running' },
      snapshot: {},
    });

    await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(delegateSteps),
      '/tmp',
      false,
      asEmitter(mockEmitter),
    );

    // STEP_ENTERED should have been emitted with delegateFrontier
    const stepEnteredCall = mockEmitter.emit.mock.calls.find(
      (call) => call[0].type === 'STEP_ENTERED',
    );
    expect(stepEnteredCall).toBeDefined();
    // STEP_ENTERED payload shape is the test contract — mockEmitter.emit's
    // `payload?: unknown` parameter is intentionally permissive, so this
    // narrows to the fields the test actually asserts on.
    const payload = stepEnteredCall![0].payload as {
      delegateFrontier?: { id: string; runbook: string; token: string }[];
    };

    expect(payload.delegateFrontier).toBeDefined();
    expect(payload.delegateFrontier).toHaveLength(2);

    expect(payload.delegateFrontier![0]).toMatchObject({
      id: '1.1',
      runbook: 'child-a.runbook.md',
      token: 'rdtk_aaaa1111',
    });
    expect(payload.delegateFrontier![1]).toMatchObject({
      id: '1.2',
      runbook: 'child-b.runbook.md',
      token: 'rdtk_bbbb2222',
    });

    expect(core.createDelegation).not.toHaveBeenCalled();
  });

  it('STEP_ENTERED uses delegateFrontier from context when present', async () => {
    const delegateSteps: any[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Parallel work',
        substeps: [
          {
            id: '1',
            description: 'First task',
            delegate: true,
            runbooks: ['child-a.runbook.md'],
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
          {
            id: '2',
            description: 'Second task',
            delegate: true,
            runbooks: ['child-b.runbook.md'],
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
        ],
        transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
      },
    ];

    mockManager.load.mockResolvedValue(makeLoopState('1', { substep: '1', substepStates: [] }));

    const preIssued = [
      { id: '1.1', runbook: 'child-a.runbook.md', token: 'rdtk_retry_a' },
      { id: '1.2', runbook: 'child-b.runbook.md', token: 'rdtk_retry_b' },
    ];

    mockActorService.getContextSnapshot.mockResolvedValue({
      delegateFrontier: preIssued,
    });
    mockActorService.sendAndSync.mockResolvedValue({
      state: { id: runbookId, step: '1', substep: '1', status: 'running' },
      snapshot: {},
    });

    await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(delegateSteps),
      '/tmp',
      false,
      asEmitter(mockEmitter),
    );

    // STEP_ENTERED payload should carry the pre-issued frontier
    const stepEnteredCall = mockEmitter.emit.mock.calls.find(
      (call) => call[0].type === 'STEP_ENTERED',
    );
    expect(stepEnteredCall).toBeDefined();
    const payload = stepEnteredCall![0].payload as { delegateFrontier?: unknown };

    expect(payload.delegateFrontier).toEqual(preIssued);

    expect(core.createDelegation).not.toHaveBeenCalled();
    expect(mockActorService.sendAndSync).toHaveBeenCalledWith(runbookId, delegateSteps, {
      type: 'DELEGATE_FRONTIER_CONSUMED',
    });
  });

  it('rolls back existing inline child session activation when intent consumption fails', async () => {
    const childRunId = actualCore.assertRunId(`rd_${'2'.repeat(32)}`);
    const inlineLaunch = {
      parentRunId: runbookId,
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: '1|',
      parentEntry: 1,
      childRunId,
      childRunbookPath: 'child.runbook.md',
      childRunbookRef: { source: 'project', path: 'child.runbook.md' },
      contextSnapshot: {
        RunId: runbookId,
        ContextId: 'ctx-unit',
        WorkPath: '.rundown/work',
      },
    };
    const inlineSteps: LooseStep[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Parent step',
        substeps: [
          {
            id: '1',
            description: 'Inline child',
            runbooks: ['child.runbook.md'],
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
        ],
        transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
      },
    ];
    const parentLinkage = {
      kind: 'inline',
      parentRunId: runbookId,
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: '1|',
      parentEntry: 1,
    };
    const parentState = makeLoopState('1', {
      lifecycle: 'running',
      substep: '1',
      activeFrameKey: '1|',
      activeEntry: 1,
      substepStates: [
        {
          id: '1',
          frameKey: '1|',
          status: 'running',
          inline: {
            childRunbookPath: 'child.runbook.md',
            childRunbookRef: { source: 'project', path: 'child.runbook.md' },
            contextSnapshot: inlineLaunch.contextSnapshot,
            childRunId,
            createdAt: '2026-05-30T00:00:00.000Z',
            startedAt: null,
          },
        },
      ],
      snapshot: { context: { inlineLaunchIntent: inlineLaunch } },
    });
    const existingChild = {
      ...makeLoopState('1', {
        id: childRunId,
        lifecycle: 'running',
        parentLinkage,
      }),
      runbookSrc: '## 1. Child\nDone',
    };
    mockManager.load
      .mockResolvedValueOnce(parentState)
      .mockResolvedValueOnce(parentState)
      .mockResolvedValueOnce(existingChild);
    mockSessionService.getActive
      .mockResolvedValueOnce({ id: runbookId })
      .mockResolvedValueOnce({ id: childRunId });
    mockActorService.observeExecutionUnitEntry.mockResolvedValueOnce([
      {
        kind: 'execution_observation',
        event: {
          type: 'STEP_ENTERED',
          payload: {
            position: { current: '1.1', total: 1 },
            stepName: '1',
            description: 'Inline child',
            isSubstep: true,
            inlineLaunch,
          },
        },
      },
    ]);
    mockActorService.sendAndSync
      .mockResolvedValueOnce({ state: parentState, snapshot: {} })
      .mockRejectedValueOnce(new Error('consume failed'));

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(inlineSteps),
      mockManager.cwd,
      false,
      asEmitter(mockEmitter),
      { output: { executionEvent: jest.fn() } as never },
    );

    expect(result).toBe('stopped');
    expect(mockSessionService.pushRunbook).toHaveBeenCalledWith(childRunId);
    expect(mockSessionService.getActive).toHaveBeenCalledTimes(2);
    expect(mockSessionService.popRunbook).toHaveBeenCalledWith();
    expect(mockSessionService.releaseRunbook).not.toHaveBeenCalledWith(childRunId);
    expect(mockManager.delete).not.toHaveBeenCalledWith(childRunId);
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'ERROR_OCCURRED',
      payload: expect.objectContaining({
        code: core.ErrorCodes.LAUNCH_FAILED.code,
        message: expect.stringContaining('consume failed'),
      }),
    });
    expect(mockActorService.sendAndSync).toHaveBeenNthCalledWith(
      1,
      runbookId,
      inlineSteps,
      expect.objectContaining({ type: 'INLINE_CHILD_STARTED' }),
    );
    expect(mockActorService.sendAndSync).toHaveBeenNthCalledWith(2, runbookId, inlineSteps, {
      type: 'INLINE_LAUNCH_CONSUMED',
    });
    expect(mockActorService.observeExecutionUnitEntry).toHaveBeenCalledTimes(1);
  });

  it('repairs existing inline child startedAt, activates child, then consumes intent', async () => {
    const childRunId = actualCore.assertRunId(`rd_${'2'.repeat(32)}`);
    const inlineLaunch = {
      parentRunId: runbookId,
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: '1|',
      parentEntry: 1,
      childRunId,
      childRunbookPath: 'child.runbook.md',
      childRunbookRef: { source: 'project', path: 'child.runbook.md' },
      contextSnapshot: {
        RunId: runbookId,
        ContextId: 'ctx-unit',
        WorkPath: '.rundown/work',
      },
    };
    const inlineSteps: LooseStep[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Parent step',
        substeps: [
          {
            id: '1',
            description: 'Inline child',
            runbooks: ['child.runbook.md'],
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
        ],
        transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
      },
    ];
    const parentLinkage = {
      kind: 'inline',
      parentRunId: runbookId,
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: '1|',
      parentEntry: 1,
    };
    const parentState = makeLoopState('1', {
      lifecycle: 'running',
      substep: '1',
      activeFrameKey: '1|',
      activeEntry: 1,
      substepStates: [
        {
          id: '1',
          frameKey: '1|',
          status: 'running',
          inline: {
            childRunbookPath: 'child.runbook.md',
            childRunbookRef: { source: 'project', path: 'child.runbook.md' },
            contextSnapshot: inlineLaunch.contextSnapshot,
            childRunId,
            createdAt: '2026-05-30T00:00:00.000Z',
            startedAt: null,
          },
        },
      ],
      snapshot: { context: { inlineLaunchIntent: inlineLaunch } },
    });
    const existingChild = {
      ...makeLoopState('1', {
        id: childRunId,
        lifecycle: 'running',
        parentLinkage,
      }),
      runbookSrc: '## 1. Child\nDone',
    };

    mockManager.load
      .mockResolvedValueOnce(parentState)
      .mockResolvedValueOnce(parentState)
      .mockResolvedValueOnce(existingChild)
      .mockResolvedValue(existingChild);
    mockSessionService.getActive.mockResolvedValueOnce({ id: runbookId });
    mockSessionService.pushRunbook.mockResolvedValueOnce(undefined);
    mockActorService.observeExecutionUnitEntry.mockResolvedValueOnce([
      {
        kind: 'execution_observation',
        event: {
          type: 'STEP_ENTERED',
          payload: {
            position: { current: '1.1', total: 1 },
            stepName: '1',
            description: 'Inline child',
            isSubstep: true,
            inlineLaunch,
          },
        },
      },
    ]);
    mockActorService.sendAndSync
      .mockResolvedValueOnce({ state: parentState, snapshot: {} })
      .mockResolvedValueOnce({ state: parentState, snapshot: {} });

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(inlineSteps),
      mockManager.cwd,
      false,
      asEmitter(mockEmitter),
      { output: { executionEvent: jest.fn() } as never },
    );

    expect(result).toBe('waiting');
    expect(mockActorService.sendAndSync).toHaveBeenNthCalledWith(
      1,
      runbookId,
      inlineSteps,
      expect.objectContaining({
        type: 'INLINE_CHILD_STARTED',
        parentStepId: '1',
        parentFrameKey: '1|',
        childRunId,
      }),
    );
    expect(mockSessionService.pushRunbook).toHaveBeenCalledWith(childRunId);
    expect(mockActorService.sendAndSync).toHaveBeenNthCalledWith(2, runbookId, inlineSteps, {
      type: 'INLINE_LAUNCH_CONSUMED',
    });
  });

  it('propagates blocked inline child terminal instead of treating child completion as success', async () => {
    const childRunId = actualCore.assertRunId(`rd_${'2'.repeat(32)}`);
    const inlineLaunch = {
      parentRunId: runbookId,
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: '1|',
      parentEntry: 1,
      childRunId,
      childRunbookPath: 'child.runbook.md',
      childRunbookRef: { source: 'project', path: 'child.runbook.md' },
      contextSnapshot: {
        RunId: runbookId,
        ContextId: 'ctx-unit',
        WorkPath: '.rundown/work',
      },
    };
    const inlineSteps: LooseStep[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Parent step',
        substeps: [
          {
            id: '1',
            description: 'Inline child',
            runbooks: ['child.runbook.md'],
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
        ],
        transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
      },
    ];
    const parentLinkage = {
      kind: 'inline',
      parentRunId: runbookId,
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: '1|',
      parentEntry: 1,
    };
    const parentState = makeLoopState('1', {
      lifecycle: 'running',
      substep: '1',
      activeFrameKey: '1|',
      activeEntry: 1,
      substepStates: [
        {
          id: '1',
          frameKey: '1|',
          status: 'running',
          inline: {
            childRunbookPath: 'child.runbook.md',
            childRunbookRef: { source: 'project', path: 'child.runbook.md' },
            contextSnapshot: inlineLaunch.contextSnapshot,
            childRunId,
            createdAt: '2026-05-30T00:00:00.000Z',
            startedAt: '2026-05-30T00:00:01.000Z',
          },
        },
      ],
      snapshot: { context: { inlineLaunchIntent: inlineLaunch } },
    });
    const existingChild = {
      ...makeLoopState('1', {
        id: childRunId,
        lifecycle: 'completed',
        parentLinkage,
      }),
      runbookSrc: '## 1. Child\nDone',
    };

    mockManager.load
      .mockResolvedValueOnce(parentState)
      .mockResolvedValueOnce(parentState)
      .mockResolvedValueOnce(existingChild)
      .mockResolvedValue(existingChild);
    mockSessionService.getActive.mockResolvedValueOnce({ id: runbookId });
    mockActorService.observeExecutionUnitEntry.mockResolvedValueOnce([
      {
        kind: 'execution_observation',
        event: {
          type: 'STEP_ENTERED',
          payload: {
            position: { current: '1.1', total: 1 },
            stepName: '1',
            description: 'Inline child',
            isSubstep: true,
            inlineLaunch,
          },
        },
      },
    ]);
    mockActorService.sendAndSync.mockResolvedValueOnce({ state: parentState, snapshot: {} });
    mockCompletionService.recordChildCompletion.mockResolvedValueOnce('blocked');
    const output = {
      executionEvent: jest.fn(),
      flush: jest.fn(),
    };

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(inlineSteps),
      mockManager.cwd,
      false,
      asEmitter(mockEmitter),
      { output: output as never },
    );

    expect(result).toBe('stopped');
    expect(mockCompletionService.recordChildCompletion).toHaveBeenCalledWith({
      childState: existingChild,
      result: 'pass',
    });
    expect(output.flush).toHaveBeenCalled();
  });

  it('does not consume existing inline child intent when session activation fails', async () => {
    const childRunId = actualCore.assertRunId(`rd_${'3'.repeat(32)}`);
    const inlineLaunch = {
      parentRunId: runbookId,
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: '1|',
      parentEntry: 1,
      childRunId,
      childRunbookPath: 'child.runbook.md',
      childRunbookRef: { source: 'project', path: 'child.runbook.md' },
      contextSnapshot: {
        RunId: runbookId,
        ContextId: 'ctx-unit',
        WorkPath: '.rundown/work',
      },
    };
    const inlineSteps: LooseStep[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Parent step',
        substeps: [
          {
            id: '1',
            description: 'Inline child',
            runbooks: ['child.runbook.md'],
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
        ],
        transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
      },
    ];
    const parentLinkage = {
      kind: 'inline',
      parentRunId: runbookId,
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: '1|',
      parentEntry: 1,
    };
    const parentState = makeLoopState('1', {
      lifecycle: 'running',
      substep: '1',
      activeFrameKey: '1|',
      activeEntry: 1,
      substepStates: [
        {
          id: '1',
          frameKey: '1|',
          status: 'running',
          inline: {
            childRunbookPath: 'child.runbook.md',
            childRunbookRef: { source: 'project', path: 'child.runbook.md' },
            contextSnapshot: inlineLaunch.contextSnapshot,
            childRunId,
            createdAt: '2026-05-30T00:00:00.000Z',
            startedAt: '2026-05-30T00:00:01.000Z',
          },
        },
      ],
      snapshot: { context: { inlineLaunchIntent: inlineLaunch } },
    });
    const existingChild = {
      ...makeLoopState('1', {
        id: childRunId,
        lifecycle: 'running',
        parentLinkage,
      }),
      runbookSrc: '## 1. Child\nDone',
    };

    mockManager.load
      .mockResolvedValueOnce(parentState)
      .mockResolvedValueOnce(parentState)
      .mockResolvedValueOnce(existingChild);
    mockSessionService.getActive.mockResolvedValueOnce({ id: runbookId });
    mockSessionService.pushRunbook.mockRejectedValueOnce(new Error('session push failed'));
    mockActorService.observeExecutionUnitEntry.mockResolvedValueOnce([
      {
        kind: 'execution_observation',
        event: {
          type: 'STEP_ENTERED',
          payload: {
            position: { current: '1.1', total: 1 },
            stepName: '1',
            description: 'Inline child',
            isSubstep: true,
            inlineLaunch,
          },
        },
      },
    ]);

    await expect(
      runExecutionLoop(
        asManager(mockManager),
        runbookId,
        asSteps(inlineSteps),
        mockManager.cwd,
        false,
        asEmitter(mockEmitter),
        { output: {} as never },
      ),
    ).rejects.toThrow('session push failed');

    expect(mockActorService.sendAndSync).not.toHaveBeenCalledWith(runbookId, inlineSteps, {
      type: 'INLINE_LAUNCH_CONSUMED',
    });
  });

  it('skips stale existing inline child intents that were already consumed', async () => {
    const childRunId = actualCore.assertRunId(`rd_${'2'.repeat(32)}`);
    const inlineLaunch = {
      parentRunId: runbookId,
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: '1|',
      parentEntry: 1,
      childRunId,
      childRunbookPath: 'child.runbook.md',
      childRunbookRef: { source: 'project', path: 'child.runbook.md' },
      contextSnapshot: {
        RunId: runbookId,
        ContextId: 'ctx-unit',
        WorkPath: '.rundown/work',
      },
    };
    const inlineSteps: LooseStep[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Parent step',
        substeps: [
          {
            id: '1',
            description: 'Inline child',
            runbooks: ['child.runbook.md'],
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
        ],
        transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
      },
    ];
    const parentState = makeLoopState('1', {
      lifecycle: 'running',
      substep: '1',
      activeFrameKey: '1|',
      activeEntry: 1,
      snapshot: { context: { inlineLaunchIntent: undefined } },
    });
    mockManager.load.mockResolvedValue(parentState);
    mockActorService.observeExecutionUnitEntry.mockResolvedValueOnce([
      {
        kind: 'execution_observation',
        event: {
          type: 'STEP_ENTERED',
          payload: {
            position: { current: '1.1', total: 1 },
            stepName: '1',
            description: 'Inline child',
            isSubstep: true,
            inlineLaunch,
          },
        },
      },
    ]);

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(inlineSteps),
      mockManager.cwd,
      false,
      asEmitter(mockEmitter),
      { output: {} as never },
    );

    expect(result).toBe('waiting');
    expect(mockActorService.sendAndSync).not.toHaveBeenCalledWith(runbookId, inlineSteps, {
      type: 'INLINE_LAUNCH_CONSUMED',
    });
    expect(mockSessionService.pushRunbook).not.toHaveBeenCalled();
  });

  it('consumes delegateFrontier after emitting STEP_ENTERED so tokens are not re-emitted', async () => {
    const delegateSteps: any[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Parallel work',
        substeps: [
          {
            id: '1',
            description: 'First task',
            delegate: true,
            runbooks: ['child-a.runbook.md'],
            transitions: { pass: { next: '2' }, fail: { next: 'STOP' } },
          },
          {
            id: '2',
            description: 'Follow-up',
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
        ],
        transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
      },
    ];

    mockManager.load.mockResolvedValue(makeLoopState('1', { substep: '1', substepStates: [] }));

    mockActorService.getContextSnapshot.mockResolvedValue({
      delegateFrontier: [{ id: '1.1', runbook: 'child-a.runbook.md', token: 'rdtk_retry_a' }],
    });
    mockActorService.sendAndSync.mockResolvedValue({
      state: { id: runbookId, step: '1', substep: '1', status: 'running' },
      snapshot: {},
    });

    await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(delegateSteps),
      '/tmp',
      true,
      asEmitter(mockEmitter),
    );

    const stepEnteredCall = mockEmitter.emit.mock.calls.find(
      (call) => call[0].type === 'STEP_ENTERED',
    );
    expect(stepEnteredCall).toBeDefined();
    const payload = stepEnteredCall![0].payload as { delegateFrontier?: unknown };
    expect(payload.delegateFrontier).toEqual([
      { id: '1.1', runbook: 'child-a.runbook.md', token: 'rdtk_retry_a' },
    ]);

    expect(mockActorService.sendAndSync).toHaveBeenCalledWith(runbookId, delegateSteps, {
      type: 'DELEGATE_FRONTIER_CONSUMED',
    });
  });

  it('STEP_ENTERED does not issue delegations when delegateFrontier is absent', async () => {
    const delegateSteps: any[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Parallel work',
        substeps: [
          {
            id: '1',
            description: 'First task',
            delegate: true,
            runbooks: ['child-a.runbook.md'],
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
        ],
        transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
      },
    ];

    mockManager.load.mockResolvedValue(makeLoopState('1', { substep: '1', substepStates: [] }));

    mockActorService.getContextSnapshot.mockResolvedValue({});

    await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(delegateSteps),
      '/tmp',
      false,
      asEmitter(mockEmitter),
    );

    const stepEnteredCall = mockEmitter.emit.mock.calls.find(
      (call) => call[0].type === 'STEP_ENTERED',
    );
    expect(stepEnteredCall).toBeDefined();
    const payload = stepEnteredCall![0].payload as { delegateFrontier?: unknown };
    expect(payload.delegateFrontier).toBeUndefined();
    expect(core.createDelegation).not.toHaveBeenCalled();
  });

  it('emits machine-produced nested_delegation_forbidden stop reason', async () => {
    const delegateSteps: any[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Parallel work',
        substeps: [
          {
            id: '1',
            description: 'First task',
            delegate: true,
            runbooks: ['child-a.runbook.md'],
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
        ],
        transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
      },
    ];

    mockManager.load.mockResolvedValue({
      id: runbookId,
      step: '1',
      substep: '1',
      lifecycle: 'stopped',
      retryCount: 0,
      snapshot: {
        status: 'done',
        value: 'STOPPED',
        context: {
          lastAction: {
            type: 'DELEGATION_ISSUANCE_FAILED',
            origin: 'direct',
            reason: 'nested_delegation_forbidden',
            message: 'Nested delegation forbidden',
          },
        },
      },
    });

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(delegateSteps),
      '/tmp',
      false,
      asEmitter(mockEmitter),
    );

    expect(result).toBe('stopped');

    // RUNBOOK_STOPPED carries the discriminated reason — not the generic
    // 'delegation_resolution_failed' fallback.
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'ERROR_OCCURRED',
      payload: expect.objectContaining({
        message: 'Nested delegation forbidden',
      }),
    });
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'RUNBOOK_STOPPED',
      payload: expect.objectContaining({
        reason: 'nested_delegation_forbidden',
      }),
    });
  });
});

describe('executeCommandWithPolicyCheck', () => {
  const command = 'echo test';
  const cwd = '/tmp';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('calls executeCommand directly if policy is not enforced', async () => {
    jest.mocked(policyContext.isPolicyEnforced).mockReturnValue(false);
    jest
      .mocked(core.executeCommand)
      .mockResolvedValue({ success: true } as unknown as Awaited<
        ReturnType<typeof core.executeCommand>
      >);

    await executeCommandWithPolicyCheck(command, cwd);

    expect(core.executeCommand).toHaveBeenCalledWith(command, cwd, undefined, {});
    expect(core.executeCommandWithEnv).not.toHaveBeenCalled();
    expect(core.executeCommandWithPolicy).not.toHaveBeenCalled();
  });

  it('calls executeCommandWithPolicy if policy is enforced', async () => {
    jest.mocked(policyContext.isPolicyEnforced).mockReturnValue(true);
    // PolicyEvaluator has many methods; the production CLI only invokes
    // setRunbookPath here so we cast through unknown to keep the partial.
    const mockEvaluator = { setRunbookPath: jest.fn() };
    jest
      .mocked(policyContext.getPolicyEvaluator)
      .mockReturnValue(
        mockEvaluator as unknown as ReturnType<typeof policyContext.getPolicyEvaluator>,
      );
    // PolicyPrompter is a structural object; the test only stores a sentinel
    // string and asserts identity through the call chain.
    jest
      .mocked(policyContext.getPolicyPrompter)
      .mockReturnValue('prompter' as unknown as ReturnType<typeof policyContext.getPolicyPrompter>);
    jest.mocked(policyContext.getSandboxOptions).mockReturnValue({
      sandbox: true,
      sandboxStrict: true,
    });
    jest
      .mocked(core.executeCommandWithPolicy)
      .mockResolvedValue({ success: true } as unknown as Awaited<
        ReturnType<typeof core.executeCommandWithPolicy>
      >);

    await executeCommandWithPolicyCheck(command, cwd, 'test.md');

    expect(mockEvaluator.setRunbookPath).toHaveBeenCalledWith('test.md');
    expect(core.executeCommandWithPolicy).toHaveBeenCalledWith(
      command,
      cwd,
      expect.objectContaining({
        evaluator: mockEvaluator,
        prompter: 'prompter',
        sandbox: true,
        sandboxStrict: true,
      }),
    );
  });

  it('calls executeCommandWithEnv when policy is not enforced but rdInjected is non-empty', async () => {
    mockedPolicyContext.isPolicyEnforced.mockReturnValue(false);
    const rdInjected = { RD_OUTPUTS_Foo: '/tmp/foo' };
    (core.executeCommandWithEnv as any).mockResolvedValue({ success: true, exitCode: 0 });

    await executeCommandWithPolicyCheck(command, cwd, undefined, rdInjected);

    expect(core.executeCommandWithEnv).toHaveBeenCalledWith(
      command,
      cwd,
      expect.objectContaining({ RD_OUTPUTS_Foo: '/tmp/foo' }),
      {},
    );
    expect(core.executeCommand).not.toHaveBeenCalled();
    expect(core.executeCommandWithPolicy).not.toHaveBeenCalled();
  });
});
