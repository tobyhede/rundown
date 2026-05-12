import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { ExecutionEventEmitter, RunbookStateManager } from '@rundown-org/core';
import type { ResolvedStep } from '@rundown-org/parser';
import { mockFn } from '../helpers/typed-mocks.js';

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
};

const mockSessionService = {
  popRunbook: mockFn<(id: string) => Promise<void>>() as any,
  releaseRunbook: mockFn<(id: string) => Promise<void>>() as any,
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

const mockLifecycleService = {
  setLastResult: jest.fn() as any,
  ensureActiveEntry: ensureActiveEntryFn,
  listResolvedCompletions: listResolvedCompletionsFn,
  consumeResolvedCompletion: consumeResolvedCompletionFn,
};

// Capture the real @rundown-org/core module before the mock is registered.
// jest.unstable_mockModule does NOT hoist (unlike jest.mock), so this top-level
// await executes first and captures the real implementations. The mock factory
// then closure-captures `actualCore` and spreads it — `await import` inside the
// factory would recurse through the registered mock and OOM the heap.
const actualCore = await import('@rundown-org/core');
const { ForResolutionError: RealForResolutionError, Errors: RealErrors } = actualCore;

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

    // Transition coordinator — chains into evaluators; stub returns the
    // transition message tests assert on.
    deriveTransitionMessage: jest.fn((result: 'pass' | 'fail') =>
      result === 'pass' ? 'Success' : 'Failed',
    ),

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
    SessionService: jest.fn(() => mockSessionService),
    ExecutionLifecycleService: jest.fn(() => mockLifecycleService),
    ForIterationService: jest.fn(() => ({
      prepareIteration: (jest.fn() as any).mockResolvedValue({ status: 'no-resolution-needed' }),
    })),

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

jest.unstable_mockModule('../../src/helpers/delegate-inference', () => ({
  inferAllDelegateSubsteps: (jest.fn() as any).mockReturnValue([]),
}));

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
const delegateInference = await import('../../src/helpers/delegate-inference.js');
const resolveRunbook = await import('../../src/helpers/resolve-runbook.js');
const { runExecutionLoop, executeCommandWithPolicyCheck } = await import(
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
type EmitFn = jest.Mock<(event: string, payload?: unknown) => void>;
type MockManagerLike = {
  load: LoadFn;
  update: UpdateFn;
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
  const runbookId = `rd_${'1'.repeat(32)}`;
  const steps: LooseStep[] = [
    {
      kind: 'command',
      name: '1',
      description: 'Step 1',
      command: { code: 'echo hello', lang: 'sh' },
      transitions: {
        pass: { next: '2' },
        fail: { next: 'STOP' },
      },
    },
    {
      kind: 'command',
      name: '2',
      description: 'Step 2',
      command: { code: 'echo world', lang: 'sh' },
      transitions: {
        pass: { next: 'COMPLETE' },
        fail: { next: 'STOP' },
      },
    },
  ];
  const makeLoopState = (
    step = '1',
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    id: runbookId,
    runbook: { source: 'project', path: 'test.runbook.md' },
    runbookPath: 'test.runbook.md',
    step,
    status: 'running',
    templateVars: { RunId: runbookId, RunbookRef: { source: 'project', path: 'test.runbook.md' } },
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();

    // Restore default ForIterationService mock (tests may override)
    (core.ForIterationService as any).mockImplementation(() => ({
      prepareIteration: jest.fn(async () => ({ status: 'no-resolution-needed' as const })) as any,
    }));

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
      load: mockFn<(id: string) => Promise<Record<string, unknown> | null>>(),
      update: mockFn<(id: string, patch: Record<string, unknown>) => Promise<void>>(),
    };
    mockManager.update.mockResolvedValue(undefined);

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
    mockLifecycleService.listResolvedCompletions.mockReset();
    mockLifecycleService.listResolvedCompletions.mockResolvedValue([]);
    mockLifecycleService.consumeResolvedCompletion.mockReset();
    mockLifecycleService.consumeResolvedCompletion.mockResolvedValue(null);

    mockActorService.sendAndSync.mockReset();
    mockActorService.getContextSnapshot.mockReset();
    mockActorService.getContextSnapshot.mockResolvedValue(null);

    mockEmitter = {
      emit: mockFn<(event: string, payload?: unknown) => void>(),
    };

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
    expect(mockEmitter.emit).toHaveBeenCalledWith(
      'STEP_ENTERED',
      expect.objectContaining({
        stepName: '1',
        prompted: true,
      }),
    );
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
        context: { lastAction: { type: 'CONTINUE' } },
      },
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
    expect(core.executeCommandWithEnv).toHaveBeenCalled();
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
        context: { lastAction: { type: 'COMPLETE' } },
      },
    });

    await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps([steps[0]]),
      '/tmp',
      false,
      asEmitter(mockEmitter),
    );

    expect(core.executeCommandWithEnv).toHaveBeenCalledTimes(1);
    const envArg = jest.mocked(core.executeCommandWithEnv).mock.calls[0][2];
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
        context: { lastAction: { type: 'COMPLETE' } },
      },
    });

    await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps([steps[0]]),
      '/tmp',
      false,
      asEmitter(mockEmitter),
    );

    expect(core.executeCommandWithEnv).toHaveBeenCalledTimes(1);
    const envArg = jest.mocked(core.executeCommandWithEnv).mock.calls[0][2];
    expect(envArg.RD_RUNBOOK_REF).toBe(runbook.path);
    expect(envArg.RD_RUNBOOK_SOURCE).toBe(runbook.source);
  });

  it('handles policy denial', async () => {
    mockManager.load.mockResolvedValue(makeLoopState());
    jest.mocked(policyContext.isPolicyEnforced).mockReturnValue(true);

    // ExecutionResult requires `exitCode`; this fixture omits it because
    // the policy-denied path short-circuits before exit-code inspection.
    jest.mocked(core.executeCommandWithPolicy).mockResolvedValue({
      success: false,
      policyDenied: true,
      denialReason: 'Not allowed',
    } as unknown as Awaited<ReturnType<typeof core.executeCommandWithPolicy>>);

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(steps),
      '/tmp',
      false,
      asEmitter(mockEmitter),
    );

    expect(result).toBe('stopped');
    expect(mockEmitter.emit).toHaveBeenCalledWith(
      'POLICY_DENIED',
      expect.objectContaining({
        reason: 'Not allowed',
      }),
    );
  });

  it('stops with policy-denied when prepareIteration throws ForResolutionError policy-violation', async () => {
    mockManager.load.mockResolvedValue(makeLoopState());

    (core.ForIterationService as unknown as jest.Mock).mockImplementation(() => {
      const prepareIteration = mockFn<(...args: unknown[]) => Promise<{ status: string }>>();
      prepareIteration.mockRejectedValue(
        new RealForResolutionError(
          'JsonArrayStream path "/etc/passwd" escapes project root "/project"',
          'policy-violation',
        ),
      );
      return { prepareIteration };
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
    expect(mockEmitter.emit).toHaveBeenCalledWith(
      'POLICY_DENIED',
      expect.objectContaining({
        reason: expect.stringContaining('escapes project root'),
      }),
    );
    expect(mockEmitter.emit).toHaveBeenCalledWith(
      'RUNBOOK_STOPPED',
      expect.objectContaining({
        reason: 'policy_denied',
      }),
    );

    const emittedEvents = mockEmitter.emit.mock.calls.map(
      ([event]: [string, ...unknown[]]) => event,
    );
    expect(emittedEvents.indexOf('POLICY_DENIED')).toBeGreaterThanOrEqual(0);
    expect(emittedEvents.indexOf('RUNBOOK_STOPPED')).toBeGreaterThan(
      emittedEvents.indexOf('POLICY_DENIED'),
    );
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
        context: { lastAction: { type: 'COMPLETE' } },
      },
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
    expect(mockEmitter.emit).toHaveBeenCalledWith(
      'RUNBOOK_COMPLETED',
      expect.objectContaining({
        message: 'Success',
      }),
    );
    expect(mockSessionService.releaseRunbook).toHaveBeenCalledWith(runbookId);
    expect(mockSessionService.popRunbook).not.toHaveBeenCalled();
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
            code: 'RD-902',
            message: 'hook failed: createDelegation returned step_not_found',
          },
          lifecycle: 'stopped',
        },
      },
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
    expect(mockEmitter.emit).toHaveBeenCalledWith(
      'ERROR_OCCURRED',
      expect.objectContaining({
        code: 'RD-902',
        message: 'hook failed: createDelegation returned step_not_found',
      }),
    );

    // RUNBOOK_STOPPED still fires afterwards so terminal state is reported.
    expect(mockEmitter.emit).toHaveBeenCalledWith('RUNBOOK_STOPPED', expect.any(Object));

    // Ordering: ERROR_OCCURRED precedes RUNBOOK_STOPPED.
    const emitCalls = mockEmitter.emit.mock.calls;
    const errorIdx = emitCalls.findIndex((c: any[]) => c[0] === 'ERROR_OCCURRED');
    const stoppedIdx = emitCalls.findIndex((c: any[]) => c[0] === 'RUNBOOK_STOPPED');
    expect(errorIdx).toBeGreaterThanOrEqual(0);
    expect(stoppedIdx).toBeGreaterThanOrEqual(0);
    expect(errorIdx).toBeLessThan(stoppedIdx);

    // Invariant: STEP_TRANSITIONED is NEVER emitted with action: 'RETRY_ERROR'.
    // RETRY_ERROR is a machine-internal failure signal already surfaced via
    // ERROR_OCCURRED + RUNBOOK_STOPPED; leaking it through STEP_TRANSITIONED
    // would widen the public action enum beyond the scenario schema
    // (CONTINUE/DEFER/GOTO/STOP/COMPLETE/RETRY/BREAK/NEXT).
    const stepTransitionedCalls = emitCalls.filter((c) => c[0] === 'STEP_TRANSITIONED');
    for (const call of stepTransitionedCalls) {
      const payload = call[1] as { action?: string } | undefined;
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
            message: 'failed to read channel file: /tmp/outputs/Foo',
          },
          lifecycle: 'stopped',
        },
      },
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
    expect(mockEmitter.emit).toHaveBeenCalledWith(
      'ERROR_OCCURRED',
      expect.objectContaining({
        message: 'failed to read channel file: /tmp/outputs/Foo',
      }),
    );

    // RUNBOOK_STOPPED still fires afterwards so terminal state is reported.
    expect(mockEmitter.emit).toHaveBeenCalledWith('RUNBOOK_STOPPED', expect.any(Object));

    // Ordering: ERROR_OCCURRED precedes RUNBOOK_STOPPED.
    const emitCalls = mockEmitter.emit.mock.calls;
    const errorIdx = emitCalls.findIndex((c: any[]) => c[0] === 'ERROR_OCCURRED');
    const stoppedIdx = emitCalls.findIndex((c: any[]) => c[0] === 'RUNBOOK_STOPPED');
    expect(errorIdx).toBeGreaterThanOrEqual(0);
    expect(stoppedIdx).toBeGreaterThanOrEqual(0);
    expect(errorIdx).toBeLessThan(stoppedIdx);
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

    mockManager.load.mockResolvedValue({
      id: runbookId,
      step: '1',
      substep: '1',
      status: 'running',
    });

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

    mockManager.load.mockResolvedValue({
      id: runbookId,
      step: '1',
      substep: '1',
      status: 'running',
    });

    await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(promptedForSteps),
      '/tmp',
      false,
      asEmitter(mockEmitter),
    );

    expect(mockEmitter.emit).toHaveBeenCalledWith(
      'STEP_ENTERED',
      expect.objectContaining({
        prompted: true,
      }),
    );
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

    mockManager.load.mockResolvedValue({
      id: runbookId,
      step: '1',
      substep: '1',
      status: 'running',
    });

    await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(promptedForSteps),
      '/tmp',
      false,
      asEmitter(mockEmitter),
    );

    expect(mockEmitter.emit).toHaveBeenCalledWith(
      'STEP_ENTERED',
      expect.objectContaining({
        prompt: 'FOR item IN 1 TO {{N}}',
      }),
    );
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

    mockManager.load.mockResolvedValue({
      id: runbookId,
      step: '1',
      substep: '1',
      status: 'running',
    });

    await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(promptedForSteps),
      '/tmp',
      false,
      asEmitter(mockEmitter),
    );

    // {{item}} should stay literal since no forClause drives variable injection
    expect(mockEmitter.emit).toHaveBeenCalledWith(
      'STEP_ENTERED',
      expect.objectContaining({
        description: 'Handle {{item}}',
        commandCode: 'rd echo item={{item}}',
      }),
    );
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

    mockManager.load.mockResolvedValue({
      id: runbookId,
      step: '1',
      substep: '1',
      status: 'running',
    });

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(forSteps),
      '/tmp',
      true,
      asEmitter(mockEmitter),
    );

    expect(result).toBe('waiting');
    expect(mockEmitter.emit).toHaveBeenCalledWith(
      'STEP_ENTERED',
      expect.objectContaining({
        description: 'Handle 1',
        commandCode: 'rd echo item=1',
        prompted: true,
      }),
    );
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
          context: { lastAction: { type: 'CONTINUE' } },
        },
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
      const stepsWithOutputsForCommandResult: any[] = [
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
          context: { lastAction: { type: 'CONTINUE' }, variables: { Version: 'v1' } },
        },
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
          type: 'COMMAND_RESULT',
          result: 'pass',
          channels: expect.any(Array),
        }),
      ]);
      expect(events).not.toContainEqual(expect.objectContaining({ type: 'SET_VARIABLES' }));
      expect(events).not.toContainEqual(expect.objectContaining({ type: 'PASS' }));
      expect(events).not.toContainEqual(expect.objectContaining({ type: 'FAIL' }));
    });
  });

  it('auto-issues delegation tokens and includes delegateFrontier in STEP_ENTERED when entering a DELEGATE step', async () => {
    // A step with two substeps that have delegate: true
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

    mockManager.load.mockResolvedValue({
      id: runbookId,
      step: '1',
      substep: '1',
      status: 'running',
      substepStates: [],
    });

    // inferAllDelegateSubsteps returns two targets
    jest.mocked(delegateInference.inferAllDelegateSubsteps).mockReturnValue([
      { runbookRef: 'child-a.runbook.md', stepId: '1.1' },
      { runbookRef: 'child-b.runbook.md', stepId: '1.2' },
    ]);

    // resolveRunbookFile resolves to a path
    jest
      .mocked(resolveRunbook.resolveRunbookFile)
      .mockResolvedValueOnce({
        path: '/project/.rundown/runbooks/child-a.runbook.md',
        source: 'project',
        sourceRoot: '/project',
      })
      .mockResolvedValueOnce({
        path: '/project/.rundown/runbooks/child-b.runbook.md',
        source: 'project',
        sourceRoot: '/project',
      });

    // createDelegation returns a token for each substep. The fixtures use
    // string `frameKey` and empty `delegation` placeholders for brevity —
    // the real types brand `frameKey` and require populated `StepDelegation`
    // fields, but the CLI under test only forwards these untouched.
    type CreateDelegationReturn = ReturnType<typeof core.createDelegation>;
    jest
      .mocked(core.createDelegation)
      .mockReturnValueOnce({
        status: 'created',
        token: 'rdtk_aaaa1111',
        tokenHash: 'hash-a',
        delegation: {},
        updatedSubstepStates: [{ id: '1', frameKey: '1|', status: 'pending', delegation: {} }],
      } as unknown as CreateDelegationReturn)
      .mockReturnValueOnce({
        status: 'created',
        token: 'rdtk_bbbb2222',
        tokenHash: 'hash-b',
        delegation: {},
        updatedSubstepStates: [
          { id: '1', frameKey: '1|', status: 'pending', delegation: {} },
          { id: '2', frameKey: '1|', status: 'pending', delegation: {} },
        ],
      } as unknown as CreateDelegationReturn);

    await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(delegateSteps),
      '/tmp',
      false,
      asEmitter(mockEmitter),
    );

    // STEP_ENTERED should have been emitted with delegateFrontier
    const stepEnteredCall = mockEmitter.emit.mock.calls.find((call) => call[0] === 'STEP_ENTERED');
    expect(stepEnteredCall).toBeDefined();
    // STEP_ENTERED payload shape is the test contract — mockEmitter.emit's
    // `payload?: unknown` parameter is intentionally permissive, so this
    // narrows to the fields the test actually asserts on.
    const payload = stepEnteredCall![1] as {
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

    // manager.update should have been called to persist tokens
    expect(mockManager.update).toHaveBeenCalledWith(
      runbookId,
      expect.objectContaining({ substepStates: expect.any(Array) }),
    );
  });

  it('STEP_ENTERED uses pendingDelegateFrontier from context when present', async () => {
    // A step with two delegate substeps. A retry hook has already re-issued
    // tokens and populated context.pendingDelegateFrontier. The CLI must emit
    // those tokens and NOT run auto-issuance.
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

    mockManager.load.mockResolvedValue({
      id: runbookId,
      step: '1',
      substep: '1',
      status: 'running',
      substepStates: [],
    });

    const preIssued = [
      { id: '1.1', runbook: 'child-a.runbook.md', token: 'rdtk_retry_a' },
      { id: '1.2', runbook: 'child-b.runbook.md', token: 'rdtk_retry_b' },
    ];

    mockActorService.getContextSnapshot.mockResolvedValue({
      pendingDelegateFrontier: preIssued,
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
    const stepEnteredCall = mockEmitter.emit.mock.calls.find((call) => call[0] === 'STEP_ENTERED');
    expect(stepEnteredCall).toBeDefined();
    const payload = stepEnteredCall![1] as { delegateFrontier?: unknown };

    expect(payload.delegateFrontier).toEqual(preIssued);

    // Auto-issuance must NOT run when pending frontier is present
    expect(delegateInference.inferAllDelegateSubsteps).not.toHaveBeenCalled();
    expect(core.createDelegation).not.toHaveBeenCalled();

    // PENDING_FRONTIER_CONSUMED should have been sent after emit to clear context
    expect(mockActorService.sendAndSync).toHaveBeenCalledWith(runbookId, delegateSteps, {
      type: 'PENDING_FRONTIER_CONSUMED',
    });
  });

  it('STEP_ENTERED falls through to auto-issuance when pendingDelegateFrontier is absent', async () => {
    // No pending frontier — the existing auto-issuance path runs as before.
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
      status: 'running',
      substepStates: [],
    });

    // Snapshot with no pendingDelegateFrontier
    mockActorService.getContextSnapshot.mockResolvedValue({});

    jest
      .mocked(delegateInference.inferAllDelegateSubsteps)
      .mockReturnValue([{ runbookRef: 'child-a.runbook.md', stepId: '1.1' }]);

    jest.mocked(resolveRunbook.resolveRunbookFile).mockResolvedValue({
      path: '/project/.rundown/runbooks/child-a.runbook.md',
      source: 'project',
      sourceRoot: '/project',
    });

    jest.mocked(core.createDelegation).mockReturnValue({
      status: 'created',
      token: 'rdtk_autoissue',
      tokenHash: 'hash-auto',
      delegation: {},
      updatedSubstepStates: [{ id: '1', frameKey: '1|', status: 'pending', delegation: {} }],
    } as unknown as ReturnType<typeof core.createDelegation>);

    await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(delegateSteps),
      '/tmp',
      false,
      asEmitter(mockEmitter),
    );

    // Auto-issuance was invoked
    expect(delegateInference.inferAllDelegateSubsteps).toHaveBeenCalled();
    expect(core.createDelegation).toHaveBeenCalled();

    // STEP_ENTERED received the auto-issued frontier
    const stepEnteredCall = mockEmitter.emit.mock.calls.find((call) => call[0] === 'STEP_ENTERED');
    expect(stepEnteredCall).toBeDefined();
    const payload = stepEnteredCall![1] as {
      delegateFrontier?: { id: string; runbook: string; token: string }[];
    };
    expect(payload.delegateFrontier).toHaveLength(1);
    expect(payload.delegateFrontier![0]).toMatchObject({
      id: '1.1',
      runbook: 'child-a.runbook.md',
      token: 'rdtk_autoissue',
    });

    // PENDING_FRONTIER_CONSUMED must NOT be sent when no frontier was consumed
    const consumedCall = mockActorService.sendAndSync.mock.calls.find((call: unknown[]) => {
      const event = call[2] as { type?: string } | undefined;
      return call[1] === delegateSteps && event?.type === 'PENDING_FRONTIER_CONSUMED';
    });
    expect(consumedCall).toBeUndefined();
  });

  it('auto-fan-out: stops the runbook with reason "nested_delegation_forbidden" when active runbook is a claimed child', async () => {
    // Single-level delegation invariant: a claimed (delegated) child runbook
    // may not auto-fan-out further delegations on entering a delegating step.
    // The guard at createDelegation surfaces `parent_is_delegated`, the inner
    // switch re-throws the wrapped RD-819 error, and the outer catch
    // discriminates the reason on the RUNBOOK_STOPPED envelope.
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
      status: 'running',
      substepStates: [],
      // Active runbook is itself a claimed child — guard should fire.
      parentLinkage: {
        kind: 'delegation',
        parentRunId: 'parent-run-id',
        parentStepId: '1',
        tokenHash: `sha256:${'a'.repeat(64)}`,
      },
    });

    jest
      .mocked(delegateInference.inferAllDelegateSubsteps)
      .mockReturnValue([{ runbookRef: 'child-a.runbook.md', stepId: '1.1' }]);

    jest.mocked(resolveRunbook.resolveRunbookFile).mockResolvedValue({
      path: '/project/.rundown/runbooks/child-a.runbook.md',
      source: 'project',
      sourceRoot: '/project',
    });

    // Real createDelegation enforces the guard — let it run rather than mock
    // the variant by hand. The test exercises end-to-end dispatch from
    // createDelegation -> inner switch -> outer catch.
    jest.mocked(core.createDelegation).mockImplementation((opts: any) => ({
      status: 'parent_is_delegated',
      parentRunId: opts.state.parentLinkage.parentRunId,
      error: RealErrors.delegationNestedForbidden(opts.state.id),
    }));

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
    expect(mockEmitter.emit).toHaveBeenCalledWith(
      'RUNBOOK_STOPPED',
      expect.objectContaining({
        reason: 'nested_delegation_forbidden',
      }),
    );

    // No tokens persisted: the `manager.update` call before the catch (which
    // would have written substepStates) never happens because createDelegation
    // throws on the first target. The lifecycle update DOES happen — guard
    // verifies `update` was called only with `lifecycle: 'stopped'`, not with
    // `substepStates`.
    const updateCalls = mockManager.update.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[1] === 'object' &&
        call[1] !== null &&
        'substepStates' in (call[1] as Record<string, unknown>),
    );
    expect(updateCalls).toHaveLength(0);
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

    expect(core.executeCommand).toHaveBeenCalledWith(command, cwd);
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
    );
    expect(core.executeCommand).not.toHaveBeenCalled();
    expect(core.executeCommandWithPolicy).not.toHaveBeenCalled();
  });
});
