import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock dependencies
const mockActorService = {
  sendAndSync: jest.fn(),
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
        activeFrameKey: `${state?.step ?? '1'}|`,
      },
      frameKey: `${state?.step ?? '1'}|`,
      entry: state?.activeEntry ?? 1,
    })),
  listResolvedCompletions: jest.fn().mockResolvedValue([]),
  consumeResolvedCompletion: jest.fn().mockResolvedValue(null),
};

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
    buildCompletionKey: jest.fn(
      (frameKey: string, entry: number, substep?: string) =>
        `${frameKey}|${String(entry)}|${substep ?? ''}`,
    ),
    deriveActiveFrame: jest.fn((state: any) => ({
      frameKey: `${state?.step ?? '1'}|`,
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
  };
});

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
const { runExecutionLoop, executeCommandWithPolicyCheck } = await import(
  '../../src/services/execution'
);

describe('runExecutionLoop', () => {
  let mockManager: any;
  let mockEmitter: any;
  const runbookId = 'test-run-123';
  const steps: any[] = [
    {
      name: '1',
      description: 'Step 1',
      command: { code: 'echo hello', lang: 'sh' },
      transitions: {
        pass: { next: '2' },
        fail: { next: 'STOP' },
      },
    },
    {
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
      updateAgentBinding: jest.fn(),
    };

    mockLifecycleService.ensureActiveEntry.mockReset();
    mockLifecycleService.ensureActiveEntry.mockImplementation(
      async (_id: string, _prev: unknown, state: any) => ({
        state: {
          ...(state ?? {}),
          activeEntry: state?.activeEntry ?? 1,
          activeFrameKey: `${state?.step ?? '1'}|`,
        },
        frameKey: `${state?.step ?? '1'}|`,
        entry: state?.activeEntry ?? 1,
      }),
    );
    mockLifecycleService.listResolvedCompletions.mockReset();
    mockLifecycleService.listResolvedCompletions.mockResolvedValue([]);
    mockLifecycleService.consumeResolvedCompletion.mockReset();
    mockLifecycleService.consumeResolvedCompletion.mockResolvedValue(null);

    mockActorService.sendAndSync.mockReset();

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
      { name: '1', description: 'No command', transitions: { pass: { next: 'COMPLETE' } } },
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
      { name: '2', description: 'Step 2', transitions: { pass: { next: 'COMPLETE' } } },
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

  it('performs terminal bookkeeping when loop exhaustion completes a child runbook', async () => {
    const childAgentId = 'agent-42';
    const parentId = 'parent-run-789';
    const exhaustedState = {
      id: runbookId,
      step: '1',
      substep: undefined,
      variables: { someVar: 'val' },
      snapshot: {
        status: 'done',
        value: 'COMPLETE',
        context: { lastMessage: 'Loop done' },
      },
    };

    // Override ForIterationService mock to return exhausted+complete
    (core.ForIterationService as any).mockImplementation(() => ({
      prepareIteration: jest.fn().mockResolvedValue({
        status: 'exhausted',
        state: exhaustedState,
        terminal: 'complete',
      }),
    }));

    mockManager.load.mockResolvedValue({
      id: runbookId,
      step: '1',
      status: 'running',
      parentRunbookId: parentId,
    });

    const result = await runExecutionLoop(
      mockManager,
      runbookId,
      steps,
      '/tmp',
      false,
      mockEmitter,
      childAgentId,
    );

    expect(result).toBe('done');
    // variables.completed must be set
    expect(mockManager.update).toHaveBeenCalledWith(runbookId, {
      variables: { someVar: 'val', completed: true },
    });
    // Parent agent binding must be updated
    expect(mockManager.updateAgentBinding).toHaveBeenCalledWith(parentId, childAgentId, {
      status: 'done',
      result: 'pass',
    });
    expect(mockSessionService.popRunbook).toHaveBeenCalledWith(childAgentId);
  });

  it('performs terminal bookkeeping when loop exhaustion stops a child runbook', async () => {
    const childAgentId = 'agent-99';
    const parentId = 'parent-run-456';
    const exhaustedState = {
      id: runbookId,
      step: '1',
      substep: undefined,
      variables: {},
      snapshot: null,
    };

    (core.ForIterationService as any).mockImplementation(() => ({
      prepareIteration: jest.fn().mockResolvedValue({
        status: 'exhausted',
        state: exhaustedState,
        terminal: 'stopped',
      }),
    }));

    mockManager.load.mockResolvedValue({
      id: runbookId,
      step: '1',
      status: 'running',
      parentRunbookId: parentId,
    });

    const result = await runExecutionLoop(
      mockManager,
      runbookId,
      steps,
      '/tmp',
      false,
      mockEmitter,
      childAgentId,
    );

    expect(result).toBe('stopped');
    // variables.stopped must be set
    expect(mockManager.update).toHaveBeenCalledWith(runbookId, {
      variables: { stopped: true },
    });
    // Parent agent binding must be updated with fail
    expect(mockManager.updateAgentBinding).toHaveBeenCalledWith(parentId, childAgentId, {
      status: 'done',
      result: 'fail',
    });
    expect(mockSessionService.popRunbook).toHaveBeenCalledWith(childAgentId);
  });

  it('emits expanded command text in STEP_ENTERED payload for prompted mode', async () => {
    const forSteps = [
      {
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

    expect(core.executeCommand).toHaveBeenCalledWith(command, cwd);
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
