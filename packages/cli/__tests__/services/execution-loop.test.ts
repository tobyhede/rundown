import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock dependencies
jest.unstable_mockModule('@rundown-org/core', () => ({
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
  countNumberedSteps: jest.fn().mockReturnValue(2),
  extractDisplayCommand: jest.fn((cmd) => cmd),
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
const { runExecutionLoop, executeCommandWithPolicyCheck } = await import('../../src/services/execution');

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
        fail: { next: 'STOP' }
      }
    },
    {
      name: '2',
      description: 'Step 2',
      command: { code: 'echo world', lang: 'sh' },
      transitions: {
        pass: { next: 'COMPLETE' },
        fail: { next: 'STOP' }
      }
    }
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    
    (policyContext.isPolicyEnforced).mockReturnValue(false);
    (policyContext.getSandboxOptions).mockReturnValue({ sandbox: true, sandboxStrict: false });
    (core.executeCommand as any).mockReset();
    (core.executeCommandWithPolicy as any).mockReset();

    mockManager = {
      load: jest.fn(),
      update: jest.fn(),
      setLastResult: jest.fn(),
      createActor: jest.fn(),
      updateFromActor: jest.fn(),
      popRunbook: jest.fn(),
      updateAgentBinding: jest.fn(),
    };

    mockEmitter = {
      emit: jest.fn(),
    };

    // Default evaluate behavior
    (core.evaluatePassCondition as any).mockReturnValue({ message: 'Success' });
    (core.evaluateFailCondition as any).mockReturnValue({ message: 'Failed' });
  });

  it('stops if state cannot be loaded', async () => {
    mockManager.load.mockResolvedValue(null);
    const result = await runExecutionLoop(mockManager, runbookId, steps, '/tmp', false);
    expect(result).toBe('stopped');
  });

  it('returns waiting if prompted mode is on', async () => {
    mockManager.load.mockResolvedValue({
      id: runbookId,
      step: '1',
      status: 'running',
    });
    
    const result = await runExecutionLoop(mockManager, runbookId, steps, '/tmp', true, undefined, mockEmitter);
    
    expect(result).toBe('waiting');
    expect(mockEmitter.emit).toHaveBeenCalledWith('STEP_ENTERED', expect.objectContaining({
      stepName: '1',
      prompted: true
    }));
  });

  it('returns waiting if step has no command', async () => {
    const stepsNoCmd = [{ name: '1', description: 'No command', transitions: { pass: { next: 'COMPLETE' } } }];
    mockManager.load.mockResolvedValue({
      id: runbookId,
      step: '1',
      status: 'running',
    });
    
    const result = await runExecutionLoop(mockManager, runbookId, stepsNoCmd as any, '/tmp', false, undefined, mockEmitter);
    
    expect(result).toBe('waiting');
  });

  it('executes command and advances to next step', async () => {
    mockManager.load
      .mockResolvedValueOnce({ id: runbookId, step: '1', status: 'running' })
      .mockResolvedValueOnce({ id: runbookId, step: '2', status: 'running' });

    (core.executeCommand as any).mockResolvedValue({ success: true, exitCode: 0 });

    const mockActor = {
      send: jest.fn(),
      getPersistedSnapshot: jest.fn().mockReturnValue({
        status: 'active',
        value: '2',
        context: { lastAction: { type: 'CONTINUE' } }
      })
    };
    mockManager.createActor.mockResolvedValue(mockActor);
    mockManager.updateFromActor.mockResolvedValue({ id: runbookId, step: '2', status: 'running' });

    const testSteps = [
      steps[0],
      { name: '2', description: 'Step 2', transitions: { pass: { next: 'COMPLETE' } } }
    ];

    const result = await runExecutionLoop(mockManager, runbookId, testSteps, '/tmp', false, undefined, mockEmitter);

    expect(result).toBe('waiting');
    expect(core.executeCommand).toHaveBeenCalled();
  });

  it('handles policy denial', async () => {
    mockManager.load.mockResolvedValue({ id: runbookId, step: '1', status: 'running' });
    (policyContext.isPolicyEnforced).mockReturnValue(true);
    
    (core.executeCommandWithPolicy as any).mockResolvedValue({
      success: false,
      policyDenied: true,
      denialReason: 'Not allowed'
    });

    const result = await runExecutionLoop(mockManager, runbookId, steps, '/tmp', false, undefined, mockEmitter);

    expect(result).toBe('stopped');
    expect(mockEmitter.emit).toHaveBeenCalledWith('POLICY_DENIED', expect.objectContaining({
      reason: 'Not allowed'
    }));
  });

  it('completes the runbook', async () => {
    mockManager.load.mockResolvedValue({ id: runbookId, step: '1', status: 'running' });
    (core.executeCommand as any).mockResolvedValue({ success: true, exitCode: 0 });

    const mockActor = {
      send: jest.fn(),
      getPersistedSnapshot: jest.fn().mockReturnValue({
        status: 'done',
        value: 'COMPLETE',
        context: { lastAction: { type: 'COMPLETE' } }
      })
    };
    mockManager.createActor.mockResolvedValue(mockActor);
    mockManager.updateFromActor.mockResolvedValue({ 
      id: runbookId, 
      step: '1', 
      status: 'done', 
      variables: {},
      runbookPath: '/tmp/test.md' 
    });

    const result = await runExecutionLoop(mockManager, runbookId, steps, '/tmp', false, undefined, mockEmitter);

    expect(result).toBe('done');
    expect(mockEmitter.emit).toHaveBeenCalledWith('RUNBOOK_COMPLETED', expect.objectContaining({
      message: 'Success'
    }));
    expect(mockManager.popRunbook).toHaveBeenCalled();
  });

  it('uses expanded command text in printStepBlock fallback (prompted mode, no emitter)', async () => {
    const forSteps = [{
      name: '1',
      description: 'Process',
      forClause: { variable: 'item', start: 1, end: 1 },
      substeps: [{
        id: '1',
        description: 'Handle {{item}}',
        isDynamic: false,
        command: { code: 'rd echo item={{item}}', lang: 'bash' },
        transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
      }],
      transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
    }];

    mockManager.load.mockResolvedValue({
      id: runbookId,
      step: '1',
      substep: '1',
      status: 'running',
    });

    const result = await runExecutionLoop(mockManager, runbookId, forSteps as any, '/tmp', true);

    expect(result).toBe('waiting');
    expect(core.printStepBlock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        description: 'Handle 1',
        command: expect.objectContaining({ code: 'rd echo item=1' }),
      }),
      true
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
    (policyContext.isPolicyEnforced).mockReturnValue(false);
    (core.executeCommand as any).mockResolvedValue({ success: true });

    await executeCommandWithPolicyCheck(command, cwd);

    expect(core.executeCommand).toHaveBeenCalledWith(command, cwd);
    expect(core.executeCommandWithPolicy).not.toHaveBeenCalled();
  });

  it('calls executeCommandWithPolicy if policy is enforced', async () => {
    (policyContext.isPolicyEnforced).mockReturnValue(true);
    const mockEvaluator = { setRunbookPath: jest.fn() };
    (policyContext.getPolicyEvaluator).mockReturnValue(mockEvaluator);
    (policyContext.getPolicyPrompter).mockReturnValue('prompter');
    (policyContext.getSandboxOptions).mockReturnValue({ sandbox: true, sandboxStrict: true });
    (core.executeCommandWithPolicy as any).mockResolvedValue({ success: true });

    await executeCommandWithPolicyCheck(command, cwd, 'test.md');

    expect(mockEvaluator.setRunbookPath).toHaveBeenCalledWith('test.md');
    expect(core.executeCommandWithPolicy).toHaveBeenCalledWith(command, cwd, expect.objectContaining({
      evaluator: mockEvaluator,
      prompter: 'prompter',
      sandbox: true,
      sandboxStrict: true
    }));
  });
});