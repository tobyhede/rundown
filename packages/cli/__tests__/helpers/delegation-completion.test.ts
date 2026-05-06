import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { mockErrorHelpers } from './mock-error-helpers.js';
import {
  brandDelegationTokenHashForTest,
  brandEffectiveVarsForTest,
  brandFrameKeyForTest,
  brandRunIdForTest,
  brandStoredOutputsForTest,
} from './brand-helpers.js';
import { mockFn } from './typed-mocks.js';
import type {
  FrameKey,
  RunbookState,
  DelegationLinkage,
  SubstepState,
  ResolvedCompletion,
  RunbookStateManager as RunbookStateManagerType,
  RunbookActorService as RunbookActorServiceType,
  SessionService as SessionServiceType,
  ExecutionLifecycleService as ExecutionLifecycleServiceType,
  DelegationLock as DelegationLockType,
} from '@rundown-org/core';
import type { ResolvedStep } from '@rundown-org/parser';
import type { OutputEmitter } from '../../src/services/output-emitter.js';

type SubstepStatePatch = Partial<Pick<SubstepState, 'status' | 'result' | 'delegation'>>;

const PARENT_RUN_ID = brandRunIdForTest('rd_11111111111111111111111111111111');
const CHILD_RUN_ID = brandRunIdForTest('rd_22222222222222222222222222222222');
const GRANDPARENT_RUN_ID = brandRunIdForTest('rd_33333333333333333333333333333333');
const OLD_CHILD_RUN_ID = brandRunIdForTest('rd_44444444444444444444444444444444');

function upsertSubstepStateForTest(
  substepStates: readonly SubstepState[],
  substepId: string,
  frameKey: FrameKey,
  patch: SubstepStatePatch,
): readonly SubstepState[] {
  const existing = substepStates.find((ss) => ss.id === substepId && ss.frameKey === frameKey);
  if (existing) {
    return substepStates.map((ss) => (ss === existing ? { ...ss, ...patch } : ss));
  }
  return [...substepStates, { id: substepId, frameKey, status: 'pending', ...patch }];
}

// Mock @rundown-org/core
jest.unstable_mockModule('@rundown-org/core', () => ({
  RunbookStateManager: jest.fn(),
  RunbookActorService: jest.fn(),
  SessionService: jest.fn(),
  ExecutionLifecycleService: jest.fn(),
  DelegationLock: jest.fn(),
  buildCompletionKey: mockFn<
    (frameKey: FrameKey, entry: number, substep?: string) => string
  >().mockImplementation(
    (frameKey, entry, substepId) => `${String(frameKey)}|${String(entry)}|${substepId ?? ''}`,
  ),
  buildResolvedCompletion: mockFn<
    (
      fields: Omit<ResolvedCompletion, 'completedAt'> & { completedAt?: string },
    ) => ResolvedCompletion
  >().mockImplementation((fields) => ({
    ...fields,
    completedAt: fields.completedAt ?? '2026-02-27T10:00:00.000Z',
  })),
  deriveActiveFrame: mockFn<
    (state: RunbookState) => { frameKey: FrameKey; step: string; iteration?: number }
  >().mockImplementation((state) => ({
    frameKey: (state.activeFrameKey ?? `${state.step}|`) as FrameKey,
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
  upsertSubstepState:
    mockFn<
      (
        substepStates: readonly SubstepState[],
        substepId: string,
        frameKey: FrameKey,
        patch: SubstepStatePatch,
      ) => readonly SubstepState[]
    >().mockImplementation(upsertSubstepStateForTest),
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
      kind: 'base',
      name: '1',
      description: 'Test step',
      transitions: {
        pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
        fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
      },
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

function makeState(id: RunbookState['id'], overrides: Partial<RunbookState> = {}): RunbookState {
  const base: RunbookState = {
    id,
    runbook: { source: 'project', path: 'test.md' },
    runbookPath: '/tmp/test.md',
    runbookSrc: '## 1. Step\n- PASS COMPLETE',
    step: '1',
    stepName: 'Step',
    retryCount: 0,
    variables: brandStoredOutputsForTest(),
    steps: [{ id: '1', status: 'running' }],
    startedAt: '2026-02-27T10:00:00.000Z',
    updatedAt: '2026-02-27T10:00:00.000Z',
  };
  return { ...base, ...overrides };
}

function makeDelegationLinkage(overrides: Partial<DelegationLinkage> = {}): DelegationLinkage {
  return {
    kind: 'delegation' as const,
    parentRunId: PARENT_RUN_ID,
    parentStepId: '1',
    tokenHash: brandDelegationTokenHashForTest(`sha256:${'a'.repeat(64)}`),
    parentStep: '1',
    parentFrameKey: brandFrameKeyForTest('1'),
    parentEntry: 1,
    ...overrides,
  };
}

interface MockOutput {
  flush: jest.Mock<() => void>;
  status: jest.Mock<(action: string, message?: string, data?: Record<string, unknown>) => void>;
  error: jest.Mock<(message: string) => void>;
  warning: jest.Mock<(text: string) => void>;
}

function makeOutput(): MockOutput & OutputEmitter {
  // Cast through unknown — the OutputEmitter has many more methods, but
  // delegation-completion only consumes flush/status/error/warning.
  return {
    flush: mockFn<() => void>(),
    status: mockFn<(action: string, message?: string, data?: Record<string, unknown>) => void>(),
    error: mockFn<(message: string) => void>(),
    warning: mockFn<(text: string) => void>(),
  } as unknown as MockOutput & OutputEmitter;
}

interface MockManager {
  load: jest.Mock<(id: string) => Promise<RunbookState | null>>;
  update: jest.Mock<(...args: unknown[]) => Promise<unknown>>;
}

function makeManager(states: Map<string, RunbookState | null>): MockManager {
  return {
    load: mockFn<(id: string) => Promise<RunbookState | null>>().mockImplementation(
      async (id) => states.get(id) ?? null,
    ),
    update: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined),
  };
}

interface MockLock {
  acquire: jest.Mock<(parentRunId: string) => Promise<void>>;
  release: jest.Mock<(parentRunId: string) => Promise<void>>;
}

function makeLock(): MockLock {
  const MockLockClass = core.DelegationLock as unknown as jest.Mock<() => DelegationLockType>;
  const lockInstance: MockLock = {
    acquire: mockFn<(parentRunId: string) => Promise<void>>().mockResolvedValue(undefined),
    release: mockFn<(parentRunId: string) => Promise<void>>().mockResolvedValue(undefined),
  };
  MockLockClass.mockImplementation(() => lockInstance as unknown as DelegationLockType);
  return lockInstance;
}

interface MockLifecycleService {
  getResolvedCompletion: jest.Mock<
    (runId: string, key: string) => Promise<ResolvedCompletion | null>
  >;
  upsertResolvedCompletion: jest.Mock<
    (runId: string, key: string, completion: ResolvedCompletion) => Promise<void>
  >;
}

function makeLifecycleService(
  resolvedCompletions: Map<string, ResolvedCompletion> = new Map(),
): MockLifecycleService {
  return {
    getResolvedCompletion: mockFn<
      (runId: string, key: string) => Promise<ResolvedCompletion | null>
    >().mockImplementation(async (_runId, key) => resolvedCompletions.get(key) ?? null),
    upsertResolvedCompletion:
      mockFn<
        (runId: string, key: string, completion: ResolvedCompletion) => Promise<void>
      >().mockResolvedValue(undefined),
  };
}

function wireMocks(manager: MockManager, lifecycleService: MockLifecycleService): void {
  const MockManagerClass = core.RunbookStateManager as unknown as jest.Mock<
    () => RunbookStateManagerType
  >;
  const MockLifecycle = core.ExecutionLifecycleService as unknown as jest.Mock<
    () => ExecutionLifecycleServiceType
  >;
  const MockActor = core.RunbookActorService as unknown as jest.Mock<() => RunbookActorServiceType>;
  const MockSession = core.SessionService as unknown as jest.Mock<() => SessionServiceType>;

  MockManagerClass.mockImplementation(() => manager as unknown as RunbookStateManagerType);
  MockLifecycle.mockImplementation(
    () => lifecycleService as unknown as ExecutionLifecycleServiceType,
  );
  MockActor.mockImplementation(
    () =>
      ({
        sendAndSync: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(null),
      }) as unknown as RunbookActorServiceType,
  );
  MockSession.mockImplementation(
    () =>
      ({
        popRunbook: mockFn<() => Promise<string | null>>().mockResolvedValue(null),
        releaseRunbook: mockFn<() => Promise<unknown>>().mockResolvedValue({
          status: 'released',
        }),
      }) as unknown as SessionServiceType,
  );
}

beforeEach(() => {
  jest.resetAllMocks();
  // Re-establish default mock implementations
  jest
    .mocked(core.buildCompletionKey)
    .mockImplementation(
      (frameKey, entry, substepId) => `${String(frameKey)}|${String(entry)}|${substepId ?? ''}`,
    );
  jest.mocked(core.buildResolvedCompletion).mockImplementation((fields) => ({
    ...fields,
    completedAt: fields.completedAt ?? '2026-02-27T10:00:00.000Z',
  }));
  jest.mocked(core.deriveActiveFrame).mockImplementation((state) => ({
    frameKey: (state.activeFrameKey ?? `${state.step}|`) as FrameKey,
    step: state.step,
    iteration: undefined,
  }));
  jest
    .mocked(core.findSubstepState)
    .mockImplementation((substepStates, substepId, frameKey) =>
      substepStates.find((ss) => ss.id === substepId && ss.frameKey === frameKey),
    );
  jest.mocked(core.upsertSubstepState).mockImplementation(upsertSubstepStateForTest);
  jest.mocked(getRunbookFromState).mockReturnValue([
    {
      kind: 'base',
      name: '1',
      description: 'Test step',
      transitions: {
        pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
        fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
      },
    },
  ]);
  jest
    .mocked(createBridgedEmitter)
    .mockReturnValue({ emit: jest.fn() } as unknown as ReturnType<typeof createBridgedEmitter>);
  const defaultDrainResult: Awaited<ReturnType<typeof drainResolvedCompletions>> = {
    unresolved: 0,
    status: 'continue',
    applied: 1,
    state: makeState(PARENT_RUN_ID),
  };
  jest.mocked(drainResolvedCompletions).mockResolvedValue(defaultDrainResult);
  jest.mocked(runExecutionLoop).mockResolvedValue('waiting');
  jest.mocked(createPassTransitionConfig).mockReturnValue({
    policy: 'pass',
    computeActionResult: jest.fn(),
  } as unknown as ReturnType<typeof createPassTransitionConfig>);
  jest.mocked(createFailTransitionConfig).mockReturnValue({
    policy: 'fail',
    computeActionResult: jest.fn(),
  } as unknown as ReturnType<typeof createFailTransitionConfig>);
});

describe('handleParentCompletion', () => {
  it('returns not-applicable when child has no delegation linkage', async () => {
    const childState = makeState(CHILD_RUN_ID);
    const output = makeOutput();

    const result = await handleParentCompletion(childState, 'pass', '/test', output);

    expect(result).toBe('not-applicable');
  });

  it('acquires delegation lock on parent run ID', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState(CHILD_RUN_ID, { parentLinkage: delegation });
    const parentState = makeState(PARENT_RUN_ID, {
      substepStates: [{ id: '1', frameKey: brandFrameKeyForTest('1'), status: 'pending' }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    await handleParentCompletion(childState, 'pass', '/test', output);

    expect(lock.acquire).toHaveBeenCalledWith(PARENT_RUN_ID);
    expect(lock.release).toHaveBeenCalledWith(PARENT_RUN_ID);
  });

  it('returns not-applicable when parent no longer exists', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState(CHILD_RUN_ID, { parentLinkage: delegation });

    const states = new Map([[PARENT_RUN_ID, null]]);
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
    const childState = makeState(CHILD_RUN_ID, {
      parentLinkage: {
        kind: 'inline' as const,
        parentRunId: PARENT_RUN_ID,
        parentStepId: '1',
        parentStep: '1',
        parentFrameKey: brandFrameKeyForTest('1'),
        parentEntry: 1,
      },
    });
    const parentState = makeState(PARENT_RUN_ID, {
      step: '1',
      activeEntry: 1,
      activeFrameKey: brandFrameKeyForTest('1'),
      substepStates: [
        {
          id: '1',
          frameKey: brandFrameKeyForTest('1'),
          status: 'pending',
          delegation: {
            tokenHash: brandDelegationTokenHashForTest(`sha256:${'b'.repeat(64)}`),
            childRunbookPath: 'old-child.md',
            childRunbookRef: { source: 'project', path: 'old-child.md' },
            contextSnapshot: { vars: brandEffectiveVarsForTest(), ancestors: [] },
            childRunId: OLD_CHILD_RUN_ID,
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

    jest.mocked(drainResolvedCompletions).mockResolvedValue({
      unresolved: 0,
      status: 'continue',
      applied: 0,
      state: parentState,
    });

    const result = await handleParentCompletion(childState, 'pass', '/test', output);

    // Inline child should NOT be blocked by the cancelled delegation
    expect(result).not.toBe('not-applicable');
    expect(lifecycleService.upsertResolvedCompletion).toHaveBeenCalledWith(
      PARENT_RUN_ID,
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
    const childState = makeState(CHILD_RUN_ID, { parentLinkage: delegation });
    const parentState = makeState(PARENT_RUN_ID, {
      substepStates: [
        {
          id: '1',
          frameKey: brandFrameKeyForTest('1'),
          status: 'pending',
          delegation: {
            tokenHash: brandDelegationTokenHashForTest(`sha256:${'a'.repeat(64)}`),
            childRunbookPath: 'child.md',
            childRunbookRef: { source: 'project', path: 'child.md' },
            contextSnapshot: { vars: brandEffectiveVarsForTest(), ancestors: [] },
            childRunId: CHILD_RUN_ID,
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
    const childState = makeState(CHILD_RUN_ID, { parentLinkage: delegation });
    const parentState = makeState(PARENT_RUN_ID, {
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

    jest.mocked(drainResolvedCompletions).mockResolvedValue({
      unresolved: 0,
      status: 'continue',
      applied: 0,
      state: parentState,
    });

    await handleParentCompletion(childState, 'pass', '/test', output);

    expect(lifecycleService.upsertResolvedCompletion).toHaveBeenCalledWith(
      PARENT_RUN_ID,
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
    const childState = makeState(CHILD_RUN_ID, { parentLinkage: delegation });
    const parentState = makeState(PARENT_RUN_ID, {
      substepStates: [{ id: '1', frameKey: brandFrameKeyForTest('1'), status: 'pending' }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    jest.mocked(drainResolvedCompletions).mockResolvedValue({
      unresolved: 0,
      status: 'continue',
      applied: 1,
      state: parentState,
    });

    await handleParentCompletion(childState, 'pass', '/test', output);

    expect(drainResolvedCompletions).toHaveBeenCalledWith(
      expect.objectContaining({
        runbookId: PARENT_RUN_ID,
        currentState: parentState,
      }),
    );
  });

  it('runs execution loop when completions were applied', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState(CHILD_RUN_ID, { parentLinkage: delegation });
    const parentState = makeState(PARENT_RUN_ID, {
      substepStates: [{ id: '1', frameKey: brandFrameKeyForTest('1'), status: 'pending' }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    jest.mocked(drainResolvedCompletions).mockResolvedValue({
      unresolved: 0,
      status: 'continue',
      applied: 1,
      state: parentState,
    });

    await handleParentCompletion(childState, 'pass', '/test', output);

    expect(runExecutionLoop).toHaveBeenCalledWith(
      manager as unknown as RunbookStateManagerType,
      PARENT_RUN_ID,
      expect.any(Array),
      '/test',
      false,
      expect.any(Object),
      { terminalReleaseMode: 'release-runbook' },
    );
  });

  it('returns stopped when drain results in stopped status', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState(CHILD_RUN_ID, { parentLinkage: delegation });
    const parentState = makeState(PARENT_RUN_ID, {
      substepStates: [{ id: '1', frameKey: brandFrameKeyForTest('1'), status: 'pending' }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    jest.mocked(drainResolvedCompletions).mockResolvedValue({
      unresolved: 0,
      status: 'stopped',
      applied: 1,
    });

    const result = await handleParentCompletion(childState, 'fail', '/test', output);

    expect(result).toBe('stopped');
  });

  it('cascades to grandparent when parent completes', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState(CHILD_RUN_ID, { parentLinkage: delegation });
    const grandparentDelegation = makeDelegationLinkage({
      parentRunId: GRANDPARENT_RUN_ID,
      parentStepId: '2',
    });
    const parentState = makeState(PARENT_RUN_ID, {
      substepStates: [{ id: '1', frameKey: brandFrameKeyForTest('1'), status: 'pending' }],
      parentLinkage: grandparentDelegation,
    });
    const grandparentState = makeState(GRANDPARENT_RUN_ID, {
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

    jest.mocked(drainResolvedCompletions).mockResolvedValue({
      unresolved: 0,
      status: 'done',
      applied: 1,
    });

    await handleParentCompletion(childState, 'pass', '/test', output);

    // Should cascade - second acquire should be on grandparent
    expect(lock.acquire).toHaveBeenCalledWith(PARENT_RUN_ID);
    expect(lock.acquire).toHaveBeenCalledWith(GRANDPARENT_RUN_ID);
  });

  it('respects maximum recursion depth', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState(CHILD_RUN_ID, { parentLinkage: delegation });
    const output = makeOutput();

    // Call with depth already at limit
    const result = await handleParentCompletion(childState, 'pass', '/test', output, 32);

    expect(result).toBe('handled');
    // Should not even acquire lock
    const MockLock = core.DelegationLock as jest.MockedClass<typeof core.DelegationLock>;
    expect(MockLock).not.toHaveBeenCalled();
  });

  it('passes delegation-specific releaseRunbook:false policy to drain', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState(CHILD_RUN_ID, { parentLinkage: delegation });
    const parentState = makeState(PARENT_RUN_ID, {
      substepStates: [{ id: '1', frameKey: brandFrameKeyForTest('1'), status: 'pending' }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    jest.mocked(drainResolvedCompletions).mockResolvedValue({
      unresolved: 0,
      status: 'continue',
      applied: 0,
      state: parentState,
    });

    await handleParentCompletion(childState, 'pass', '/test', output);

    expect(drainResolvedCompletions).toHaveBeenCalledWith(
      expect.objectContaining({
        transitionPolicy: {
          onComplete: { releaseRunbook: false },
          onStopped: { releaseRunbook: false },
        },
      }),
    );
  });

  it('explicitly releases parent runbook when drain returns done', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState(CHILD_RUN_ID, { parentLinkage: delegation });
    const parentState = makeState(PARENT_RUN_ID, {
      substepStates: [{ id: '1', frameKey: brandFrameKeyForTest('1'), status: 'pending' }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    jest.mocked(drainResolvedCompletions).mockResolvedValue({
      unresolved: 0,
      status: 'done',
      applied: 1,
    });

    await handleParentCompletion(childState, 'pass', '/test', output);

    const MockSession = core.SessionService as jest.MockedClass<typeof core.SessionService>;
    const sessionInstance = MockSession.mock.results[0]?.value as {
      releaseRunbook: jest.Mock<(runbookId: string) => Promise<unknown>>;
    };
    expect(sessionInstance.releaseRunbook).toHaveBeenCalledWith(PARENT_RUN_ID);
  });

  it('explicitly releases parent runbook when drain returns stopped', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState(CHILD_RUN_ID, { parentLinkage: delegation });
    const parentState = makeState(PARENT_RUN_ID, {
      substepStates: [{ id: '1', frameKey: brandFrameKeyForTest('1'), status: 'pending' }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    jest.mocked(drainResolvedCompletions).mockResolvedValue({
      unresolved: 0,
      status: 'stopped',
      applied: 1,
    });

    await handleParentCompletion(childState, 'fail', '/test', output);

    const MockSession = core.SessionService as jest.MockedClass<typeof core.SessionService>;
    const sessionInstance = MockSession.mock.results[0]?.value as {
      releaseRunbook: jest.Mock<(runbookId: string) => Promise<unknown>>;
    };
    expect(sessionInstance.releaseRunbook).toHaveBeenCalledWith(PARENT_RUN_ID);
  });

  it('uses fail transition config when result is fail', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState(CHILD_RUN_ID, { parentLinkage: delegation });
    const parentState = makeState(PARENT_RUN_ID, {
      substepStates: [{ id: '1', frameKey: brandFrameKeyForTest('1'), status: 'pending' }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    jest.mocked(drainResolvedCompletions).mockResolvedValue({
      unresolved: 0,
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
    const childState = makeState(CHILD_RUN_ID, { parentLinkage: delegation });
    const parentState = makeState(PARENT_RUN_ID, {
      substepStates: [{ id: '1', frameKey: brandFrameKeyForTest('1'), status: 'pending' }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    jest.mocked(drainResolvedCompletions).mockResolvedValue({
      unresolved: 0,
      status: 'continue',
      applied: 0,
      state: parentState,
    });

    await handleParentCompletion(childState, 'pass', '/test', output);

    expect(output.flush).toHaveBeenCalled();
  });

  it('passes parentFrameKey as frameKeyOverride to drain', async () => {
    const delegation = makeDelegationLinkage({ parentFrameKey: brandFrameKeyForTest('1', 3) });
    const childState = makeState(CHILD_RUN_ID, { parentLinkage: delegation });
    const parentState = makeState(PARENT_RUN_ID, {
      substepStates: [{ id: '1', frameKey: brandFrameKeyForTest('1', 3), status: 'pending' }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    jest.mocked(drainResolvedCompletions).mockResolvedValue({
      unresolved: 0,
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
    const childState = makeState(CHILD_RUN_ID, { parentLinkage: delegation });
    const parentState = makeState(PARENT_RUN_ID, {
      substepStates: [{ id: '1', frameKey: brandFrameKeyForTest('1'), status: 'pending' }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    jest.mocked(drainResolvedCompletions).mockResolvedValue({
      unresolved: 0,
      status: 'continue',
      applied: 0,
      state: parentState,
    });

    await handleParentCompletion(childState, 'pass', '/test', output);

    const drainCall = jest.mocked(drainResolvedCompletions).mock.calls[0]?.[0];
    expect(drainCall.frameKeyOverride).toBeUndefined();
  });

  it('forwards child finalVars to parent actor via SET_VARIABLES before drain', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState(CHILD_RUN_ID, {
      parentLinkage: delegation,
      finalVars: { PlanPath: '/work/plan.json', version: '2.1' },
    });
    const parentState = makeState(PARENT_RUN_ID, {
      substepStates: [{ id: '1', frameKey: brandFrameKeyForTest('1'), status: 'pending' }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    jest.mocked(drainResolvedCompletions).mockResolvedValue({
      unresolved: 0,
      status: 'continue',
      applied: 0,
      state: parentState,
    });

    await handleParentCompletion(childState, 'pass', '/test', output);

    const MockActor = core.RunbookActorService as jest.MockedClass<typeof core.RunbookActorService>;
    const actorInstance = MockActor.mock.results[0]?.value as {
      sendAndSync: jest.Mock<(...args: unknown[]) => Promise<unknown>>;
    };
    expect(actorInstance.sendAndSync).toHaveBeenCalledWith(PARENT_RUN_ID, expect.any(Array), {
      type: 'SET_VARIABLES',
      vars: { PlanPath: '/work/plan.json', version: '2.1' },
    });
  });

  it('surfaces a warning to output when SET_VARIABLES fails', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState(CHILD_RUN_ID, {
      parentLinkage: delegation,
      finalVars: { PlanPath: '/work/plan.json' },
    });
    const parentState = makeState(PARENT_RUN_ID, {
      substepStates: [{ id: '1', frameKey: brandFrameKeyForTest('1'), status: 'pending' }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const _lifecycleService = makeLifecycleService();
    const output = makeOutput();

    // Override the actor mock so sendAndSync throws for this test
    const MockActor = core.RunbookActorService as unknown as jest.Mock<
      () => RunbookActorServiceType
    >;
    MockActor.mockImplementation(
      () =>
        ({
          sendAndSync: mockFn<(...args: unknown[]) => Promise<unknown>>().mockRejectedValue(
            new Error('machine rejected event'),
          ),
        }) as unknown as RunbookActorServiceType,
    );

    (
      core.RunbookStateManager as unknown as jest.Mock<() => RunbookStateManagerType>
    ).mockImplementation(() => manager as unknown as RunbookStateManagerType);
    (
      core.ExecutionLifecycleService as unknown as jest.Mock<() => ExecutionLifecycleServiceType>
    ).mockImplementation(() => makeLifecycleService() as unknown as ExecutionLifecycleServiceType);
    (core.SessionService as unknown as jest.Mock<() => SessionServiceType>).mockImplementation(
      () =>
        ({
          popRunbook: mockFn<() => Promise<string | null>>().mockResolvedValue(null),
          releaseRunbook: mockFn<() => Promise<unknown>>().mockResolvedValue({
            status: 'released',
          }),
        }) as unknown as SessionServiceType,
    );

    jest.mocked(drainResolvedCompletions).mockResolvedValue({
      unresolved: 0,
      status: 'continue',
      applied: 0,
      state: parentState,
    });

    await handleParentCompletion(childState, 'pass', '/test', output);

    expect(output.warning).toHaveBeenCalledWith(expect.stringContaining('SET_VARIABLES'));
  });

  it('does not call sendAndSync when child has no finalVars', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState(CHILD_RUN_ID, { parentLinkage: delegation });
    const parentState = makeState(PARENT_RUN_ID, {
      substepStates: [{ id: '1', frameKey: brandFrameKeyForTest('1'), status: 'pending' }],
    });

    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    jest.mocked(drainResolvedCompletions).mockResolvedValue({
      unresolved: 0,
      status: 'continue',
      applied: 0,
      state: parentState,
    });

    await handleParentCompletion(childState, 'pass', '/test', output);

    const MockActor = core.RunbookActorService as jest.MockedClass<typeof core.RunbookActorService>;
    const actorInstance = MockActor.mock.results[0]?.value as {
      sendAndSync: jest.Mock<(...args: unknown[]) => Promise<unknown>>;
    };
    expect(actorInstance.sendAndSync).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ type: 'SET_VARIABLES' }),
    );
  });
});

describe('inline linkage path', () => {
  it('extractParentLinkage returns inline linkage from state', () => {
    const state = makeState(CHILD_RUN_ID, {
      parentLinkage: {
        kind: 'inline' as const,
        parentRunId: PARENT_RUN_ID,
        parentStepId: '1',
        parentStep: '1',
        parentFrameKey: brandFrameKeyForTest('1'),
        parentEntry: 1,
      },
    });
    const linkage = extractParentLinkage(state);
    expect(linkage).toBeDefined();
    expect(linkage!.parentRunId).toBe(PARENT_RUN_ID);
  });

  it('agentId is inline for inline children', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      parentLinkage: {
        kind: 'inline' as const,
        parentRunId: PARENT_RUN_ID,
        parentStepId: '1',
        parentStep: '1',
        parentFrameKey: brandFrameKeyForTest('1'),
        parentEntry: 1,
      },
    });
    const parentState = makeState(PARENT_RUN_ID, {
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

    jest.mocked(drainResolvedCompletions).mockResolvedValue({
      unresolved: 0,
      status: 'continue',
      applied: 0,
      state: parentState,
    });

    await handleParentCompletion(childState, 'pass', '/test', output);

    expect(lifecycleService.upsertResolvedCompletion).toHaveBeenCalledWith(
      PARENT_RUN_ID,
      expect.any(String),
      expect.objectContaining({
        agentId: 'inline',
        result: 'pass',
        targetSubstep: '1',
      }),
    );
  });
});
