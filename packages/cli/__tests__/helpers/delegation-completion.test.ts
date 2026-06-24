import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { mockErrorHelpers } from './mock-error-helpers.js';
import {
  brandDelegationTokenHashForTest,
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
  InlineLinkage,
  SubstepState,
  ResolvedCompletion,
  RunbookStateManager as RunbookStateManagerType,
  RunbookActorService as RunbookActorServiceType,
  SessionService as SessionServiceType,
  ExecutionLifecycleService as ExecutionLifecycleServiceType,
  DelegationLock as DelegationLockType,
} from '@rundown-org/core';
import type { OutputEmitter } from '../../src/services/output-emitter.js';

type SubstepStatePatch = Partial<Pick<SubstepState, 'status' | 'result' | 'delegation'>>;

const PARENT_RUN_ID = brandRunIdForTest('rd_11111111111111111111111111111111');
const CHILD_RUN_ID = brandRunIdForTest('rd_22222222222222222222222222222222');
const GRANDPARENT_RUN_ID = brandRunIdForTest('rd_33333333333333333333333333333333');

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

// Mock @rundown-org/core. The report-only helper (Plan 5) constructs only
// RunbookStateManager, ExecutionLifecycleService, and RunbookCompletionService;
// the remaining named exports satisfy the ESM link check for transitive imports.
// RunbookCollectionService is exported so tests can assert it is NEVER called.
jest.unstable_mockModule('@rundown-org/core', () => ({
  RunbookStateManager: jest.fn(),
  RunbookActorService: jest.fn(),
  RunbookCompletionService: jest.fn().mockImplementation(() => ({
    recordChildCompletion: mockFn<() => Promise<string>>().mockResolvedValue('recorded'),
  })),
  RunbookCollectionService: jest.fn(),
  SessionService: jest.fn(),
  ExecutionLifecycleService: jest.fn(),
  // advanceParentForInlineChild lazily constructs a bridged emitter; a no-op
  // stub satisfies the link check (these tests assert on drain/loop branches).
  ExecutionEventEmitter: jest.fn().mockImplementation(() => ({ subscribe: jest.fn() })),
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

// Mock execution service so tests can assert the report-only helper NEVER
// drains or runs the execution loop (collection moved behind `rd collect`).
jest.unstable_mockModule('../../src/services/execution', () => ({
  drainResolvedCompletions: jest.fn(),
  runExecutionLoop: jest.fn(),
}));

// Mock actor-service factory to keep this unit test on structural service doubles.
jest.unstable_mockModule('../../src/helpers/actor-service-factory', () => ({
  createCliRunbookActorService: mockCreateCliRunbookActorService,
}));

// advanceParentForInlineChild lazily imports these. Stub them so the inline
// path resolves steps, builds an emitter, and selects a transition config
// without touching the real parser/emitter — the drain/loop mocks above own
// the branch behaviour these tests pin.
jest.unstable_mockModule('../../src/helpers/runbook-loader', () => ({
  getRunbookFromState: jest.fn(),
}));
jest.unstable_mockModule('../../src/helpers/execution-emitter', () => ({
  createBridgedEmitter: jest.fn(),
}));
jest.unstable_mockModule('../../src/helpers/transitions', () => ({
  createPassTransitionConfig: jest.fn(),
  createFailTransitionConfig: jest.fn(),
}));

// Import after mocking
const core = await import('@rundown-org/core');
const { drainResolvedCompletions, runExecutionLoop } = await import(
  '../../src/services/execution.js'
);
const { createCliRunbookActorService } = await import('../../src/helpers/actor-service-factory.js');
const { getRunbookFromState } = await import('../../src/helpers/runbook-loader.js');
const { createBridgedEmitter } = await import('../../src/helpers/execution-emitter.js');
const { createPassTransitionConfig, createFailTransitionConfig } = await import(
  '../../src/helpers/transitions.js'
);
const { reportTerminalToDelegatingRun, advanceParentForInlineChild, extractParentLinkage } =
  await import('../../src/helpers/delegation-completion.js');

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

function makeInlineLinkage(overrides: Partial<InlineLinkage> = {}): InlineLinkage {
  return {
    kind: 'inline' as const,
    parentRunId: PARENT_RUN_ID,
    parentStepId: '1',
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
  jest.mocked(drainResolvedCompletions).mockResolvedValue({
    unresolved: 0,
    status: 'continue',
    applied: 0,
    state: makeState(PARENT_RUN_ID),
  });
  jest.mocked(runExecutionLoop).mockResolvedValue('waiting');
  // resetAllMocks() wipes the lazy-import stubs the inline path needs; restore
  // them each run so advanceParentForInlineChild resolves steps/emitter/config.
  // The values pass straight through to the mocked drain/loop, so structural
  // doubles cast through `never` keep the unit free of real parser/emitter wiring.
  jest.mocked(getRunbookFromState).mockReturnValue([{ id: '1', status: 'running' }] as never);
  jest.mocked(createBridgedEmitter).mockReturnValue({ subscribe: jest.fn() } as never);
  jest.mocked(createPassTransitionConfig).mockReturnValue({
    computeActionResult: () => true,
  } as never);
  jest.mocked(createFailTransitionConfig).mockReturnValue({
    computeActionResult: () => false,
  } as never);
});

describe('reportTerminalToDelegatingRun', () => {
  it('reports the child outcome onto the immediate delegating run and stops', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: delegation,
    });
    const parentState = makeState(PARENT_RUN_ID, {
      step: '1',
      substepStates: [{ id: '1', frameKey: brandFrameKeyForTest('1'), status: 'running' }],
      resolvedCompletions: {},
    });
    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();
    const recordChildCompletion = wireMocks(manager, lifecycleService);

    const result = await reportTerminalToDelegatingRun(childState, 'pass', '/test', output);

    // Report recorded exactly one outcome on the delegating run...
    expect(result).toBe('reported');
    expect(core.RunbookCompletionService).toHaveBeenCalledTimes(1);
    expect(recordChildCompletion).toHaveBeenCalledWith({ childState, result: 'pass' });
    // ...and NEVER collected: no collection service, no drain, no execution loop.
    expect(core.RunbookCollectionService).not.toHaveBeenCalled();
    expect(drainResolvedCompletions).not.toHaveBeenCalled();
    expect(runExecutionLoop).not.toHaveBeenCalled();
    // ...and did not advance the delegating run cursor.
    const freshParent = await manager.load(PARENT_RUN_ID);
    expect(freshParent?.step).toBe('1');
    expect(output.flush).toHaveBeenCalled();
  });

  it('returns not-applicable when the child has no parent linkage', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: undefined,
    });
    const manager = makeManager(new Map());
    const output = makeOutput();
    wireMocks(manager, makeLifecycleService());

    const result = await reportTerminalToDelegatingRun(childState, 'pass', '/test', output);

    expect(result).toBe('not-applicable');
    // The early linkage guard returns before constructing the completion service.
    expect(core.RunbookCompletionService).not.toHaveBeenCalled();
  });

  it('reports onto the immediate parent only and never touches an ancestor', async () => {
    // Defensive single-level contract test. RD-819 means a delegating run never
    // actually carries its own 'delegation' linkage, but we still pin that the
    // helper touches ONLY the immediate parent: no recurse, no collect, no write
    // to any ancestor. (The GRANDPARENT_RUN_ID state here is a synthetic guard.)
    const delegation = makeDelegationLinkage();
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: delegation,
    });
    const parentState = makeState(PARENT_RUN_ID, {
      parentLinkage: makeDelegationLinkage({
        parentRunId: GRANDPARENT_RUN_ID,
        parentStepId: '2',
      }),
      resolvedCompletions: {},
    });
    const grandparentState = makeState(GRANDPARENT_RUN_ID, { resolvedCompletions: {} });
    const states = new Map([
      [parentState.id, parentState],
      [grandparentState.id, grandparentState],
    ]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const output = makeOutput();
    const recordChildCompletion = wireMocks(manager, makeLifecycleService());

    const result = await reportTerminalToDelegatingRun(childState, 'pass', '/test', output);

    expect(result).toBe('reported');
    // Exactly one report — the immediate parent. No recursion, no collection.
    expect(recordChildCompletion).toHaveBeenCalledTimes(1);
    expect(core.RunbookCollectionService).not.toHaveBeenCalled();
    // Grandparent untouched: no outcome row written to it.
    const freshGrandparent = await manager.load(GRANDPARENT_RUN_ID);
    expect(Object.keys(freshGrandparent?.resolvedCompletions ?? {})).toHaveLength(0);
  });

  it('returns reported (not pending) when the slot was ordinarily cancelled', async () => {
    // recordChildCompletion returns 'cancelled' when the parent substep was
    // ordinarily cancelled. The child still closed and there was nothing to
    // report (no outcome row), so the helper returns 'reported' and never
    // collects — preserving the cancellation split (no fail outcome on cancel).
    const delegation = makeDelegationLinkage();
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: delegation,
    });
    const parentState = makeState(PARENT_RUN_ID, {
      substepStates: [{ id: '1', frameKey: brandFrameKeyForTest('1'), status: 'pending' }],
    });
    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const output = makeOutput();
    wireMocks(manager, makeLifecycleService(), { recordChildCompletionResult: 'cancelled' });

    const result = await reportTerminalToDelegatingRun(childState, 'pass', '/test', output);

    expect(result).toBe('reported');
    expect(core.RunbookCollectionService).not.toHaveBeenCalled();
    expect(drainResolvedCompletions).not.toHaveBeenCalled();
  });

  it('forwards child finalVars through to the core recordChildCompletion call', async () => {
    // The CLI helper forwards childState (carrying finalVars) to the core
    // service unchanged. Core materializes finalVars onto the persisted row —
    // exercised in completion-service.test.ts.
    const delegation = makeDelegationLinkage();
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: delegation,
      finalVars: { PlanPath: '/work/plan.json', version: '2.1' },
    });
    const parentState = makeState(PARENT_RUN_ID, {
      substepStates: [{ id: '1', frameKey: brandFrameKeyForTest('1'), status: 'pending' }],
    });
    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const _lock = makeLock();
    const output = makeOutput();
    const recordChildCompletion = wireMocks(manager, makeLifecycleService());

    await reportTerminalToDelegatingRun(childState, 'pass', '/test', output);

    expect(recordChildCompletion).toHaveBeenCalledWith({
      childState: expect.objectContaining({
        finalVars: { PlanPath: '/work/plan.json', version: '2.1' },
      }),
      result: 'pass',
    });
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
      parentLinkage: makeInlineLinkage(),
    });
    const linkage = extractParentLinkage(state);
    expect(linkage).toBeDefined();
    expect(linkage!.parentRunId).toBe(PARENT_RUN_ID);
  });

  it('does not report inline child outcomes through the delegation-only report path', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeInlineLinkage(),
    });
    const manager = makeManager(new Map());
    const output = makeOutput();
    wireMocks(manager, makeLifecycleService());

    const result = await reportTerminalToDelegatingRun(childState, 'pass', '/test', output);

    expect(result).toBe('not-applicable');
    expect(core.RunbookCompletionService).not.toHaveBeenCalled();
    expect(drainResolvedCompletions).not.toHaveBeenCalled();
    expect(runExecutionLoop).not.toHaveBeenCalled();
  });
});

describe('advanceParentForInlineChild', () => {
  it('rethrows when draining resolved completions fails', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeInlineLinkage(),
    });
    const parentState = makeState(PARENT_RUN_ID);
    const manager = makeManager(new Map([[parentState.id, parentState]]));
    const output = makeOutput();
    wireMocks(manager, makeLifecycleService());

    // Drain reports a hard failure on the parent: the helper must surface it.
    jest.mocked(drainResolvedCompletions).mockResolvedValue({
      unresolved: 0,
      status: 'failed',
      applied: 0,
      state: parentState,
      message: 'drain blew up',
    } as never);

    await expect(advanceParentForInlineChild(childState, 'pass', '/test', output)).rejects.toThrow(
      'drain blew up',
    );
    // A failed drain never reaches the execution loop.
    expect(runExecutionLoop).not.toHaveBeenCalled();
  });

  it('runs the execution loop after applying completions and propagates a loop STOP terminal', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeInlineLinkage(),
    });
    // Parent carries no linkage of its own, so the recursive propagate after the
    // loop terminal is a no-op — isolating the loopResult branch under test.
    const parentState = makeState(PARENT_RUN_ID, { parentLinkage: undefined });
    const manager = makeManager(new Map([[parentState.id, parentState]]));
    const output = makeOutput();
    wireMocks(manager, makeLifecycleService());

    // Drain applied a completion but the parent is still active -> drives the loop.
    jest.mocked(drainResolvedCompletions).mockResolvedValue({
      unresolved: 0,
      status: 'continue',
      applied: 1,
      state: parentState,
    });
    jest.mocked(runExecutionLoop).mockResolvedValue('stopped');

    const result = await advanceParentForInlineChild(childState, 'pass', '/test', output);

    expect(runExecutionLoop).toHaveBeenCalledTimes(1);
    expect(result).toBe('stopped');
  });

  it('returns handled when the post-apply execution loop completes normally', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeInlineLinkage(),
    });
    const parentState = makeState(PARENT_RUN_ID, { parentLinkage: undefined });
    const manager = makeManager(new Map([[parentState.id, parentState]]));
    const output = makeOutput();
    wireMocks(manager, makeLifecycleService());

    jest.mocked(drainResolvedCompletions).mockResolvedValue({
      unresolved: 0,
      status: 'continue',
      applied: 1,
      state: parentState,
    });
    jest.mocked(runExecutionLoop).mockResolvedValue('done');

    const result = await advanceParentForInlineChild(childState, 'pass', '/test', output);

    expect(runExecutionLoop).toHaveBeenCalledTimes(1);
    // Loop 'done' with a linkage-free parent -> propagate is not-applicable -> handled.
    expect(result).toBe('handled');
  });
});
