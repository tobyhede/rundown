import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { RunbookState } from '@rundown-org/core';

// Mock @rundown-org/core
jest.unstable_mockModule('@rundown-org/core', () => ({
  RunbookStateManager: jest.fn(),
  RunbookActorService: jest.fn(),
  SessionService: jest.fn(),
  ExecutionLifecycleService: jest.fn(),
  DelegationLock: jest.fn(),
  buildCompletionKey: jest.fn((frameKey: string, entry: number, stepId: string) => {
    return `${frameKey}|${String(entry)}|${stepId}`;
  }),
  buildResolvedCompletion: jest.fn((opts: any) => ({
    agentId: opts.agentId,
    result: opts.result,
    targetStep: opts.targetStep,
    targetSubstep: opts.targetSubstep,
    targetFrameKey: opts.targetFrameKey,
    targetEntry: opts.targetEntry,
  })),
  deriveActiveFrame: jest.fn((state: RunbookState) => ({
    frameKey: state.activeFrameKey ?? `${state.step}|`,
    step: state.step,
  })),
}));

// Mock runbook-loader
jest.unstable_mockModule('../../src/helpers/runbook-loader', () => ({
  getRunbookFromState: jest.fn(() => [
    {
      name: '1',
      description: 'Step 1',
      transitions: { pass: { action: 'continue', retry: 0 }, fail: { action: 'stop', retry: 0 } },
    },
  ]),
}));

// Mock execution service
jest.unstable_mockModule('../../src/services/execution', () => ({
  drainResolvedCompletions: jest.fn(),
  runExecutionLoop: jest.fn(),
}));

// Mock execution-emitter
jest.unstable_mockModule('../../src/helpers/execution-emitter', () => ({
  createBridgedEmitter: jest.fn(() => ({
    emit: jest.fn(),
  })),
}));

// Mock transitions
jest.unstable_mockModule('../../src/helpers/transitions', () => ({
  createPassTransitionConfig: jest.fn(() => ({
    policy: 'pass',
    computeActionResult: jest.fn(() => 'pass'),
  })),
  createFailTransitionConfig: jest.fn(() => ({
    policy: 'fail',
    computeActionResult: jest.fn(() => 'fail'),
  })),
}));

// Import after mocking
const core = await import('@rundown-org/core');
const { drainResolvedCompletions, runExecutionLoop } = await import('../../src/services/execution');
const { createBridgedEmitter } = await import('../../src/helpers/execution-emitter');
const { handleDelegationCompletion } = await import('../../src/helpers/delegation-completion');

function makeState(id: string, overrides: Partial<RunbookState> = {}): RunbookState {
  return {
    id,
    runbook: 'test.md',
    runbookPath: 'test.md',
    runbookSrc: '## 1. Step\n- PASS: CONTINUE',
    step: '1',
    stepName: 'Step',
    retryCount: 0,
    variables: {},
    steps: [],
    pendingSteps: [],
    agentBindings: {},
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    activeFrameKey: '1|',
    activeEntry: 1,
    ...overrides,
  };
}

function makeMockOutput() {
  return {
    status: jest.fn(),
    error: jest.fn(),
    metadata: jest.fn(),
    stopped: jest.fn(),
    flush: jest.fn(),
  } as any;
}

function makeMockManager() {
  return {
    load: jest.fn<any>().mockResolvedValue(null),
    update: jest.fn<any>().mockResolvedValue(undefined),
  } as any;
}

function makeMockLock() {
  return jest.fn().mockImplementation(() => ({
    acquire: jest.fn<any>().mockResolvedValue(undefined),
    release: jest.fn<any>().mockResolvedValue(undefined),
  }));
}

beforeEach(() => {
  jest.resetAllMocks();
  (drainResolvedCompletions as jest.Mock).mockResolvedValue({
    status: 'waiting',
    applied: 0,
    state: makeState('parent-id'),
  });
  (runExecutionLoop as jest.Mock).mockResolvedValue('waiting');
  (createBridgedEmitter as jest.Mock).mockReturnValue({ emit: jest.fn() });
});

describe('handleDelegationCompletion', () => {
  it('returns not-applicable when child has no delegation linkage', async () => {
    const childState = makeState('child-id', { delegation: undefined });
    const output = makeMockOutput();

    const result = await handleDelegationCompletion(childState, 'pass', '/test', output);

    expect(result).toBe('not-applicable');
  });

  it('returns not-applicable when parent run no longer exists', async () => {
    const childState = makeState('child-id', {
      delegation: {
        parentRunId: 'parent-id',
        parentStepId: '1',
        tokenHash: 'sha256:test',
        parentStep: '1',
        parentFrameKey: '1|',
        parentEntry: 1,
      },
    });

    const mockManager = makeMockManager();
    mockManager.load.mockResolvedValue(null); // Parent deleted

    const mockLock = makeMockLock();
    (core.RunbookStateManager as jest.Mock).mockReturnValue(mockManager);
    (core.DelegationLock as jest.Mock).mockImplementation(mockLock);

    const output = makeMockOutput();

    const result = await handleDelegationCompletion(childState, 'pass', '/test', output);

    expect(result).toBe('not-applicable');
    const lockInstance = mockLock.mock.results[0].value;
    expect(lockInstance.acquire).toHaveBeenCalledWith('parent-id');
    expect(lockInstance.release).toHaveBeenCalledWith('parent-id');
  });

  it('returns handled when delegation was cancelled', async () => {
    const childState = makeState('child-id', {
      delegation: {
        parentRunId: 'parent-id',
        parentStepId: '1',
        tokenHash: 'sha256:test',
        parentStep: '1',
        parentFrameKey: '1|',
        parentEntry: 1,
      },
    });

    const parentState = makeState('parent-id', {
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation: {
            tokenHash: 'sha256:test',
            childRunbookPath: 'child.md',
            contextSnapshot: { vars: {}, ancestors: [] },
            childRunId: 'child-id',
            createdAt: new Date().toISOString(),
            cancelledAt: new Date().toISOString(), // Cancelled
          },
        },
      ],
    });

    const mockManager = makeMockManager();
    mockManager.load.mockResolvedValue(parentState);

    const mockLock = makeMockLock();
    (core.RunbookStateManager as jest.Mock).mockReturnValue(mockManager);
    (core.DelegationLock as jest.Mock).mockImplementation(mockLock);

    const output = makeMockOutput();

    const result = await handleDelegationCompletion(childState, 'pass', '/test', output);

    expect(result).toBe('handled');
  });

  it('records resolved completion and drains on parent', async () => {
    const childState = makeState('child-id', {
      delegation: {
        parentRunId: 'parent-id',
        parentStepId: '1',
        tokenHash: 'sha256:test',
        parentStep: '1',
        parentFrameKey: '1|',
        parentEntry: 1,
      },
    });

    const parentState = makeState('parent-id', {
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation: {
            tokenHash: 'sha256:test',
            childRunbookPath: 'child.md',
            contextSnapshot: { vars: {}, ancestors: [] },
            childRunId: 'child-id',
            createdAt: new Date().toISOString(),
            cancelledAt: null,
          },
        },
      ],
    });

    const mockManager = makeMockManager();
    mockManager.load.mockResolvedValue(parentState);

    const mockLifecycle = {
      getResolvedCompletion: jest.fn<any>().mockResolvedValue(null),
      upsertResolvedCompletion: jest.fn<any>().mockResolvedValue(undefined),
    };
    (core.ExecutionLifecycleService as jest.Mock).mockReturnValue(mockLifecycle);

    const mockLock = makeMockLock();
    (core.RunbookStateManager as jest.Mock).mockReturnValue(mockManager);
    (core.DelegationLock as jest.Mock).mockImplementation(mockLock);
    (core.RunbookActorService as jest.Mock).mockReturnValue({});
    (core.SessionService as jest.Mock).mockReturnValue({});

    (drainResolvedCompletions as jest.Mock).mockResolvedValue({
      status: 'waiting',
      applied: 0,
      state: parentState,
    });

    const output = makeMockOutput();

    const result = await handleDelegationCompletion(childState, 'pass', '/test', output);

    expect(result).toBe('handled');
    expect(mockLifecycle.upsertResolvedCompletion).toHaveBeenCalledWith(
      'parent-id',
      '1||1|1',
      expect.objectContaining({
        agentId: 'delegation',
        result: 'pass',
      }),
    );
    expect(drainResolvedCompletions).toHaveBeenCalled();
  });

  it('returns stopped when parent reaches stopped state after drain', async () => {
    const childState = makeState('child-id', {
      delegation: {
        parentRunId: 'parent-id',
        parentStepId: '1',
        tokenHash: 'sha256:test',
        parentStep: '1',
        parentFrameKey: '1|',
        parentEntry: 1,
      },
    });

    const parentState = makeState('parent-id', {
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation: {
            tokenHash: 'sha256:test',
            childRunbookPath: 'child.md',
            contextSnapshot: { vars: {}, ancestors: [] },
            childRunId: 'child-id',
            createdAt: new Date().toISOString(),
            cancelledAt: null,
          },
        },
      ],
    });

    const mockManager = makeMockManager();
    mockManager.load.mockResolvedValue(parentState);

    const mockLifecycle = {
      getResolvedCompletion: jest.fn<any>().mockResolvedValue(null),
      upsertResolvedCompletion: jest.fn<any>().mockResolvedValue(undefined),
    };
    (core.ExecutionLifecycleService as jest.Mock).mockReturnValue(mockLifecycle);

    const mockLock = makeMockLock();
    (core.RunbookStateManager as jest.Mock).mockReturnValue(mockManager);
    (core.DelegationLock as jest.Mock).mockImplementation(mockLock);
    (core.RunbookActorService as jest.Mock).mockReturnValue({});
    (core.SessionService as jest.Mock).mockReturnValue({});

    (drainResolvedCompletions as jest.Mock).mockResolvedValue({
      status: 'stopped',
      applied: 1,
      state: { ...parentState, variables: { stopped: true } },
    });

    const output = makeMockOutput();

    const result = await handleDelegationCompletion(childState, 'fail', '/test', output);

    expect(result).toBe('stopped');
    expect(output.flush).toHaveBeenCalled();
  });

  it('cascades to grandparent when parent completes and has delegation linkage', async () => {
    const childState = makeState('child-id', {
      delegation: {
        parentRunId: 'parent-id',
        parentStepId: '1',
        tokenHash: 'sha256:child-token',
        parentStep: '1',
        parentFrameKey: '1|',
        parentEntry: 1,
      },
    });

    const parentState = makeState('parent-id', {
      delegation: {
        parentRunId: 'grandparent-id',
        parentStepId: '1',
        tokenHash: 'sha256:parent-token',
        parentStep: '1',
        parentFrameKey: '1|',
        parentEntry: 1,
      },
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation: {
            tokenHash: 'sha256:child-token',
            childRunbookPath: 'child.md',
            contextSnapshot: { vars: {}, ancestors: [] },
            childRunId: 'child-id',
            createdAt: new Date().toISOString(),
            cancelledAt: null,
          },
        },
      ],
    });

    const grandparentState = makeState('grandparent-id', {
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation: {
            tokenHash: 'sha256:parent-token',
            childRunbookPath: 'parent.md',
            contextSnapshot: { vars: {}, ancestors: [] },
            childRunId: 'parent-id',
            createdAt: new Date().toISOString(),
            cancelledAt: null,
          },
        },
      ],
    });

    const mockManager = makeMockManager();
    let loadCallCount = 0;
    mockManager.load.mockImplementation(async (id: string) => {
      loadCallCount++;
      // First calls load parent, then parent again after drain
      if (id === 'parent-id' && loadCallCount <= 2) {
        return parentState;
      }
      // Third call loads grandparent after cascade
      if (id === 'grandparent-id') {
        return grandparentState;
      }
      return null;
    });

    const mockLifecycle = {
      getResolvedCompletion: jest.fn<any>().mockResolvedValue(null),
      upsertResolvedCompletion: jest.fn<any>().mockResolvedValue(undefined),
    };
    (core.ExecutionLifecycleService as jest.Mock).mockReturnValue(mockLifecycle);

    const mockLock = makeMockLock();
    (core.RunbookStateManager as jest.Mock).mockReturnValue(mockManager);
    (core.DelegationLock as jest.Mock).mockImplementation(mockLock);
    (core.RunbookActorService as jest.Mock).mockReturnValue({});
    (core.SessionService as jest.Mock).mockReturnValue({});

    // First drain completes parent
    (drainResolvedCompletions as jest.Mock)
      .mockResolvedValueOnce({
        status: 'done',
        applied: 1,
        state: { ...parentState, variables: { completed: true } },
      })
      // Second drain (grandparent) waits
      .mockResolvedValueOnce({
        status: 'waiting',
        applied: 0,
        state: grandparentState,
      });

    const output = makeMockOutput();

    const result = await handleDelegationCompletion(childState, 'pass', '/test', output, 0);

    expect(result).toBe('handled');
    // Should have called upsert twice (child→parent, parent→grandparent)
    expect(mockLifecycle.upsertResolvedCompletion).toHaveBeenCalledTimes(2);
  });

  it('stops cascading at max recursion depth', async () => {
    const childState = makeState('child-id', {
      delegation: {
        parentRunId: 'parent-id',
        parentStepId: '1',
        tokenHash: 'sha256:test',
        parentStep: '1',
        parentFrameKey: '1|',
        parentEntry: 1,
      },
    });

    const output = makeMockOutput();

    // Call with depth at limit
    const result = await handleDelegationCompletion(childState, 'pass', '/test', output, 32);

    expect(result).toBe('handled');
    // Should not attempt lock acquisition
    const mockLock = makeMockLock();
    (core.DelegationLock as jest.Mock).mockImplementation(mockLock);
    if (mockLock.mock.results.length > 0) {
      const lockInstance = mockLock.mock.results[0].value;
      expect(lockInstance.acquire).not.toHaveBeenCalled();
    }
  });

  it('runs execution loop when completions are applied', async () => {
    const childState = makeState('child-id', {
      delegation: {
        parentRunId: 'parent-id',
        parentStepId: '1',
        tokenHash: 'sha256:test',
        parentStep: '1',
        parentFrameKey: '1|',
        parentEntry: 1,
      },
    });

    const parentState = makeState('parent-id', {
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation: {
            tokenHash: 'sha256:test',
            childRunbookPath: 'child.md',
            contextSnapshot: { vars: {}, ancestors: [] },
            childRunId: 'child-id',
            createdAt: new Date().toISOString(),
            cancelledAt: null,
          },
        },
      ],
    });

    const mockManager = makeMockManager();
    mockManager.load.mockResolvedValue(parentState);

    const mockLifecycle = {
      getResolvedCompletion: jest.fn<any>().mockResolvedValue(null),
      upsertResolvedCompletion: jest.fn<any>().mockResolvedValue(undefined),
    };
    (core.ExecutionLifecycleService as jest.Mock).mockReturnValue(mockLifecycle);

    const mockLock = makeMockLock();
    (core.RunbookStateManager as jest.Mock).mockReturnValue(mockManager);
    (core.DelegationLock as jest.Mock).mockImplementation(mockLock);
    (core.RunbookActorService as jest.Mock).mockReturnValue({});
    (core.SessionService as jest.Mock).mockReturnValue({});

    (drainResolvedCompletions as jest.Mock).mockResolvedValue({
      status: 'waiting',
      applied: 1, // Completion was applied
      state: parentState,
    });

    (runExecutionLoop as jest.Mock).mockResolvedValue('waiting');

    const output = makeMockOutput();

    const result = await handleDelegationCompletion(childState, 'pass', '/test', output);

    expect(result).toBe('handled');
    expect(runExecutionLoop).toHaveBeenCalled();
  });

  it('cascades when execution loop reaches done state', async () => {
    const childState = makeState('child-id', {
      delegation: {
        parentRunId: 'parent-id',
        parentStepId: '1',
        tokenHash: 'sha256:child-token',
        parentStep: '1',
        parentFrameKey: '1|',
        parentEntry: 1,
      },
    });

    const parentState = makeState('parent-id', {
      delegation: {
        parentRunId: 'grandparent-id',
        parentStepId: '1',
        tokenHash: 'sha256:parent-token',
        parentStep: '1',
        parentFrameKey: '1|',
        parentEntry: 1,
      },
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation: {
            tokenHash: 'sha256:child-token',
            childRunbookPath: 'child.md',
            contextSnapshot: { vars: {}, ancestors: [] },
            childRunId: 'child-id',
            createdAt: new Date().toISOString(),
            cancelledAt: null,
          },
        },
      ],
    });

    const grandparentState = makeState('grandparent-id');

    const mockManager = makeMockManager();
    let loadCallCount = 0;
    mockManager.load.mockImplementation(async (id: string) => {
      loadCallCount++;
      if (id === 'parent-id' && loadCallCount <= 2) {
        return parentState;
      }
      if (id === 'grandparent-id') {
        return grandparentState;
      }
      return null;
    });

    const mockLifecycle = {
      getResolvedCompletion: jest.fn<any>().mockResolvedValue(null),
      upsertResolvedCompletion: jest.fn<any>().mockResolvedValue(undefined),
    };
    (core.ExecutionLifecycleService as jest.Mock).mockReturnValue(mockLifecycle);

    const mockLock = makeMockLock();
    (core.RunbookStateManager as jest.Mock).mockReturnValue(mockManager);
    (core.DelegationLock as jest.Mock).mockImplementation(mockLock);
    (core.RunbookActorService as jest.Mock).mockReturnValue({});
    (core.SessionService as jest.Mock).mockReturnValue({});

    (drainResolvedCompletions as jest.Mock)
      .mockResolvedValueOnce({
        status: 'waiting',
        applied: 1,
        state: parentState,
      })
      .mockResolvedValueOnce({
        status: 'waiting',
        applied: 0,
        state: grandparentState,
      });

    (runExecutionLoop as jest.Mock).mockResolvedValue('done');

    const output = makeMockOutput();

    const result = await handleDelegationCompletion(childState, 'pass', '/test', output);

    expect(result).toBe('handled');
    expect(mockLifecycle.upsertResolvedCompletion).toHaveBeenCalledTimes(2);
  });

  it('uses fail transition config when result is fail', async () => {
    const childState = makeState('child-id', {
      delegation: {
        parentRunId: 'parent-id',
        parentStepId: '1',
        tokenHash: 'sha256:test',
        parentStep: '1',
        parentFrameKey: '1|',
        parentEntry: 1,
      },
    });

    const parentState = makeState('parent-id', {
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation: {
            tokenHash: 'sha256:test',
            childRunbookPath: 'child.md',
            contextSnapshot: { vars: {}, ancestors: [] },
            childRunId: 'child-id',
            createdAt: new Date().toISOString(),
            cancelledAt: null,
          },
        },
      ],
    });

    const mockManager = makeMockManager();
    mockManager.load.mockResolvedValue(parentState);

    const mockLifecycle = {
      getResolvedCompletion: jest.fn<any>().mockResolvedValue(null),
      upsertResolvedCompletion: jest.fn<any>().mockResolvedValue(undefined),
    };
    (core.ExecutionLifecycleService as jest.Mock).mockReturnValue(mockLifecycle);

    const mockLock = makeMockLock();
    (core.RunbookStateManager as jest.Mock).mockReturnValue(mockManager);
    (core.DelegationLock as jest.Mock).mockImplementation(mockLock);
    (core.RunbookActorService as jest.Mock).mockReturnValue({});
    (core.SessionService as jest.Mock).mockReturnValue({});

    (drainResolvedCompletions as jest.Mock).mockResolvedValue({
      status: 'waiting',
      applied: 0,
      state: parentState,
    });

    const output = makeMockOutput();

    const result = await handleDelegationCompletion(childState, 'fail', '/test', output);

    expect(result).toBe('handled');
    expect(mockLifecycle.upsertResolvedCompletion).toHaveBeenCalledWith(
      'parent-id',
      expect.any(String),
      expect.objectContaining({
        result: 'fail',
      }),
    );
  });

  it('does not record completion if one already exists', async () => {
    const childState = makeState('child-id', {
      delegation: {
        parentRunId: 'parent-id',
        parentStepId: '1',
        tokenHash: 'sha256:test',
        parentStep: '1',
        parentFrameKey: '1|',
        parentEntry: 1,
      },
    });

    const parentState = makeState('parent-id', {
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation: {
            tokenHash: 'sha256:test',
            childRunbookPath: 'child.md',
            contextSnapshot: { vars: {}, ancestors: [] },
            childRunId: 'child-id',
            createdAt: new Date().toISOString(),
            cancelledAt: null,
          },
        },
      ],
    });

    const existingCompletion = {
      agentId: 'delegation',
      result: 'pass',
      targetStep: '1',
      targetSubstep: '1',
    };

    const mockManager = makeMockManager();
    mockManager.load.mockResolvedValue(parentState);

    const mockLifecycle = {
      getResolvedCompletion: jest.fn<any>().mockResolvedValue(existingCompletion),
      upsertResolvedCompletion: jest.fn<any>().mockResolvedValue(undefined),
    };
    (core.ExecutionLifecycleService as jest.Mock).mockReturnValue(mockLifecycle);

    const mockLock = makeMockLock();
    (core.RunbookStateManager as jest.Mock).mockReturnValue(mockManager);
    (core.DelegationLock as jest.Mock).mockImplementation(mockLock);
    (core.RunbookActorService as jest.Mock).mockReturnValue({});
    (core.SessionService as jest.Mock).mockReturnValue({});

    (drainResolvedCompletions as jest.Mock).mockResolvedValue({
      status: 'waiting',
      applied: 0,
      state: parentState,
    });

    const output = makeMockOutput();

    const result = await handleDelegationCompletion(childState, 'pass', '/test', output);

    expect(result).toBe('handled');
    expect(mockLifecycle.upsertResolvedCompletion).not.toHaveBeenCalled();
  });
});