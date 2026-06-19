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
  Frame,
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

const mockCreateCliRunbookActorService = mockFn<() => RunbookActorServiceType>();

// Mock @rundown-org/core
jest.unstable_mockModule('@rundown-org/core', () => ({
  RunbookStateManager: jest.fn(),
  RunbookActorService: jest.fn(),
  RunbookCompletionService: jest.fn().mockImplementation(() => ({
    recordChildCompletion: mockFn<() => Promise<string>>().mockResolvedValue('recorded'),
  })),
  SessionService: jest.fn(),
  ExecutionLifecycleService: jest.fn(),
  DelegationLock: jest.fn(),
  // Used by buildTransitionContext in transitions.ts; mocks satisfy the ESM
  // named-import link check (not exercised by these tests).
  resolveCommandTarget: jest.fn(),
  resolveTransitionTarget: jest.fn(),
  exactFrame: mockFn<
    (frameKey: FrameKey, entry: number) => { kind: 'exact'; frameKey: FrameKey; entry: number }
  >().mockImplementation((frameKey, entry) => ({ kind: 'exact', frameKey, entry })),
  inactiveFrame: mockFn<
    (frameKey: FrameKey) => { kind: 'inactive'; frameKey: FrameKey }
  >().mockImplementation((frameKey) => ({ kind: 'inactive', frameKey })),
  buildCompletionKey: mockFn<(frame: Frame, substep?: string) => string>().mockImplementation(
    (frame, substepId) => {
      const entry = frame.kind === 'inactive' ? 0 : frame.entry;
      return `${String(frame.frameKey)}|${String(entry)}|${substepId ?? ''}`;
    },
  ),
  buildResolvedCompletion: mockFn<
    (
      fields: Omit<ResolvedCompletion, 'completedAt' | 'targetFrameKey' | 'targetEntry'> & {
        targetFrame: Frame;
        completedAt?: string;
      },
    ) => ResolvedCompletion
  >().mockImplementation((fields) => ({
    ...fields,
    targetFrameKey: fields.targetFrame.frameKey,
    targetEntry: fields.targetFrame.kind === 'inactive' ? 0 : fields.targetFrame.entry,
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
  runbooksDir: jest.fn((cwd: string) => `${cwd}/.rundown/runbooks`),
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

// Mock actor-service factory to keep this unit test on structural service doubles.
jest.unstable_mockModule('../../src/helpers/actor-service-factory', () => ({
  createCliRunbookActorService: mockCreateCliRunbookActorService,
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
const { createCliRunbookActorService } = await import('../../src/helpers/actor-service-factory.js');
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
}

function makeActorDouble(
  sendAndSync: jest.Mock<(...args: unknown[]) => Promise<unknown>> = mockFn<
    (...args: unknown[]) => Promise<unknown>
  >().mockResolvedValue(null),
): RunbookActorServiceType {
  return { sendAndSync } as unknown as RunbookActorServiceType;
}

function makeLifecycleService(
  resolvedCompletions: Map<string, ResolvedCompletion> = new Map(),
): MockLifecycleService {
  return {
    getResolvedCompletion: mockFn<
      (runId: string, key: string) => Promise<ResolvedCompletion | null>
    >().mockImplementation(async (_runId, key) => resolvedCompletions.get(key) ?? null),
  };
}

/**
 * Mock for the core `RunbookCompletionService`. Per project convention
 * (CLAUDE.md "Mock injected core services structurally"), this is a plain
 * structural stub: tests assert on call arguments to `recordChildCompletion`
 * and vary the return value to cover behavioral branches. The real recording
 * logic — parent lookup, cancellation detection, lifecycle upsert — is owned
 * by core and tested in `packages/core/__tests__/runbook/completion-service.test.ts`.
 */
type RecordChildCompletionMock = jest.Mock<(...args: unknown[]) => Promise<string>>;

function wireMocks(
  manager: MockManager,
  lifecycleService: MockLifecycleService,
  options: {
    /** Stub return value for `recordChildCompletion`; default `'recorded'`. */
    readonly recordChildCompletionResult?:
      | 'recorded'
      | 'duplicate'
      | 'not-applicable'
      | 'cancelled';
  } = {},
): RecordChildCompletionMock {
  const MockManagerClass = core.RunbookStateManager as unknown as jest.Mock<
    () => RunbookStateManagerType
  >;
  const MockLifecycle = core.ExecutionLifecycleService as unknown as jest.Mock<
    () => ExecutionLifecycleServiceType
  >;
  const MockSession = core.SessionService as unknown as jest.Mock<() => SessionServiceType>;
  const MockCompletion = core.RunbookCompletionService as unknown as jest.Mock<
    () => { recordChildCompletion: RecordChildCompletionMock }
  >;

  MockManagerClass.mockImplementation(() => manager as unknown as RunbookStateManagerType);
  MockLifecycle.mockImplementation(
    () => lifecycleService as unknown as ExecutionLifecycleServiceType,
  );
  jest.mocked(createCliRunbookActorService).mockImplementation(() => makeActorDouble());

  const recordChildCompletion = mockFn<(...args: unknown[]) => Promise<string>>().mockResolvedValue(
    options.recordChildCompletionResult ?? 'recorded',
  );
  MockCompletion.mockImplementation(() => ({ recordChildCompletion }));
  MockSession.mockImplementation(
    () =>
      ({
        popRunbook: mockFn<() => Promise<string | null>>().mockResolvedValue(null),
        releaseRunbook: mockFn<() => Promise<unknown>>().mockResolvedValue({
          status: 'released',
        }),
      }) as unknown as SessionServiceType,
  );

  return recordChildCompletion;
}

beforeEach(() => {
  jest.resetAllMocks();
  mockCreateCliRunbookActorService.mockImplementation(() => makeActorDouble());
  // Re-establish default mock implementations
  jest
    .mocked(core.exactFrame)
    .mockImplementation((frameKey, entry) => ({ kind: 'exact', frameKey, entry }));
  jest
    .mocked(core.inactiveFrame)
    .mockImplementation((frameKey) => ({ kind: 'inactive', frameKey }));
  jest.mocked(core.buildCompletionKey).mockImplementation((frame, substepId) => {
    const entry = frame.kind === 'inactive' ? 0 : frame.entry;
    return `${String(frame.frameKey)}|${String(entry)}|${substepId ?? ''}`;
  });
  jest.mocked(core.buildResolvedCompletion).mockImplementation((fields) => ({
    ...fields,
    targetFrameKey: fields.targetFrame.frameKey,
    targetEntry: fields.targetFrame.kind === 'inactive' ? 0 : fields.targetFrame.entry,
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

  it('delegates child completion recording to core service', async () => {
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

    const recordChildCompletion = wireMocks(manager, lifecycleService);

    await handleParentCompletion(childState, 'pass', '/test', output);

    expect(core.RunbookCompletionService).toHaveBeenCalled();
    // CLI layer delegates child-completion recording wholesale to the core
    // service. The contract is the call args, not the lifecycle row write
    // (that's an implementation detail tested in core).
    expect(recordChildCompletion).toHaveBeenCalledWith({
      childState,
      result: 'pass',
    });
  });

  it('returns not-applicable when parent no longer exists', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState(CHILD_RUN_ID, { parentLinkage: delegation });

    const states = new Map([[PARENT_RUN_ID, null]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    wireMocks(manager, lifecycleService);

    const result = await handleParentCompletion(childState, 'pass', '/test', output);

    expect(result).toBe('not-applicable');
    expect(core.RunbookCompletionService).toHaveBeenCalled();
  });

  it('does not block inline child when substep has cancelled delegation', async () => {
    // Inline child: parentLinkage.kind === 'inline'. The core service is
    // expected to record (return 'recorded'), not return 'cancelled' — the
    // CLI layer simply forwards the call. Stub the core service to return
    // 'recorded' so the CLI proceeds with drain.
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

    const recordChildCompletion = wireMocks(manager, lifecycleService);

    jest.mocked(drainResolvedCompletions).mockResolvedValue({
      unresolved: 0,
      status: 'continue',
      applied: 0,
      state: parentState,
    });

    const result = await handleParentCompletion(childState, 'pass', '/test', output);

    // Inline child should NOT be blocked by the cancelled delegation — the
    // core service is invoked with the inline-linkage child state, and the
    // CLI advances to drain (not the 'cancelled' early-return path).
    expect(result).not.toBe('not-applicable');
    expect(recordChildCompletion).toHaveBeenCalledWith({
      childState,
      result: 'pass',
    });
    expect(drainResolvedCompletions).toHaveBeenCalled();
  });

  it('skips propagation when delegation was cancelled', async () => {
    // The cancellation detection lives in the core completion service; the
    // CLI's contract is "if the core service says 'cancelled', short-circuit
    // to 'handled' and do not drain". Drive the stub to return 'cancelled'.
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

    wireMocks(manager, lifecycleService, { recordChildCompletionResult: 'cancelled' });

    const result = await handleParentCompletion(childState, 'pass', '/test', output);

    expect(result).toBe('handled');
    // Drain must NOT be called when the core service reports 'cancelled'.
    expect(drainResolvedCompletions).not.toHaveBeenCalled();
  });

  it('records resolved completion on parent via core completion service', async () => {
    // Contract at the CLI seam: the helper forwards childState + result to
    // the core service. The lifecycle row write itself is an implementation
    // detail of core and is covered in completion-service.test.ts.
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

    const recordChildCompletion = wireMocks(manager, lifecycleService);

    jest.mocked(drainResolvedCompletions).mockResolvedValue({
      unresolved: 0,
      status: 'continue',
      applied: 0,
      state: parentState,
    });

    await handleParentCompletion(childState, 'pass', '/test', output);

    expect(recordChildCompletion).toHaveBeenCalledWith({
      childState,
      result: 'pass',
    });
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
      expect.objectContaining({ terminalReleaseMode: 'release-runbook' }),
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

  it('reports a terminal parent upward exactly one level (no recursion into grandparent)', async () => {
    // child → parent (terminal) → grandparent. Draining drives the parent to a
    // terminal `done`; the helper records ONE outcome upward onto the
    // grandparent via `reportTerminalParentUpward` but does NOT drain or run
    // the execution loop for the grandparent (single-level propagation, Plan 4).
    const delegation = makeDelegationLinkage();
    const childState = makeState(CHILD_RUN_ID, { parentLinkage: delegation });
    const grandparentDelegation = makeDelegationLinkage({
      parentRunId: GRANDPARENT_RUN_ID,
      parentStepId: '2',
    });
    // The parent itself has a parentLinkage (the grandparent), so reaching a
    // terminal state triggers the single upward report.
    const parentState = makeState(PARENT_RUN_ID, {
      substepStates: [{ id: '1', frameKey: brandFrameKeyForTest('1'), status: 'pending' }],
      parentLinkage: grandparentDelegation,
    });
    const grandparentState = makeState(GRANDPARENT_RUN_ID, {
      step: '2',
      substepStates: [{ id: '2', frameKey: brandFrameKeyForTest('1'), status: 'pending' }],
    });

    const states = new Map([
      [parentState.id, parentState],
      [grandparentState.id, grandparentState],
    ]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();

    const recordChildCompletion = wireMocks(manager, lifecycleService);

    jest.mocked(drainResolvedCompletions).mockResolvedValue({
      unresolved: 0,
      status: 'done',
      applied: 1,
    });

    const result = await handleParentCompletion(childState, 'pass', '/test', output);

    expect(result).toBe('handled');

    // The shared core completion service is constructed once; the helper calls
    // recordChildCompletion twice through it: once for child → parent, and once
    // for the single upward report parent → grandparent.
    expect(core.RunbookCompletionService).toHaveBeenCalledTimes(1);
    expect(recordChildCompletion).toHaveBeenCalledTimes(2);
    // First call: the child's completion onto the parent.
    expect(recordChildCompletion).toHaveBeenNthCalledWith(1, {
      childState,
      result: 'pass',
    });
    // Second call: the terminal parent reported ONE level upward to the
    // grandparent. `childState` is the freshly reloaded parent and the result
    // matches the parent's terminal outcome (`done` → 'pass').
    expect(recordChildCompletion).toHaveBeenNthCalledWith(2, {
      childState: parentState,
      result: 'pass',
    });

    // Single-level invariant: the grandparent is NOT drained or looped — the
    // drain ran exactly once (for the immediate parent) and the execution loop
    // was never invoked for a second level.
    expect(drainResolvedCompletions).toHaveBeenCalledTimes(1);
    expect(drainResolvedCompletions).toHaveBeenCalledWith(
      expect.objectContaining({ runbookId: PARENT_RUN_ID }),
    );
    expect(runExecutionLoop).not.toHaveBeenCalled();
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

  it('passes parentFrameKey as frameOverride to drain', async () => {
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
        frameOverride: { kind: 'exact', frameKey: '1|3', entry: delegation.parentEntry },
      }),
    );
  });

  it('passes child finalVars through to the core recordChildCompletion call', async () => {
    // The CLI helper forwards childState (carrying finalVars) to the core
    // service unchanged. The core service is responsible for materializing
    // finalVars onto the persisted ResolvedCompletion row — exercised in
    // completion-service.test.ts. At the CLI seam we only verify the
    // childState argument carries the finalVars the child published.
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

    const recordChildCompletion = wireMocks(manager, lifecycleService);

    jest.mocked(drainResolvedCompletions).mockResolvedValue({
      unresolved: 0,
      status: 'continue',
      applied: 0,
      state: parentState,
    });

    await handleParentCompletion(childState, 'pass', '/test', output);

    expect(recordChildCompletion).toHaveBeenCalledWith({
      childState: expect.objectContaining({
        finalVars: { PlanPath: '/work/plan.json', version: '2.1' },
      }),
      result: 'pass',
    });
  });

  it('does not send SET_VARIABLES when child finalVars are present', async () => {
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

    wireMocks(manager, _lifecycleService);

    jest.mocked(drainResolvedCompletions).mockResolvedValue({
      unresolved: 0,
      status: 'continue',
      applied: 0,
      state: parentState,
    });

    await handleParentCompletion(childState, 'pass', '/test', output);

    const actorInstance = mockCreateCliRunbookActorService.mock.results[0]?.value as {
      sendAndSync: jest.Mock<(...args: unknown[]) => Promise<unknown>>;
    };
    expect(actorInstance.sendAndSync).not.toHaveBeenCalledWith(
      PARENT_RUN_ID,
      expect.any(Array),
      expect.objectContaining({ type: 'SET_VARIABLES' }),
    );
    expect(output.warning).not.toHaveBeenCalled();
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

    const actorInstance = mockCreateCliRunbookActorService.mock.results[0]?.value as {
      sendAndSync: jest.Mock<(...args: unknown[]) => Promise<unknown>>;
    };
    expect(actorInstance.sendAndSync).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ type: 'SET_VARIABLES' }),
    );
  });
});

describe('MockLifecycleService factory', () => {
  it('makeLifecycleService does not expose upsertResolvedCompletion', () => {
    // After the PR removed upsertResolvedCompletion from MockLifecycleService, this
    // regression test verifies the factory no longer creates the method. If it did,
    // it would silently absorb lifecycle writes that should be owned by core instead.
    const service = makeLifecycleService();
    expect(
      (service as unknown as Record<string, unknown>).upsertResolvedCompletion,
    ).toBeUndefined();
  });

  it('makeLifecycleService getResolvedCompletion returns null when no completions seeded', async () => {
    const service = makeLifecycleService(); // Empty map
    const result = await service.getResolvedCompletion('any-run-id', 'any-key');
    expect(result).toBeNull();
  });

  it('makeLifecycleService getResolvedCompletion returns the seeded completion for matching key', async () => {
    const completion = { result: 'pass' } as unknown as ResolvedCompletion;
    const service = makeLifecycleService(new Map([['my-key', completion]]));
    const result = await service.getResolvedCompletion('ignored-run-id', 'my-key');
    expect(result).toBe(completion);
  });

  it('makeLifecycleService getResolvedCompletion returns null for unknown key when map has entries', async () => {
    const completion = { result: 'pass' } as unknown as ResolvedCompletion;
    const service = makeLifecycleService(new Map([['known-key', completion]]));
    const result = await service.getResolvedCompletion('run-id', 'unknown-key');
    expect(result).toBeNull();
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

  it('inline child state flows through to the core service unchanged', async () => {
    // The agentId='inline' mapping itself lives in core and is exercised in
    // completion-service.test.ts. At the CLI seam we verify the helper
    // forwards the child carrying `parentLinkage.kind === 'inline'` to the
    // core service so the inline branch is taken there.
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

    const recordChildCompletion = wireMocks(manager, lifecycleService);

    jest.mocked(drainResolvedCompletions).mockResolvedValue({
      unresolved: 0,
      status: 'continue',
      applied: 0,
      state: parentState,
    });

    await handleParentCompletion(childState, 'pass', '/test', output);

    expect(recordChildCompletion).toHaveBeenCalledWith({
      childState: expect.objectContaining({
        parentLinkage: expect.objectContaining({ kind: 'inline' }),
      }),
      result: 'pass',
    });
  });
});
