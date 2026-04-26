import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { mockErrorHelpers } from '../helpers/mock-error-helpers';

// Mock dependencies
const mockActorService = {
  sendAndSync: jest.fn(),
  getContextSnapshot: jest.fn(),
};

const mockSessionService = {
  popRunbook: jest.fn(),
};

const mockLifecycleService = {
  setLastResult: jest.fn(),
  ensureActiveEntry: jest
    .fn()
    .mockImplementation(async (_id: string, _prev: unknown, state: any) => ({
      state: {
        ...(state ?? {}),
        activeEntry: state?.activeEntry ?? 1,
        activeFrameKey: `${String(state?.step ?? '1')}|`,
      },
      frameKey: `${String(state?.step ?? '1')}|`,
      entry: state?.activeEntry ?? 1,
    })),
  listResolvedCompletions: jest.fn().mockResolvedValue([]),
  consumeResolvedCompletion: jest.fn().mockResolvedValue(null),
};

// Capture the real isJsonArrayStream before the mock is registered.
// jest.unstable_mockModule does NOT hoist (unlike jest.mock), so this top-level
// await executes first and always captures the real branded implementation.
const {
  isJsonArrayStream: realIsJsonArrayStream,
  ForResolutionError: RealForResolutionError,
  Errors: RealErrors,
} = await import('@rundown-org/core');

jest.unstable_mockModule('@rundown-org/core', () => {
  const asTerminalSnapshot = jest.fn((snapshot: unknown) => {
    if (
      typeof snapshot === 'object' &&
      snapshot !== null &&
      'status' in snapshot &&
      'value' in snapshot &&
      typeof (snapshot as Record<string, unknown>).status === 'string'
    ) {
      return snapshot as { status: string; value: unknown };
    }
    return null;
  });
  return {
    printActionBlock: jest.fn(),
    printStepBlock: jest.fn(),
    printStepSeparator: jest.fn(),
    printCommandExec: jest.fn(),
    printRunbookComplete: jest.fn(),
    printRunbookStoppedAtStep: jest.fn(),
    printPolicyDenied: jest.fn(),
    executeCommand: jest.fn(),
    executeCommandWithPolicy: jest.fn(),
    evaluatePassCondition: jest.fn(),
    evaluateFailCondition: jest.fn(),
    extractLastAction: jest.fn((snapshot: any) => snapshot?.context?.lastAction),
    extractLastMessage: jest.fn((snapshot: any) =>
      typeof snapshot?.context?.lastMessage === 'string' ? snapshot.context.lastMessage : undefined,
    ),
    extractRetryMax: jest.fn((snapshot: any) => snapshot?.context?.retryMax ?? 0),
    extractRetryDisplayCount: jest.fn((snapshot: any, retryCount: number) => {
      const iterationRetryCount = snapshot?.context?.iterationRetryCount;
      return typeof iterationRetryCount === 'number' && iterationRetryCount > 0
        ? iterationRetryCount
        : retryCount;
    }),
    formatActionForDisplay: jest.fn((lastAction: any, retryCount: number, retryMax: number) => {
      if (!lastAction) return 'CONTINUE';
      if (lastAction.type === 'RETRY') return `RETRY (${String(retryCount)}/${String(retryMax)})`;
      if (lastAction.type === 'GOTO') return `GOTO ${String(lastAction.target)}`;
      return lastAction.type;
    }),
    deriveTransitionMessage: jest.fn((result: 'pass' | 'fail') =>
      result === 'pass' ? 'Success' : 'Failed',
    ),
    parseActionType: jest.fn((lastAction: any) => {
      if (!lastAction) return 'CONTINUE';
      if (lastAction.type === 'GOTO') return 'GOTO';
      if (lastAction.type === 'RETRY') return 'RETRY';
      if (lastAction.type === 'RETRY_ERROR') return 'RETRY_ERROR';
      if (lastAction.type === 'COMPLETE') return 'COMPLETE';
      if (lastAction.type === 'STOP') return 'STOP';
      return 'CONTINUE';
    }),
    countNumberedSteps: jest.fn().mockReturnValue(2),
    extractDisplayCommand: jest.fn((cmd) => cmd),
    createFileProvider: jest.fn(),
    computeFileSnapshot: jest.fn(),
    buildStepPosition: jest.fn((current: string, total: number, substep?: string) => ({
      current,
      total,
      ...(substep ? { substep } : {}),
    })),
    deriveExecutionAt: jest.fn(
      (step: string, substep?: string, iteration?: number) =>
        `${step}${iteration != null ? `.${String(iteration)}` : ''}${substep ? `.${substep}` : ''}`,
    ),
    derivePositionAt: jest.fn(
      (pos: { current: string; substep?: string; for?: { index: number } }) =>
        `${pos.current}${pos.for?.index != null ? `.${String(pos.for.index)}` : ''}${pos.substep ? `.${pos.substep}` : ''}`,
    ),
    buildCompletionKey: jest.fn(
      (frameKey: string, entry: number, substep?: string) =>
        `${frameKey}|${String(entry)}|${substep ?? ''}`,
    ),
    deriveActiveFrame: jest.fn((state: any) => ({
      frameKey: `${String(state?.step ?? '1')}|`,
      step: state?.step ?? '1',
    })),
    RunbookActorService: jest.fn().mockImplementation(() => mockActorService),
    SessionService: jest.fn().mockImplementation(() => mockSessionService),
    ExecutionLifecycleService: jest.fn().mockImplementation(() => mockLifecycleService),
    ForIterationService: jest.fn().mockImplementation(() => ({
      prepareIteration: jest.fn().mockResolvedValue({ status: 'no-resolution-needed' }),
    })),
    isRunbookComplete: jest.fn((s: any) => s?.status === 'done' && s?.value === 'COMPLETE'),
    isRunbookStopped: jest.fn((s: any) => s?.status === 'done' && s?.value === 'STOPPED'),
    asTerminalSnapshot,
    asTerminalSnapshotOrDefault: jest.fn((snapshot: unknown) => {
      return asTerminalSnapshot(snapshot) ?? { status: 'active', value: undefined };
    }),
    logger: {
      debug: jest.fn().mockResolvedValue(undefined),
      info: jest.fn().mockResolvedValue(undefined),
      warn: jest.fn().mockResolvedValue(undefined),
      error: jest.fn().mockResolvedValue(undefined),
      always: jest.fn().mockResolvedValue(undefined),
      event: jest.fn().mockResolvedValue(undefined),
      getLogFilePath: jest.fn().mockReturnValue('/tmp/rundown-test.log'),
      getLogDir: jest.fn().mockReturnValue('/tmp'),
    },
    isJsonArray: jest.fn((v: unknown) => Array.isArray(v)),
    isJsonArrayStream: jest.fn(realIsJsonArrayStream),
    mergeEffectiveVars: jest.fn((state: any, extra?: Record<string, unknown>) => ({
      ...(state?.templateVars ?? {}),
      ...(state?.variables ?? {}),
      ...(extra ?? {}),
    })),
    ForResolutionError: RealForResolutionError,
    assertResolvedVariableForContext: jest.fn(
      (fc: {
        currentValue?: unknown;
        source?: { kind: string; name?: string };
        stepId?: string;
        iteration?: number;
      }) => {
        if (fc.currentValue === undefined) {
          const name = fc.source?.kind === 'variable' ? String(fc.source.name) : '(unknown)';
          throw new Error(
            `ForContext for step "${String(fc.stepId)}" (variable source "${name}") ` +
              `has not been resolved — currentValue is undefined at iteration ${String(fc.iteration)}`,
          );
        }
      },
    ),
    assembleArtifactPath: jest.fn((dir: string, ctx: string, file: string) => {
      const date = new Date().toISOString().slice(0, 10);
      return `${dir}/.rd-${ctx}/${date}-${file}`;
    }),
    ...mockErrorHelpers,
    RUNS_DIR: '.rundown/runs',
    WORK_DIR: '.rundown/work',
    CONFIG_FILE: '.rundown/config.yaml',
    isJsonValue: jest.fn((v: unknown) => v != null),
    createJsonArrayStream: jest.fn(),
    createDelegation: jest.fn(),
    Errors: RealErrors,
    // Helper-call validator imported by template-renderer; the real impl is fine.
    invokeHelperSafely: jest.fn(
      (_name: string, helper: (v: string) => string, arg: string): string | undefined => {
        try {
          const r = helper(arg);
          return typeof r === 'string' ? r : undefined;
        } catch {
          return undefined;
        }
      },
    ),
    resetHelperInvokeWarnings: jest.fn(),
  };
});

jest.unstable_mockModule('../../src/helpers/delegate-inference', () => ({
  inferAllDelegateSubsteps: jest.fn().mockReturnValue([]),
}));

jest.unstable_mockModule('../../src/helpers/resolve-runbook', () => ({
  resolveRunbookFile: jest.fn().mockResolvedValue(null),
}));

jest.unstable_mockModule('../../src/services/internal-commands', () => ({
  isInternalRdCommand: jest.fn().mockReturnValue(false),
  executeRdCommandInternal: jest.fn(),
}));

jest.unstable_mockModule('../../src/services/policy-context', () => ({
  getPolicyEvaluator: jest.fn(),
  getPolicyPrompter: jest.fn(),
  isPolicyEnforced: jest.fn().mockReturnValue(false),
  getSandboxOptions: jest.fn().mockReturnValue({ sandbox: true, sandboxStrict: false }),
}));

// Import after mocking
const core = await import('@rundown-org/core');
const policyContext = await import('../../src/services/policy-context');
const delegateInference = await import('../../src/helpers/delegate-inference');
const resolveRunbook = await import('../../src/helpers/resolve-runbook');
const { runExecutionLoop, executeCommandWithPolicyCheck } = await import(
  '../../src/services/execution'
);

describe('runExecutionLoop', () => {
  let mockManager: any;
  let mockEmitter: any;
  const runbookId = 'test-run-123';
  const steps: any[] = [
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

  beforeEach(() => {
    jest.clearAllMocks();

    // Restore default ForIterationService mock (tests may override)
    (core.ForIterationService as any).mockImplementation(() => ({
      prepareIteration: jest.fn().mockResolvedValue({ status: 'no-resolution-needed' }),
    }));

    policyContext.isPolicyEnforced.mockReturnValue(false);
    policyContext.getSandboxOptions.mockReturnValue({ sandbox: true, sandboxStrict: false });
    (core.executeCommand as any).mockReset();
    (core.executeCommandWithPolicy as any).mockReset();

    mockManager = {
      load: jest.fn(),
      update: jest.fn(),
    };

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
      emit: jest.fn(),
    };

    // Default evaluate behavior
    (core.evaluatePassCondition as any).mockReturnValue({ message: 'Success' });
    (core.evaluateFailCondition as any).mockReturnValue({ message: 'Failed' });
  });

  it('stops if state cannot be loaded', async () => {
    mockManager.load.mockResolvedValue(null);
    const result = await runExecutionLoop(
      mockManager,
      runbookId,
      steps,
      '/tmp',
      false,
      mockEmitter,
    );
    expect(result).toBe('stopped');
  });

  it('returns waiting if prompted mode is on', async () => {
    mockManager.load.mockResolvedValue({
      id: runbookId,
      step: '1',
      status: 'running',
    });

    const result = await runExecutionLoop(mockManager, runbookId, steps, '/tmp', true, mockEmitter);

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
    mockManager.load.mockResolvedValue({
      id: runbookId,
      step: '1',
      status: 'running',
    });

    const result = await runExecutionLoop(
      mockManager,
      runbookId,
      stepsNoCmd as any,
      '/tmp',
      false,
      mockEmitter,
    );

    expect(result).toBe('waiting');
  });

  it('executes command and advances to next step', async () => {
    mockManager.load
      .mockResolvedValueOnce({ id: runbookId, step: '1', status: 'running' })
      .mockResolvedValueOnce({ id: runbookId, step: '2', status: 'running' });

    (core.executeCommand as any).mockResolvedValue({ success: true, exitCode: 0 });

    mockActorService.sendAndSync.mockResolvedValue({
      state: { id: runbookId, step: '2', status: 'running' },
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
      mockManager,
      runbookId,
      testSteps,
      '/tmp',
      false,
      mockEmitter,
    );

    expect(result).toBe('waiting');
    expect(core.executeCommand).toHaveBeenCalled();
  });

  it('handles policy denial', async () => {
    mockManager.load.mockResolvedValue({ id: runbookId, step: '1', status: 'running' });
    policyContext.isPolicyEnforced.mockReturnValue(true);

    (core.executeCommandWithPolicy as any).mockResolvedValue({
      success: false,
      policyDenied: true,
      denialReason: 'Not allowed',
    });

    const result = await runExecutionLoop(
      mockManager,
      runbookId,
      steps,
      '/tmp',
      false,
      mockEmitter,
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
    mockManager.load.mockResolvedValue({ id: runbookId, step: '1', status: 'running' });

    (core.ForIterationService as any).mockImplementation(() => ({
      prepareIteration: jest
        .fn()
        .mockRejectedValue(
          new RealForResolutionError(
            'JsonArrayStream path "/etc/passwd" escapes project root "/project"',
            'policy-violation',
          ),
        ),
    }));

    const result = await runExecutionLoop(
      mockManager,
      runbookId,
      steps,
      '/tmp',
      false,
      mockEmitter,
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
    mockManager.load.mockResolvedValue({ id: runbookId, step: '1', status: 'running' });
    (core.executeCommand as any).mockResolvedValue({ success: true, exitCode: 0 });

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
      mockManager,
      runbookId,
      steps,
      '/tmp',
      false,
      mockEmitter,
    );

    expect(result).toBe('done');
    expect(mockEmitter.emit).toHaveBeenCalledWith(
      'RUNBOOK_COMPLETED',
      expect.objectContaining({
        message: 'Success',
      }),
    );
    expect(mockSessionService.popRunbook).toHaveBeenCalled();
  });

  it('emits ERROR_OCCURRED when the state machine stops with a RETRY_ERROR lastAction', async () => {
    // Seed the actor to report a stopped lifecycle with a RETRY_ERROR
    // lastAction variant on the returned snapshot. runExecutionLoop should
    // emit ERROR_OCCURRED with the hook error's code + message before the
    // terminal RUNBOOK_STOPPED event.
    mockManager.load.mockResolvedValue({ id: runbookId, step: '1', status: 'running' });
    (core.executeCommand as any).mockResolvedValue({ success: false, exitCode: 1 });

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
      mockManager,
      runbookId,
      steps,
      '/tmp',
      false,
      mockEmitter,
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
    const stepTransitionedCalls = emitCalls.filter((c: any[]) => c[0] === 'STEP_TRANSITIONED');
    for (const call of stepTransitionedCalls) {
      expect(call[1]?.action).not.toBe('RETRY_ERROR');
    }
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
      mockManager,
      runbookId,
      promptedForSteps as any,
      '/tmp',
      false, // prompted=false — step itself gates execution
      mockEmitter,
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
      mockManager,
      runbookId,
      promptedForSteps as any,
      '/tmp',
      false,
      mockEmitter,
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
      mockManager,
      runbookId,
      promptedForSteps as any,
      '/tmp',
      false,
      mockEmitter,
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
      mockManager,
      runbookId,
      promptedForSteps as any,
      '/tmp',
      false,
      mockEmitter,
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
      mockManager,
      runbookId,
      forSteps as any,
      '/tmp',
      true,
      mockEmitter,
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
        .mockResolvedValueOnce({
          id: runbookId,
          step: '1',
          status: 'running',
          templateVars: { ContextId: 'ctx-unit' },
        })
        .mockResolvedValueOnce({
          id: runbookId,
          step: '2',
          status: 'running',
          templateVars: { ContextId: 'ctx-unit' },
        });

      (core.executeCommand as any).mockResolvedValue({ success: true, exitCode: 0 });

      // Non-terminal snapshot (active/CONTINUE) → orchestrateTransition takes the reload path
      mockActorService.sendAndSync.mockResolvedValue({
        state: {
          id: runbookId,
          step: '2',
          status: 'running',
          templateVars: { ContextId: 'ctx-unit' },
        },
        snapshot: {
          status: 'active',
          value: '2',
          context: { lastAction: { type: 'CONTINUE' } },
        },
      });

      const result = await runExecutionLoop(
        mockManager,
        runbookId,
        stepsWithOutputs,
        '/tmp',
        false,
        mockEmitter,
      );

      // OUTPUTS evaluation lives in the state machine; this is a regression
      // guard that the CLI auto-execution path still runs to completion when
      // a step declares outputs. Behavioral coverage is in integration tests.
      expect(result).not.toBe('stopped');
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
    delegateInference.inferAllDelegateSubsteps.mockReturnValue([
      { runbookRef: 'child-a.runbook.md', stepId: '1.1' },
      { runbookRef: 'child-b.runbook.md', stepId: '1.2' },
    ]);

    // resolveRunbookFile resolves to a path
    resolveRunbook.resolveRunbookFile
      .mockResolvedValueOnce({
        path: '/project/.rundown/runbooks/child-a.runbook.md',
        source: 'project',
      })
      .mockResolvedValueOnce({
        path: '/project/.rundown/runbooks/child-b.runbook.md',
        source: 'project',
      });

    // createDelegation returns a Result with status 'created' for each substep
    (core.createDelegation as any)
      .mockReturnValueOnce({
        status: 'created',
        token: 'rdtk_aaaa1111',
        tokenHash: 'hash-a',
        delegation: {},
        updatedSubstepStates: [{ id: '1', frameKey: '1|', status: 'pending', delegation: {} }],
      })
      .mockReturnValueOnce({
        status: 'created',
        token: 'rdtk_bbbb2222',
        tokenHash: 'hash-b',
        delegation: {},
        updatedSubstepStates: [
          { id: '1', frameKey: '1|', status: 'pending', delegation: {} },
          { id: '2', frameKey: '1|', status: 'pending', delegation: {} },
        ],
      });

    mockManager.update = jest.fn().mockResolvedValue(undefined);

    await runExecutionLoop(mockManager, runbookId, delegateSteps, '/tmp', false, mockEmitter);

    // STEP_ENTERED should have been emitted with delegateFrontier
    const stepEnteredCall = mockEmitter.emit.mock.calls.find(
      (call: any[]) => call[0] === 'STEP_ENTERED',
    );
    expect(stepEnteredCall).toBeDefined();
    const payload = stepEnteredCall[1];

    expect(payload.delegateFrontier).toBeDefined();
    expect(payload.delegateFrontier).toHaveLength(2);

    expect(payload.delegateFrontier[0]).toMatchObject({
      id: '1.1',
      runbook: 'child-a.runbook.md',
      token: 'rdtk_aaaa1111',
    });
    expect(payload.delegateFrontier[1]).toMatchObject({
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

    mockManager.update = jest.fn().mockResolvedValue(undefined);

    await runExecutionLoop(mockManager, runbookId, delegateSteps, '/tmp', false, mockEmitter);

    // STEP_ENTERED payload should carry the pre-issued frontier
    const stepEnteredCall = mockEmitter.emit.mock.calls.find(
      (call: any[]) => call[0] === 'STEP_ENTERED',
    );
    expect(stepEnteredCall).toBeDefined();
    const payload = stepEnteredCall[1];

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

    delegateInference.inferAllDelegateSubsteps.mockReturnValue([
      { runbookRef: 'child-a.runbook.md', stepId: '1.1' },
    ]);

    resolveRunbook.resolveRunbookFile.mockResolvedValue({
      path: '/project/.rundown/runbooks/child-a.runbook.md',
      source: 'project',
    });

    (core.createDelegation as any).mockReturnValue({
      status: 'created',
      token: 'rdtk_autoissue',
      tokenHash: 'hash-auto',
      delegation: {},
      updatedSubstepStates: [{ id: '1', frameKey: '1|', status: 'pending', delegation: {} }],
    });

    mockManager.update = jest.fn().mockResolvedValue(undefined);

    await runExecutionLoop(mockManager, runbookId, delegateSteps, '/tmp', false, mockEmitter);

    // Auto-issuance was invoked
    expect(delegateInference.inferAllDelegateSubsteps).toHaveBeenCalled();
    expect(core.createDelegation).toHaveBeenCalled();

    // STEP_ENTERED received the auto-issued frontier
    const stepEnteredCall = mockEmitter.emit.mock.calls.find(
      (call: any[]) => call[0] === 'STEP_ENTERED',
    );
    expect(stepEnteredCall).toBeDefined();
    const payload = stepEnteredCall[1];
    expect(payload.delegateFrontier).toHaveLength(1);
    expect(payload.delegateFrontier[0]).toMatchObject({
      id: '1.1',
      runbook: 'child-a.runbook.md',
      token: 'rdtk_autoissue',
    });

    // PENDING_FRONTIER_CONSUMED must NOT be sent when no frontier was consumed
    const consumedCall = mockActorService.sendAndSync.mock.calls.find(
      (call: any[]) => call[1] === delegateSteps && call[2]?.type === 'PENDING_FRONTIER_CONSUMED',
    );
    expect(consumedCall).toBeUndefined();
  });
});

describe('executeCommandWithPolicyCheck', () => {
  const command = 'echo test';
  const cwd = '/tmp';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('calls executeCommand directly if policy is not enforced', async () => {
    policyContext.isPolicyEnforced.mockReturnValue(false);
    (core.executeCommand as any).mockResolvedValue({ success: true });

    await executeCommandWithPolicyCheck(command, cwd);

    expect(core.executeCommand).toHaveBeenCalledWith(command, cwd, undefined);
    expect(core.executeCommandWithPolicy).not.toHaveBeenCalled();
  });

  it('calls executeCommandWithPolicy if policy is enforced', async () => {
    policyContext.isPolicyEnforced.mockReturnValue(true);
    const mockEvaluator = { setRunbookPath: jest.fn() };
    policyContext.getPolicyEvaluator.mockReturnValue(mockEvaluator);
    policyContext.getPolicyPrompter.mockReturnValue('prompter');
    policyContext.getSandboxOptions.mockReturnValue({ sandbox: true, sandboxStrict: true });
    (core.executeCommandWithPolicy as any).mockResolvedValue({ success: true });

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
});
