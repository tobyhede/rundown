import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { RunbookState, DelegationLinkage } from '@rundown-org/core';

// Mock @rundown-org/core
jest.unstable_mockModule('@rundown-org/core', () => ({
  RunbookStateManager: jest.fn(),
  RunbookActorService: jest.fn(),
  SessionService: jest.fn(),
  ExecutionLifecycleService: jest.fn(),
  DelegationLock: jest.fn(),
  buildCompletionKey: jest.fn(
    (frameKey: string, entry: number, substepId: string) =>
      `${frameKey}|${String(entry)}|${substepId}`,
  ),
  buildResolvedCompletion: jest.fn((data: any) => data),
  deriveActiveFrame: jest.fn((state: any) => ({
    frameKey: state.activeFrameKey ?? `${String(state.step)}|`,
    step: state.step,
    iteration: state.activeForContext?.iteration,
  })),
}));

// Mock runbook-loader
jest.unstable_mockModule('../../src/helpers/runbook-loader', () => ({
  getRunbookFromState: jest.fn().mockReturnValue([
    {
      name: '1',
      description: 'Test step',
      transitions: { pass: { action: 'continue' as const, retry: 0 } },
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
  createBridgedEmitter: jest.fn().mockReturnValue({
    emit: jest.fn(),
  }),
}));

// Mock transitions
jest.unstable_mockModule('../../src/helpers/transitions', () => ({
  createPassTransitionConfig: jest.fn().mockReturnValue({
    policy: 'pass',
    computeActionResult: jest.fn(),
  }),
  createFailTransitionConfig: jest.fn().mockReturnValue({
    policy: 'fail',
    computeActionResult: jest.fn(),
  }),
}));

// Import after mocking
const core = await import('@rundown-org/core');
const { getRunbookFromState } = await import('../../src/helpers/runbook-loader');
const { drainResolvedCompletions, runExecutionLoop } = await import('../../src/services/execution');
const { createBridgedEmitter } = await import('../../src/helpers/execution-emitter');
const { createPassTransitionConfig, createFailTransitionConfig } = await import(
  '../../src/helpers/transitions'
);
const { handleDelegationCompletion } = await import('../../src/helpers/delegation-completion');

function makeState(id: string, overrides: Partial<RunbookState> = {}): RunbookState {
  return {
    id,
    runbook: 'test.md',
    runbookPath: '/tmp/test.md',
    runbookSrc: '## 1. Step\n- PASS: COMPLETE',
    step: '1',
    stepName: 'Step',
    retryCount: 0,
    variables: {},
    steps: [{ id: '1', status: 'running' }],
    startedAt: '2026-02-27T10:00:00.000Z',
    updatedAt: '2026-02-27T10:00:00.000Z',
    ...overrides,
  } as RunbookState;
}

function makeDelegationLinkage(overrides: Partial<DelegationLinkage> = {}): DelegationLinkage {
  return {
    parentRunId: 'parent-run-id',
    parentStepId: '1',
    tokenHash: 'sha256:abc123',
    parentStep: '1',
    parentFrameKey: '1|',
    parentEntry: 1,
    ...overrides,
  };
}

function makeOutput(): any {
  return {
    flush: jest.fn(),
    status: jest.fn(),
    error: jest.fn(),
  };
}

function makeManager(states: Map<string, RunbookState | null>): any {
  return {
    load: jest.fn<any>().mockImplementation(async (id: string) => states.get(id) ?? null),
  };
}

function makeLock(): any {
  const MockLock = core.DelegationLock as jest.MockedClass<typeof core.DelegationLock>;
  const lockInstance = {
    acquire: jest.fn<any>().mockResolvedValue(undefined),
    release: jest.fn<any>().mockResolvedValue(undefined),
  };
  MockLock.mockImplementation(() => lockInstance as any);
  return lockInstance;
}

function makeLifecycleService(resolvedCompletions: Map<string, any> = new Map()): any {
  return {
    getResolvedCompletion: jest
      .fn<any>()
      .mockImplementation(
        async (_runId: string, key: string) => resolvedCompletions.get(key) ?? null,
      ),
    upsertResolvedCompletion: jest.fn<any>().mockResolvedValue(undefined),
  };
}

function wireMocks(manager: any, lifecycleService: any): void {
  const MockManager = core.RunbookStateManager as jest.MockedClass<typeof core.RunbookStateManager>;
  const MockLifecycle = core.ExecutionLifecycleService as jest.MockedClass<
    typeof core.ExecutionLifecycleService
  >;
  const MockActor = core.RunbookActorService as jest.MockedClass<typeof core.RunbookActorService>;
  const MockSession = core.SessionService as jest.MockedClass<typeof core.SessionService>;

  MockManager.mockImplementation(() => manager);
  MockLifecycle.mockImplementation(() => lifecycleService);
  MockActor.mockImplementation(() => ({}) as any);
  MockSession.mockImplementation(
    () =>
      ({
        popRunbook: jest.fn().mockResolvedValue(null),
      }) as any,
  );
}

beforeEach(() => {
  jest.resetAllMocks();
  // Re-establish default mock implementations
  (core.buildCompletionKey as jest.Mock).mockImplementation(
    (frameKey: string, entry: number, substepId: string) =>
      `${frameKey}|${String(entry)}|${substepId}`,
  );
  (core.buildResolvedCompletion as jest.Mock).mockImplementation((data: any) => data);
  (core.deriveActiveFrame as jest.Mock).mockImplementation((state: any) => ({
    frameKey: state.activeFrameKey ?? `${String(state.step)}|`,
    step: state.step,
    iteration: state.activeForContext?.iteration,
  }));
  (getRunbookFromState as jest.Mock).mockReturnValue([
    {
      name: '1',
      description: 'Test step',
      transitions: { pass: { action: 'continue' as const, retry: 0 } },
    },
  ]);
  (createBridgedEmitter as jest.Mock).mockReturnValue({ emit: jest.fn() });
  (drainResolvedCompletions as jest.Mock).mockResolvedValue({
    status: 'continue',
    applied: 1,
    state: makeState('parent-run-id'),
  });
  (runExecutionLoop as jest.Mock).mockResolvedValue('waiting');
  (createPassTransitionConfig as jest.Mock).mockReturnValue({
    policy: 'pass',
    computeActionResult: jest.fn(),
  });
  (createFailTransitionConfig as jest.Mock).mockReturnValue({
    policy: 'fail',
    computeActionResult: jest.fn(),
  });
});

describe('handleDelegationCompletion', () => {
  it('returns not-applicable when child has no delegation linkage', async () => {
    const childState = makeState('child-run-id');
    const output = makeOutput();

    const result = await handleDelegationCompletion(childState, 'pass', '/test', output);

    expect(result).toBe('not-applicable');
  });

  it('acquires delegation lock on parent run ID', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState('child-run-id', { delegation });
    const parentState = makeState('parent-run-id', {
      substepStates: [{ id: '1', status: 'pending', delegation: null }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    await handleDelegationCompletion(childState, 'pass', '/test', output);

    expect(lock.acquire).toHaveBeenCalledWith('parent-run-id');
    expect(lock.release).toHaveBeenCalledWith('parent-run-id');
  });

  it('returns not-applicable when parent no longer exists', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState('child-run-id', { delegation });

    const states = new Map([['parent-run-id', null]]);
    const manager = makeManager(states);
    const lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    const result = await handleDelegationCompletion(childState, 'pass', '/test', output);

    expect(result).toBe('not-applicable');
    expect(lock.release).toHaveBeenCalled();
  });

  it('skips propagation when delegation was cancelled', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState('child-run-id', { delegation });
    const parentState = makeState('parent-run-id', {
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation: {
            tokenHash: 'sha256:abc123',
            childRunbookPath: 'child.md',
            contextSnapshot: { vars: {}, ancestors: [] },
            childRunId: 'child-run-id',
            createdAt: '2026-02-27T10:00:00.000Z',
            cancelledAt: '2026-02-27T10:05:00.000Z',
          },
        },
      ],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    const result = await handleDelegationCompletion(childState, 'pass', '/test', output);

    expect(result).toBe('handled');
    expect(lifecycleService.upsertResolvedCompletion).not.toHaveBeenCalled();
  });

  it('records resolved completion on parent', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState('child-run-id', { delegation });
    const parentState = makeState('parent-run-id', {
      step: '1',
      activeEntry: 1,
      activeFrameKey: '1|',
      substepStates: [{ id: '1', status: 'pending', delegation: null }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    (drainResolvedCompletions as jest.Mock).mockResolvedValue({
      status: 'continue',
      applied: 0,
      state: parentState,
    });

    await handleDelegationCompletion(childState, 'pass', '/test', output);

    expect(lifecycleService.upsertResolvedCompletion).toHaveBeenCalledWith(
      'parent-run-id',
      '1||1|1',
      expect.objectContaining({
        agentId: 'delegation',
        result: 'pass',
        targetSubstep: '1',
      }),
    );
  });

  it('drains resolved completions on parent after recording', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState('child-run-id', { delegation });
    const parentState = makeState('parent-run-id', {
      substepStates: [{ id: '1', status: 'pending', delegation: null }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    (drainResolvedCompletions as jest.Mock).mockResolvedValue({
      status: 'continue',
      applied: 1,
      state: parentState,
    });

    await handleDelegationCompletion(childState, 'pass', '/test', output);

    expect(drainResolvedCompletions).toHaveBeenCalledWith(
      expect.objectContaining({
        runbookId: 'parent-run-id',
        currentState: parentState,
      }),
    );
  });

  it('runs execution loop when completions were applied', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState('child-run-id', { delegation });
    const parentState = makeState('parent-run-id', {
      substepStates: [{ id: '1', status: 'pending', delegation: null }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    (drainResolvedCompletions as jest.Mock).mockResolvedValue({
      status: 'continue',
      applied: 1,
      state: parentState,
    });

    await handleDelegationCompletion(childState, 'pass', '/test', output);

    expect(runExecutionLoop).toHaveBeenCalledWith(
      manager,
      'parent-run-id',
      expect.any(Array),
      '/test',
      false,
      expect.any(Object),
    );
  });

  it('returns stopped when drain results in stopped status', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState('child-run-id', { delegation });
    const parentState = makeState('parent-run-id', {
      substepStates: [{ id: '1', status: 'pending', delegation: null }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    (drainResolvedCompletions as jest.Mock).mockResolvedValue({
      status: 'stopped',
      applied: 1,
      state: parentState,
    });

    const result = await handleDelegationCompletion(childState, 'fail', '/test', output);

    expect(result).toBe('stopped');
  });

  it('cascades to grandparent when parent completes', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState('child-run-id', { delegation });
    const grandparentDelegation = makeDelegationLinkage({
      parentRunId: 'grandparent-run-id',
      parentStepId: '2',
    });
    const parentState = makeState('parent-run-id', {
      substepStates: [{ id: '1', status: 'pending', delegation: null }],
      delegation: grandparentDelegation,
    });
    const grandparentState = makeState('grandparent-run-id', {
      substepStates: [{ id: '2', status: 'pending', delegation: null }],
    });

    const states = new Map([
      [parentState.id, parentState],
      [grandparentState.id, grandparentState],
    ]);
    const manager = makeManager(states);
    const lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    (drainResolvedCompletions as jest.Mock).mockResolvedValue({
      status: 'done',
      applied: 1,
      state: parentState,
    });

    await handleDelegationCompletion(childState, 'pass', '/test', output);

    // Should cascade - second acquire should be on grandparent
    expect(lock.acquire).toHaveBeenCalledWith('parent-run-id');
    expect(lock.acquire).toHaveBeenCalledWith('grandparent-run-id');
  });

  it('respects maximum recursion depth', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState('child-run-id', { delegation });
    const output = makeOutput();

    // Call with depth already at limit
    const result = await handleDelegationCompletion(childState, 'pass', '/test', output, 32);

    expect(result).toBe('handled');
    // Should not even acquire lock
    const MockLock = core.DelegationLock as jest.MockedClass<typeof core.DelegationLock>;
    expect(MockLock).not.toHaveBeenCalled();
  });

  it('passes delegation-specific popRunbook:false policy to drain', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState('child-run-id', { delegation });
    const parentState = makeState('parent-run-id', {
      substepStates: [{ id: '1', status: 'pending', delegation: null }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    (drainResolvedCompletions as jest.Mock).mockResolvedValue({
      status: 'continue',
      applied: 0,
      state: parentState,
    });

    await handleDelegationCompletion(childState, 'pass', '/test', output);

    expect(drainResolvedCompletions).toHaveBeenCalledWith(
      expect.objectContaining({
        transitionPolicy: {
          onComplete: { popRunbook: false },
          onStopped: { popRunbook: false },
        },
      }),
    );
  });

  it('explicitly pops session when drain returns done', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState('child-run-id', { delegation });
    const parentState = makeState('parent-run-id', {
      substepStates: [{ id: '1', status: 'pending', delegation: null }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    (drainResolvedCompletions as jest.Mock).mockResolvedValue({
      status: 'done',
      applied: 1,
      state: parentState,
    });

    await handleDelegationCompletion(childState, 'pass', '/test', output);

    const MockSession = core.SessionService as jest.MockedClass<typeof core.SessionService>;
    const sessionInstance = MockSession.mock.results[0]?.value;
    expect(sessionInstance.popRunbook).toHaveBeenCalled();
  });

  it('explicitly pops session when drain returns stopped', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState('child-run-id', { delegation });
    const parentState = makeState('parent-run-id', {
      substepStates: [{ id: '1', status: 'pending', delegation: null }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    (drainResolvedCompletions as jest.Mock).mockResolvedValue({
      status: 'stopped',
      applied: 1,
      state: parentState,
    });

    await handleDelegationCompletion(childState, 'fail', '/test', output);

    const MockSession = core.SessionService as jest.MockedClass<typeof core.SessionService>;
    const sessionInstance = MockSession.mock.results[0]?.value;
    expect(sessionInstance.popRunbook).toHaveBeenCalled();
  });

  it('uses fail transition config when result is fail', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState('child-run-id', { delegation });
    const parentState = makeState('parent-run-id', {
      substepStates: [{ id: '1', status: 'pending', delegation: null }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    (drainResolvedCompletions as jest.Mock).mockResolvedValue({
      status: 'continue',
      applied: 0,
      state: parentState,
    });

    await handleDelegationCompletion(childState, 'fail', '/test', output);

    expect(createFailTransitionConfig).toHaveBeenCalled();
    expect(createPassTransitionConfig).not.toHaveBeenCalled();
  });

  it('flushes output after handling', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState('child-run-id', { delegation });
    const parentState = makeState('parent-run-id', {
      substepStates: [{ id: '1', status: 'pending', delegation: null }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    (drainResolvedCompletions as jest.Mock).mockResolvedValue({
      status: 'continue',
      applied: 0,
      state: parentState,
    });

    await handleDelegationCompletion(childState, 'pass', '/test', output);

    expect(output.flush).toHaveBeenCalled();
  });
});
