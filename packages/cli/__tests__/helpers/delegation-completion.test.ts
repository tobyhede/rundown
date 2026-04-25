import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { mockErrorHelpers } from './mock-error-helpers.js';
import { brandEffectiveVarsForTest, brandFrameKeyForTest } from './brand-helpers.js';
import { mockFn } from './typed-mocks.js';
import type {
  FrameKey,
  RunbookState,
  DelegationLinkage,
  SubstepState,
  ResolvedCompletion,
} from '@rundown-org/core';
import type { ResolvedStep } from '@rundown-org/parser';

// Mock @rundown-org/core
jest.unstable_mockModule('@rundown-org/core', () => ({
  RunbookStateManager: jest.fn(),
  RunbookActorService: jest.fn(),
  SessionService: jest.fn(),
  ExecutionLifecycleService: jest.fn(),
  DelegationLock: jest.fn(),
  buildCompletionKey: mockFn<(frameKey: FrameKey, entry: number, substep?: string) => string>()
    .mockImplementation(
      (frameKey, entry, substepId) => `${String(frameKey)}|${String(entry)}|${substepId ?? ''}`,
    ),
  buildResolvedCompletion: mockFn<(data: ResolvedCompletion) => ResolvedCompletion>()
    .mockImplementation((data) => data),
  deriveActiveFrame: mockFn<
    (state: RunbookState) => { frameKey: FrameKey; step: string; iteration?: number }
  >().mockImplementation((state) => ({
    frameKey: (state.activeFrameKey ?? `${String(state.step)}|`) as FrameKey,
    step: state.step,
    iteration: undefined,
  })),
  findSubstepState: mockFn<
    (
      substepStates: readonly SubstepState[],
      substepId: string,
      frameKey: FrameKey,
    ) => SubstepState | undefined
  >().mockImplementation((substepStates, substepId, frameKey) =>
    substepStates.find((ss) => ss.id === substepId && ss.frameKey === frameKey),
  ),
  upsertSubstepState: mockFn<
    (
      substepStates: readonly SubstepState[],
      substepId: string,
      frameKey: FrameKey,
      patch: Partial<SubstepState>,
    ) => readonly SubstepState[]
  >().mockImplementation((substepStates, substepId, frameKey, patch) => {
    const existing = substepStates.find(
      (ss) => ss.id === substepId && ss.frameKey === frameKey,
    );
    if (existing) {
      return substepStates.map((ss) => (ss === existing ? { ...ss, ...patch } : ss));
    }
    return [
      ...substepStates,
      { id: substepId, frameKey, status: 'pending', ...patch } as SubstepState,
    ];
  }),
  logger: {
    warn: mockFn<(...args: unknown[]) => void>(),
    info: mockFn<(...args: unknown[]) => void>(),
    debug: mockFn<(...args: unknown[]) => void>(),
    error: mockFn<(...args: unknown[]) => void>(),
  },
  ...mockErrorHelpers,
}));

// Mock runbook-loader
jest.unstable_mockModule('../../src/helpers/runbook-loader', () => ({
  getRunbookFromState: mockFn<() => readonly ResolvedStep[]>().mockReturnValue([
    {
      name: '1',
      description: 'Test step',
      transitions: { pass: { action: 'continue' as const, retry: 0 } },
    } as unknown as ResolvedStep,
  ]),
}));

// Mock execution service
jest.unstable_mockModule('../../src/services/execution', () => ({
  drainResolvedCompletions: jest.fn(),
  runExecutionLoop: jest.fn(),
}));

// Mock execution-emitter
jest.unstable_mockModule('../../src/helpers/execution-emitter', () => ({
  createBridgedEmitter: mockFn<() => { emit: jest.Mock }>().mockReturnValue({
    emit: jest.fn(),
  }),
}));

// Mock transitions
jest.unstable_mockModule('../../src/helpers/transitions', () => ({
  createPassTransitionConfig: mockFn<
    () => { policy: string; computeActionResult: jest.Mock }
  >().mockReturnValue({
    policy: 'pass',
    computeActionResult: jest.fn(),
  }),
  createFailTransitionConfig: mockFn<
    () => { policy: string; computeActionResult: jest.Mock }
  >().mockReturnValue({
    policy: 'fail',
    computeActionResult: jest.fn(),
  }),
}));

// Import after mocking
const core = await import('@rundown-org/core');
const { getRunbookFromState } = await import('../../src/helpers/runbook-loader.js');
const { drainResolvedCompletions, runExecutionLoop } = await import(
  '../../src/services/execution.js'
);
const { createBridgedEmitter } = await import('../../src/helpers/execution-emitter.js');
const { createPassTransitionConfig, createFailTransitionConfig } = await import(
  '../../src/helpers/transitions.js'
);
const { handleParentCompletion, extractParentLinkage } = await import(
  '../../src/helpers/delegation-completion.js'
);

function makeState(id: string, overrides: Partial<RunbookState> = {}): RunbookState {
  return {
    id,
    runbook: 'test.md',
    runbookPath: '/tmp/test.md',
    runbookSrc: '## 1. Step\n- PASS COMPLETE',
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
    kind: 'delegation' as const,
    parentRunId: 'parent-run-id',
    parentStepId: '1',
    tokenHash: 'sha256:abc123',
    parentStep: '1',
    parentFrameKey: brandFrameKeyForTest('1'),
    parentEntry: 1,
    ...overrides,
  };
}

function makeOutput(): any {
  return {
    flush: jest.fn(),
    status: jest.fn(),
    error: jest.fn(),
    warning: jest.fn(),
  };
}

function makeManager(states: Map<string, RunbookState | null>): any {
  return {
    load: jest.fn<any>().mockImplementation(async (id: string) => states.get(id) ?? null),
    update: jest.fn<any>().mockResolvedValue(undefined),
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
  MockActor.mockImplementation(
    () =>
      ({
        sendAndSync: jest.fn<any>().mockResolvedValue(null),
      }) as any,
  );
  MockSession.mockImplementation(
    () =>
      ({
        popRunbook: jest.fn<any>().mockResolvedValue(null),
      }) as any,
  );
}

beforeEach(() => {
  jest.resetAllMocks();
  // Re-establish default mock implementations
  (core.buildCompletionKey as jest.Mock<any>).mockImplementation(
    (frameKey: string, entry: number, substepId: string) =>
      `${frameKey}|${String(entry)}|${substepId}`,
  );
  (core.buildResolvedCompletion as jest.Mock<any>).mockImplementation((data: any) => data);
  (core.deriveActiveFrame as jest.Mock<any>).mockImplementation((state: any) => ({
    frameKey: state.activeFrameKey ?? `${String(state.step)}|`,
    step: state.step,
    iteration: state.activeForContext?.iteration,
  }));
  (core.findSubstepState as jest.Mock<any>).mockImplementation(
    (substepStates: any[], substepId: string, frameKey: string) =>
      substepStates.find((ss: any) => ss.id === substepId && ss.frameKey === frameKey),
  );
  (getRunbookFromState as jest.Mock<any>).mockReturnValue([
    {
      name: '1',
      description: 'Test step',
      transitions: { pass: { action: 'continue' as const, retry: 0 } },
    },
  ]);
  (createBridgedEmitter as jest.Mock<any>).mockReturnValue({ emit: jest.fn() });
  (drainResolvedCompletions as jest.Mock<any>).mockResolvedValue({
    status: 'continue',
    applied: 1,
    state: makeState('parent-run-id'),
  });
  (runExecutionLoop as jest.Mock<any>).mockResolvedValue('waiting');
  (createPassTransitionConfig as jest.Mock<any>).mockReturnValue({
    policy: 'pass',
    computeActionResult: jest.fn(),
  });
  (createFailTransitionConfig as jest.Mock<any>).mockReturnValue({
    policy: 'fail',
    computeActionResult: jest.fn(),
  });
});

describe('handleParentCompletion', () => {
  it('returns not-applicable when child has no delegation linkage', async () => {
    const childState = makeState('child-run-id');
    const output = makeOutput();

    const result = await handleParentCompletion(childState, 'pass', '/test', output);

    expect(result).toBe('not-applicable');
  });

  it('acquires delegation lock on parent run ID', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState('child-run-id', { parentLinkage: delegation });
    const parentState = makeState('parent-run-id', {
      substepStates: [{ id: '1', frameKey: brandFrameKeyForTest('1'), status: 'pending' }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    await handleParentCompletion(childState, 'pass', '/test', output);

    expect(lock.acquire).toHaveBeenCalledWith('parent-run-id');
    expect(lock.release).toHaveBeenCalledWith('parent-run-id');
  });

  it('returns not-applicable when parent no longer exists', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState('child-run-id', { parentLinkage: delegation });

    const states = new Map([['parent-run-id', null]]);
    const manager = makeManager(states);
    const lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    const result = await handleParentCompletion(childState, 'pass', '/test', output);

    expect(result).toBe('not-applicable');
    expect(lock.release).toHaveBeenCalled();
  });

  it('does not block inline child when substep has cancelled delegation', async () => {
    const childState = makeState('child-run-id', {
      parentLinkage: {
        kind: 'inline' as const,
        parentRunId: 'parent-run-id',
        parentStepId: '1',
        parentStep: '1',
        parentFrameKey: brandFrameKeyForTest('1') as any,
        parentEntry: 1,
      },
    });
    const parentState = makeState('parent-run-id', {
      step: '1',
      activeEntry: 1,
      activeFrameKey: brandFrameKeyForTest('1'),
      substepStates: [
        {
          id: '1',
          frameKey: brandFrameKeyForTest('1'),
          status: 'pending',
          delegation: {
            tokenHash: 'sha256:old-token',
            childRunbookPath: 'old-child.md',
            contextSnapshot: { vars: brandEffectiveVarsForTest(), ancestors: [] },
            childRunId: 'old-child-run-id',
            createdAt: '2026-01-01T00:00:00.000Z',
            cancelledAt: '2026-01-01T00:00:00.000Z',
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

    (drainResolvedCompletions as jest.Mock<any>).mockResolvedValue({
      status: 'continue',
      applied: 0,
      state: parentState,
    });

    const result = await handleParentCompletion(childState, 'pass', '/test', output);

    // Inline child should NOT be blocked by the cancelled delegation
    expect(result).not.toBe('not-applicable');
    expect(lifecycleService.upsertResolvedCompletion).toHaveBeenCalledWith(
      'parent-run-id',
      expect.any(String),
      expect.objectContaining({
        agentId: 'inline',
        result: 'pass',
        targetSubstep: '1',
      }),
    );
  });

  it('skips propagation when delegation was cancelled', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState('child-run-id', { parentLinkage: delegation });
    const parentState = makeState('parent-run-id', {
      substepStates: [
        {
          id: '1',
          frameKey: brandFrameKeyForTest('1'),
          status: 'pending',
          delegation: {
            tokenHash: 'sha256:abc123',
            childRunbookPath: 'child.md',
            contextSnapshot: { vars: brandEffectiveVarsForTest(), ancestors: [] },
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

    const result = await handleParentCompletion(childState, 'pass', '/test', output);

    expect(result).toBe('handled');
    expect(lifecycleService.upsertResolvedCompletion).not.toHaveBeenCalled();
  });

  it('records resolved completion on parent', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState('child-run-id', { parentLinkage: delegation });
    const parentState = makeState('parent-run-id', {
      step: '1',
      activeEntry: 1,
      activeFrameKey: brandFrameKeyForTest('1'),
      substepStates: [{ id: '1', frameKey: brandFrameKeyForTest('1'), status: 'pending' }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    (drainResolvedCompletions as jest.Mock<any>).mockResolvedValue({
      status: 'continue',
      applied: 0,
      state: parentState,
    });

    await handleParentCompletion(childState, 'pass', '/test', output);

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
    const childState = makeState('child-run-id', { parentLinkage: delegation });
    const parentState = makeState('parent-run-id', {
      substepStates: [{ id: '1', frameKey: brandFrameKeyForTest('1'), status: 'pending' }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    (drainResolvedCompletions as jest.Mock<any>).mockResolvedValue({
      status: 'continue',
      applied: 1,
      state: parentState,
    });

    await handleParentCompletion(childState, 'pass', '/test', output);

    expect(drainResolvedCompletions).toHaveBeenCalledWith(
      expect.objectContaining({
        runbookId: 'parent-run-id',
        currentState: parentState,
      }),
    );
  });

  it('runs execution loop when completions were applied', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState('child-run-id', { parentLinkage: delegation });
    const parentState = makeState('parent-run-id', {
      substepStates: [{ id: '1', frameKey: brandFrameKeyForTest('1'), status: 'pending' }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    (drainResolvedCompletions as jest.Mock<any>).mockResolvedValue({
      status: 'continue',
      applied: 1,
      state: parentState,
    });

    await handleParentCompletion(childState, 'pass', '/test', output);

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
    const childState = makeState('child-run-id', { parentLinkage: delegation });
    const parentState = makeState('parent-run-id', {
      substepStates: [{ id: '1', frameKey: brandFrameKeyForTest('1'), status: 'pending' }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    (drainResolvedCompletions as jest.Mock<any>).mockResolvedValue({
      status: 'stopped',
      applied: 1,
      state: parentState,
    });

    const result = await handleParentCompletion(childState, 'fail', '/test', output);

    expect(result).toBe('stopped');
  });

  it('cascades to grandparent when parent completes', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState('child-run-id', { parentLinkage: delegation });
    const grandparentDelegation = makeDelegationLinkage({
      parentRunId: 'grandparent-run-id',
      parentStepId: '2',
    });
    const parentState = makeState('parent-run-id', {
      substepStates: [{ id: '1', frameKey: brandFrameKeyForTest('1'), status: 'pending' }],
      parentLinkage: grandparentDelegation,
    });
    const grandparentState = makeState('grandparent-run-id', {
      substepStates: [{ id: '2', frameKey: brandFrameKeyForTest('1'), status: 'pending' }],
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

    (drainResolvedCompletions as jest.Mock<any>).mockResolvedValue({
      status: 'done',
      applied: 1,
      state: parentState,
    });

    await handleParentCompletion(childState, 'pass', '/test', output);

    // Should cascade - second acquire should be on grandparent
    expect(lock.acquire).toHaveBeenCalledWith('parent-run-id');
    expect(lock.acquire).toHaveBeenCalledWith('grandparent-run-id');
  });

  it('respects maximum recursion depth', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState('child-run-id', { parentLinkage: delegation });
    const output = makeOutput();

    // Call with depth already at limit
    const result = await handleParentCompletion(childState, 'pass', '/test', output, 32);

    expect(result).toBe('handled');
    // Should not even acquire lock
    const MockLock = core.DelegationLock as jest.MockedClass<typeof core.DelegationLock>;
    expect(MockLock).not.toHaveBeenCalled();
  });

  it('passes delegation-specific popRunbook:false policy to drain', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState('child-run-id', { parentLinkage: delegation });
    const parentState = makeState('parent-run-id', {
      substepStates: [{ id: '1', frameKey: brandFrameKeyForTest('1'), status: 'pending' }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    (drainResolvedCompletions as jest.Mock<any>).mockResolvedValue({
      status: 'continue',
      applied: 0,
      state: parentState,
    });

    await handleParentCompletion(childState, 'pass', '/test', output);

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
    const childState = makeState('child-run-id', { parentLinkage: delegation });
    const parentState = makeState('parent-run-id', {
      substepStates: [{ id: '1', frameKey: brandFrameKeyForTest('1'), status: 'pending' }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    (drainResolvedCompletions as jest.Mock<any>).mockResolvedValue({
      status: 'done',
      applied: 1,
      state: parentState,
    });

    await handleParentCompletion(childState, 'pass', '/test', output);

    const MockSession = core.SessionService as jest.MockedClass<typeof core.SessionService>;
    const sessionInstance = MockSession.mock.results[0]?.value as { popRunbook: jest.Mock<any> };
    expect(sessionInstance.popRunbook).toHaveBeenCalled();
  });

  it('explicitly pops session when drain returns stopped', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState('child-run-id', { parentLinkage: delegation });
    const parentState = makeState('parent-run-id', {
      substepStates: [{ id: '1', frameKey: brandFrameKeyForTest('1'), status: 'pending' }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    (drainResolvedCompletions as jest.Mock<any>).mockResolvedValue({
      status: 'stopped',
      applied: 1,
      state: parentState,
    });

    await handleParentCompletion(childState, 'fail', '/test', output);

    const MockSession = core.SessionService as jest.MockedClass<typeof core.SessionService>;
    const sessionInstance = MockSession.mock.results[0]?.value as { popRunbook: jest.Mock<any> };
    expect(sessionInstance.popRunbook).toHaveBeenCalled();
  });

  it('uses fail transition config when result is fail', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState('child-run-id', { parentLinkage: delegation });
    const parentState = makeState('parent-run-id', {
      substepStates: [{ id: '1', frameKey: brandFrameKeyForTest('1'), status: 'pending' }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    (drainResolvedCompletions as jest.Mock<any>).mockResolvedValue({
      status: 'continue',
      applied: 0,
      state: parentState,
    });

    await handleParentCompletion(childState, 'fail', '/test', output);

    expect(createFailTransitionConfig).toHaveBeenCalled();
    expect(createPassTransitionConfig).not.toHaveBeenCalled();
  });

  it('flushes output after handling', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState('child-run-id', { parentLinkage: delegation });
    const parentState = makeState('parent-run-id', {
      substepStates: [{ id: '1', frameKey: brandFrameKeyForTest('1'), status: 'pending' }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    (drainResolvedCompletions as jest.Mock<any>).mockResolvedValue({
      status: 'continue',
      applied: 0,
      state: parentState,
    });

    await handleParentCompletion(childState, 'pass', '/test', output);

    expect(output.flush).toHaveBeenCalled();
  });

  it('passes parentFrameKey as frameKeyOverride to drain', async () => {
    const delegation = makeDelegationLinkage({ parentFrameKey: brandFrameKeyForTest('1', 3) });
    const childState = makeState('child-run-id', { parentLinkage: delegation });
    const parentState = makeState('parent-run-id', {
      substepStates: [{ id: '1', frameKey: brandFrameKeyForTest('1', 3), status: 'pending' }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    (drainResolvedCompletions as jest.Mock<any>).mockResolvedValue({
      status: 'continue',
      applied: 0,
      state: parentState,
    });

    await handleParentCompletion(childState, 'pass', '/test', output);

    expect(drainResolvedCompletions).toHaveBeenCalledWith(
      expect.objectContaining({
        frameKeyOverride: '1|3',
      }),
    );
  });

  it('does not pass frameKeyOverride when parentFrameKey is undefined', async () => {
    const delegation = makeDelegationLinkage({ parentFrameKey: undefined });
    const childState = makeState('child-run-id', { parentLinkage: delegation });
    const parentState = makeState('parent-run-id', {
      substepStates: [{ id: '1', frameKey: brandFrameKeyForTest('1'), status: 'pending' }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    (drainResolvedCompletions as jest.Mock<any>).mockResolvedValue({
      status: 'continue',
      applied: 0,
      state: parentState,
    });

    await handleParentCompletion(childState, 'pass', '/test', output);

    const drainCall = (drainResolvedCompletions as jest.Mock<any>).mock.calls[0][0] as {
      frameKeyOverride?: unknown;
    };
    expect(drainCall.frameKeyOverride).toBeUndefined();
  });

  it('forwards child finalVars to parent actor via SET_VARIABLES before drain', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState('child-run-id', {
      parentLinkage: delegation,
      finalVars: { PlanPath: '/work/plan.json', version: '2.1' },
    });
    const parentState = makeState('parent-run-id', {
      substepStates: [{ id: '1', frameKey: brandFrameKeyForTest('1'), status: 'pending' }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    (drainResolvedCompletions as jest.Mock<any>).mockResolvedValue({
      status: 'continue',
      applied: 0,
      state: parentState,
    });

    await handleParentCompletion(childState, 'pass', '/test', output);

    const MockActor = core.RunbookActorService as jest.MockedClass<typeof core.RunbookActorService>;
    const actorInstance = MockActor.mock.results[0]?.value as { sendAndSync: jest.Mock<any> };
    expect(actorInstance.sendAndSync).toHaveBeenCalledWith('parent-run-id', expect.any(Array), {
      type: 'SET_VARIABLES',
      vars: { PlanPath: '/work/plan.json', version: '2.1' },
    });
  });

  it('surfaces a warning to output when SET_VARIABLES fails', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState('child-run-id', {
      parentLinkage: delegation,
      finalVars: { PlanPath: '/work/plan.json' },
    });
    const parentState = makeState('parent-run-id', {
      substepStates: [{ id: '1', frameKey: brandFrameKeyForTest('1'), status: 'pending' }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const _lifecycleService = makeLifecycleService();
    const output = makeOutput();

    // Override the actor mock so sendAndSync throws for this test
    const MockActor = core.RunbookActorService as jest.MockedClass<typeof core.RunbookActorService>;
    MockActor.mockImplementation(
      () =>
        ({
          sendAndSync: jest.fn<any>().mockRejectedValue(new Error('machine rejected event')),
        }) as any,
    );

    (core.RunbookStateManager as unknown as jest.Mock<any>).mockImplementation(() => manager);
    (core.ExecutionLifecycleService as unknown as jest.Mock<any>).mockImplementation(() =>
      makeLifecycleService(),
    );
    (core.SessionService as unknown as jest.Mock<any>).mockImplementation(() => ({
      popRunbook: jest.fn<any>().mockResolvedValue(null),
    }));

    (drainResolvedCompletions as jest.Mock<any>).mockResolvedValue({
      status: 'continue',
      applied: 0,
      state: parentState,
    });

    await handleParentCompletion(childState, 'pass', '/test', output);

    expect(output.warning).toHaveBeenCalledWith(expect.stringContaining('SET_VARIABLES'));
  });

  it('does not call sendAndSync when child has no finalVars', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState('child-run-id', { parentLinkage: delegation });
    const parentState = makeState('parent-run-id', {
      substepStates: [{ id: '1', frameKey: brandFrameKeyForTest('1'), status: 'pending' }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    (drainResolvedCompletions as jest.Mock<any>).mockResolvedValue({
      status: 'continue',
      applied: 0,
      state: parentState,
    });

    await handleParentCompletion(childState, 'pass', '/test', output);

    const MockActor = core.RunbookActorService as jest.MockedClass<typeof core.RunbookActorService>;
    const actorInstance = MockActor.mock.results[0]?.value as { sendAndSync: jest.Mock<any> };
    expect(actorInstance.sendAndSync).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ type: 'SET_VARIABLES' }),
    );
  });
});

describe('inline linkage path', () => {
  it('extractParentLinkage returns inline linkage from state', () => {
    const state = makeState('child-run', {
      parentLinkage: {
        kind: 'inline' as const,
        parentRunId: 'parent-run',
        parentStepId: '1',
        parentStep: '1',
        parentFrameKey: brandFrameKeyForTest('1') as any,
        parentEntry: 1,
      },
    });
    const linkage = extractParentLinkage(state);
    expect(linkage).toBeDefined();
    expect(linkage!.parentRunId).toBe('parent-run');
  });

  it('agentId is inline for inline children', async () => {
    const childState = makeState('child-run-id', {
      parentLinkage: {
        kind: 'inline' as const,
        parentRunId: 'parent-run-id',
        parentStepId: '1',
        parentStep: '1',
        parentFrameKey: brandFrameKeyForTest('1') as any,
        parentEntry: 1,
      },
    });
    const parentState = makeState('parent-run-id', {
      step: '1',
      activeEntry: 1,
      activeFrameKey: brandFrameKeyForTest('1'),
      substepStates: [{ id: '1', frameKey: brandFrameKeyForTest('1'), status: 'pending' }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    (drainResolvedCompletions as jest.Mock<any>).mockResolvedValue({
      status: 'continue',
      applied: 0,
      state: parentState,
    });

    await handleParentCompletion(childState, 'pass', '/test', output);

    expect(lifecycleService.upsertResolvedCompletion).toHaveBeenCalledWith(
      'parent-run-id',
      expect.any(String),
      expect.objectContaining({
        agentId: 'inline',
        result: 'pass',
        targetSubstep: '1',
      }),
    );
  });
});
