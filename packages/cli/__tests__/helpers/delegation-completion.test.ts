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
  TerminalUpwardPropagationResult,
} from '@rundown-org/core';
import type { OutputEmitter } from '../../src/services/output-emitter.js';

type SubstepStatePatch = Partial<Pick<SubstepState, 'status' | 'result' | 'delegation'>>;

const PARENT_RUN_ID = brandRunIdForTest('rd_11111111111111111111111111111111');
const CHILD_RUN_ID = brandRunIdForTest('rd_22222222222222222222222222222222');

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

/**
 * Seam-result union produced by the core `propagateTerminalChildUpward`. The
 * thin CLI adapters delegate the decision to this seam, so its mock is the sole
 * driver of adapter routing tests; the REAL seam logic is covered in
 * `packages/core/__tests__/runbook/inline-parent-advance.test.ts`.
 *
 * ALIASED from the core union rather than restated (#602): a hand-written copy
 * silently rots when core gains a member, which is exactly the type pressure the
 * seam's union is there to apply.
 */
type SeamResult = TerminalUpwardPropagationResult;

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
  // Retained as a plain stub for the ESM link check; the thin adapters no longer
  // project — the core seam does — so no test drives it.
  projectDelegationTerminalOutcome: jest.fn(),
  // The thin CLI adapters delegate the decision to the core seam. Mock it so
  // adapter tests assert routing + result mapping; the REAL seam logic is
  // covered by packages/core/__tests__/runbook/inline-parent-advance.test.ts.
  propagateTerminalChildUpward:
    mockFn<
      (
        deps: unknown,
        childState: RunbookState,
        result: 'pass' | 'fail' | undefined,
      ) => Promise<SeamResult>
    >().mockResolvedValue('handled'),
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
// Loose arg signature avoids TS2589 (excessively deep instantiation) when
// `toHaveBeenCalledWith` type-checks the full RunbookState argument; the return
// type stays `SeamResult` so `mockResolvedValue` still narrows.
const { propagateTerminalChildUpward } = core as unknown as {
  propagateTerminalChildUpward: jest.Mock<(...args: unknown[]) => Promise<SeamResult>>;
};
const {
  reportTerminalToDelegatingRun,
  advanceParentForInlineChild,
  buildAdvanceInlineParent,
  buildLinkageCycleDiagnostic,
  extractParentLinkage,
  propagateChildTerminal,
  propagateDrivenRunTerminal,
  propagationRequiresFailureExit,
  inlineAdvanceRequiresFailureExit,
} = await import('../../src/helpers/delegation-completion.js');

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
      | 'cancelled'
      | 'blocked';
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
  // Default the seam mock to 'handled'; suites that assert a specific mapping
  // override it per test.
  propagateTerminalChildUpward.mockResolvedValue('handled');
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

describe('reportTerminalToDelegatingRun (thin adapter over core seam)', () => {
  beforeEach(() => {
    propagateTerminalChildUpward.mockReset();
  });

  it('returns not-applicable for a non-delegation child without calling the seam', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeInlineLinkage(),
    });
    const output = makeOutput();
    const result = await reportTerminalToDelegatingRun(childState, 'pass', '/test', output);
    expect(result).toBe('not-applicable');
    expect(propagateTerminalChildUpward).not.toHaveBeenCalled();
  });

  it('routes a delegation child to the seam and maps a fresh report through', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeDelegationLinkage(),
    });
    const output = makeOutput();
    propagateTerminalChildUpward.mockResolvedValue('reported');
    const result = await reportTerminalToDelegatingRun(childState, 'pass', '/test', output);
    expect(result).toBe('reported');
    expect(propagateTerminalChildUpward).toHaveBeenCalledWith(
      expect.objectContaining({ advanceInlineParent: expect.any(Function) }),
      childState,
      'pass',
    );
    expect(output.flush).toHaveBeenCalled();
  });

  it('collapses a seam duplicate to reported — CLI never distinguished it (finding 2)', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeDelegationLinkage(),
    });
    const output = makeOutput();
    propagateTerminalChildUpward.mockResolvedValue('duplicate');
    const result = await reportTerminalToDelegatingRun(childState, 'pass', '/test', output);
    expect(result).toBe('reported');
  });

  it('maps a seam blocked result to blocked', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'stopped',
      parentLinkage: makeDelegationLinkage(),
    });
    const output = makeOutput();
    propagateTerminalChildUpward.mockResolvedValue('blocked');
    const result = await reportTerminalToDelegatingRun(childState, 'pass', '/test', output);
    expect(result).toBe('blocked');
  });

  it('maps a seam linkage-cycle onto the fail-closed blocked (#602)', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeDelegationLinkage(),
    });
    const output = makeOutput();
    propagateTerminalChildUpward.mockResolvedValue('linkage-cycle');
    const result = await reportTerminalToDelegatingRun(childState, 'pass', '/test', output);
    expect(result).toBe('blocked');
  });

  it('maps a seam not-applicable result to not-applicable', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeDelegationLinkage(),
    });
    const output = makeOutput();
    propagateTerminalChildUpward.mockResolvedValue('not-applicable');
    const result = await reportTerminalToDelegatingRun(childState, 'pass', '/test', output);
    expect(result).toBe('not-applicable');
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

describe('advanceParentForInlineChild (thin adapter over core seam)', () => {
  beforeEach(() => {
    propagateTerminalChildUpward.mockReset();
  });

  it('returns not-applicable for a non-inline child without calling the seam', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeDelegationLinkage(),
    });
    const output = makeOutput();
    const result = await advanceParentForInlineChild(childState, 'pass', '/test', output);
    expect(result).toBe('not-applicable');
    expect(propagateTerminalChildUpward).not.toHaveBeenCalled();
  });

  it('delegates an inline child to the core seam and maps stopped through', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeInlineLinkage(),
    });
    const output = makeOutput();
    propagateTerminalChildUpward.mockResolvedValue('stopped');
    const result = await advanceParentForInlineChild(childState, 'pass', '/test', output);
    expect(result).toBe('stopped');
    expect(propagateTerminalChildUpward).toHaveBeenCalledWith(
      expect.objectContaining({ advanceInlineParent: expect.any(Function) }),
      childState,
      'pass',
    );
  });

  it('maps a seam handled result through', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeInlineLinkage(),
    });
    const output = makeOutput();
    propagateTerminalChildUpward.mockResolvedValue('handled');
    const result = await advanceParentForInlineChild(childState, 'pass', '/test', output);
    expect(result).toBe('handled');
  });

  it('maps a seam reported result (unreachable for inline) to not-applicable', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeInlineLinkage(),
    });
    const output = makeOutput();
    propagateTerminalChildUpward.mockResolvedValue('reported');
    const result = await advanceParentForInlineChild(childState, 'pass', '/test', output);
    expect(result).toBe('not-applicable');
  });

  it('maps a seam linkage-cycle onto the fail-closed blocked (#602)', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeInlineLinkage(),
    });
    const output = makeOutput();
    propagateTerminalChildUpward.mockResolvedValue('linkage-cycle');
    const result = await advanceParentForInlineChild(childState, 'pass', '/test', output);
    expect(result).toBe('blocked');
  });
});

describe('propagateChildTerminal (linkage dispatcher over core seam)', () => {
  beforeEach(() => {
    propagateTerminalChildUpward.mockReset();
  });

  it('maps a seam linkage-cycle onto the fail-closed blocked (#602)', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeInlineLinkage(),
    });
    const output = makeOutput();
    propagateTerminalChildUpward.mockResolvedValue('linkage-cycle');
    const result = await propagateChildTerminal(childState, 'pass', '/test', output);
    expect(result).toBe('blocked');
  });

  it('still collapses a seam duplicate to reported (finding 2 regression)', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeDelegationLinkage(),
    });
    const output = makeOutput();
    propagateTerminalChildUpward.mockResolvedValue('duplicate');
    const result = await propagateChildTerminal(childState, 'pass', '/test', output);
    expect(result).toBe('reported');
  });
});

describe('buildLinkageCycleDiagnostic (#602)', () => {
  it('emits INLINE_PARENT_CYCLE naming the repeated run', () => {
    const output = makeOutput();
    buildLinkageCycleDiagnostic(output)({ runId: CHILD_RUN_ID, cause: 'repeat' });
    expect(output.error).toHaveBeenCalledWith(
      `Inline parent cycle detected at ${CHILD_RUN_ID}`,
      'INLINE_PARENT_CYCLE',
      { runId: CHILD_RUN_ID, cause: 'repeat' },
    );
  });

  it('emits INLINE_PARENT_CYCLE naming the run the depth cap stalled at', () => {
    const output = makeOutput();
    buildLinkageCycleDiagnostic(output)({ runId: CHILD_RUN_ID, cause: 'depth' });
    expect(output.error).toHaveBeenCalledWith(
      `Inline parent chain from ${CHILD_RUN_ID} exceeded the maximum propagation depth`,
      'INLINE_PARENT_CYCLE',
      { runId: CHILD_RUN_ID, cause: 'depth' },
    );
  });
});

describe('buildAdvanceInlineParent (CLI execution callable)', () => {
  const FRAME = brandFrameKeyForTest('1|');

  beforeEach(() => {
    jest.mocked(drainResolvedCompletions).mockReset();
    jest.mocked(runExecutionLoop).mockReset();
  });

  it('throws when drain reports a hard failure', async () => {
    const parentState = makeState(PARENT_RUN_ID);
    const manager = makeManager(new Map([[parentState.id, parentState]]));
    const output = makeOutput();
    wireMocks(manager, makeLifecycleService());
    jest.mocked(drainResolvedCompletions).mockResolvedValue({
      unresolved: 0,
      status: 'failed',
      applied: 0,
      state: parentState,
      message: 'drain blew up',
    } as never);

    const advance = buildAdvanceInlineParent('/test', output);
    await expect(
      advance({
        parentRunId: PARENT_RUN_ID,
        parentFrameKey: FRAME,
        parentEntry: 1,
        result: 'pass',
      }),
    ).rejects.toThrow('drain blew up');
    expect(runExecutionLoop).not.toHaveBeenCalled();
  });

  it('collapses a drain STOP to status stopped', async () => {
    const parentState = makeState(PARENT_RUN_ID);
    const manager = makeManager(new Map([[parentState.id, parentState]]));
    const output = makeOutput();
    wireMocks(manager, makeLifecycleService());
    jest.mocked(drainResolvedCompletions).mockResolvedValue({
      unresolved: 0,
      status: 'stopped',
      applied: 1,
    } as never);
    const advance = buildAdvanceInlineParent('/test', output);
    const outcome = await advance({
      parentRunId: PARENT_RUN_ID,
      parentFrameKey: FRAME,
      parentEntry: 1,
      result: 'pass',
    });
    expect(outcome).toEqual({ status: 'stopped' });
    expect(runExecutionLoop).not.toHaveBeenCalled();
  });

  it('runs the execution loop after applying completions and collapses a loop STOP', async () => {
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
    jest.mocked(runExecutionLoop).mockResolvedValue('stopped');
    const advance = buildAdvanceInlineParent('/test', output);
    const outcome = await advance({
      parentRunId: PARENT_RUN_ID,
      parentFrameKey: FRAME,
      parentEntry: 1,
      result: 'pass',
    });
    expect(runExecutionLoop).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ status: 'stopped' });
  });

  it('drives the loop with the defer-to-caller terminal mode (no self-release)', async () => {
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
    const advance = buildAdvanceInlineParent('/test', output);
    await advance({
      parentRunId: PARENT_RUN_ID,
      parentFrameKey: FRAME,
      parentEntry: 1,
      result: 'pass',
    });
    expect(runExecutionLoop).toHaveBeenCalledWith(
      expect.anything(),
      PARENT_RUN_ID,
      expect.anything(),
      '/test',
      expect.any(Boolean),
      expect.anything(),
      expect.objectContaining({ terminalReleaseMode: 'defer-to-caller' }),
    );
  });

  it('collapses a normal loop completion to status done', async () => {
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
    const advance = buildAdvanceInlineParent('/test', output);
    const outcome = await advance({
      parentRunId: PARENT_RUN_ID,
      parentFrameKey: FRAME,
      parentEntry: 1,
      result: 'pass',
    });
    expect(outcome).toEqual({ status: 'done' });
  });

  it('returns status active when completions applied but the parent still waits', async () => {
    const parentState = makeState(PARENT_RUN_ID, { parentLinkage: undefined });
    const manager = makeManager(new Map([[parentState.id, parentState]]));
    const output = makeOutput();
    wireMocks(manager, makeLifecycleService());
    jest.mocked(drainResolvedCompletions).mockResolvedValue({
      unresolved: 1,
      status: 'continue',
      applied: 0,
      state: parentState,
    });
    const advance = buildAdvanceInlineParent('/test', output);
    const outcome = await advance({
      parentRunId: PARENT_RUN_ID,
      parentFrameKey: FRAME,
      parentEntry: 1,
      result: 'pass',
    });
    expect(outcome).toEqual({ status: 'active' });
    expect(runExecutionLoop).not.toHaveBeenCalled();
  });

  it('returns status active when the parent has vanished', async () => {
    const manager = makeManager(new Map());
    const output = makeOutput();
    wireMocks(manager, makeLifecycleService());
    const advance = buildAdvanceInlineParent('/test', output);
    const outcome = await advance({
      parentRunId: PARENT_RUN_ID,
      parentFrameKey: FRAME,
      parentEntry: 1,
      result: 'pass',
    });
    expect(outcome).toEqual({ status: 'active' });
    expect(drainResolvedCompletions).not.toHaveBeenCalled();
  });
});

describe('propagateDrivenRunTerminal', () => {
  const LOOP_INFERRED = { kind: 'loop-inferred' } as const;

  it('skips when the driven run is missing', async () => {
    const manager = makeManager(new Map());
    const output = makeOutput();
    const result = await propagateDrivenRunTerminal(
      manager as unknown as RunbookStateManagerType,
      CHILD_RUN_ID,
      '/test',
      output,
      LOOP_INFERRED,
    );
    expect(result).toEqual({ kind: 'skipped' });
  });

  it('skips when the driven run is still running', async () => {
    const child = makeState(CHILD_RUN_ID, {
      lifecycle: 'running',
      parentLinkage: makeInlineLinkage(),
    });
    const manager = makeManager(new Map([[child.id, child]]));
    const output = makeOutput();
    const result = await propagateDrivenRunTerminal(
      manager as unknown as RunbookStateManagerType,
      CHILD_RUN_ID,
      '/test',
      output,
      LOOP_INFERRED,
    );
    expect(result).toEqual({ kind: 'skipped' });
  });

  it('skips when the terminal run has no parent linkage', async () => {
    const root = makeState(CHILD_RUN_ID, { lifecycle: 'completed', parentLinkage: undefined });
    const manager = makeManager(new Map([[root.id, root]]));
    const output = makeOutput();
    const result = await propagateDrivenRunTerminal(
      manager as unknown as RunbookStateManagerType,
      CHILD_RUN_ID,
      '/test',
      output,
      LOOP_INFERRED,
    );
    expect(result).toEqual({ kind: 'skipped' });
  });

  it('propagates a terminal inline child through the seam and lifts the linkage kind', async () => {
    const child = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeInlineLinkage(),
    });
    const manager = makeManager(new Map([[child.id, child]]));
    const output = makeOutput();
    propagateTerminalChildUpward.mockResolvedValue('handled');
    const result = await propagateDrivenRunTerminal(
      manager as unknown as RunbookStateManagerType,
      CHILD_RUN_ID,
      '/test',
      output,
      LOOP_INFERRED,
    );
    expect(result).toEqual({ kind: 'inline-advanced', result: 'handled' });
  });

  it('lifts an inline-advanced STOP terminal as { inline-advanced, stopped }', async () => {
    const child = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeInlineLinkage(),
    });
    const manager = makeManager(new Map([[child.id, child]]));
    const output = makeOutput();
    propagateTerminalChildUpward.mockResolvedValue('stopped');
    const result = await propagateDrivenRunTerminal(
      manager as unknown as RunbookStateManagerType,
      CHILD_RUN_ID,
      '/test',
      output,
      LOOP_INFERRED,
    );
    expect(result).toEqual({ kind: 'inline-advanced', result: 'stopped' });
  });

  it('lifts an inline-advanced blocked terminal as { inline-advanced, blocked }', async () => {
    const child = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeInlineLinkage(),
    });
    const manager = makeManager(new Map([[child.id, child]]));
    const output = makeOutput();
    propagateTerminalChildUpward.mockResolvedValue('blocked');
    const result = await propagateDrivenRunTerminal(
      manager as unknown as RunbookStateManagerType,
      CHILD_RUN_ID,
      '/test',
      output,
      LOOP_INFERRED,
    );
    expect(result).toEqual({ kind: 'inline-advanced', result: 'blocked' });
  });

  it('reports a terminal delegation child through the seam', async () => {
    const child = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeDelegationLinkage(),
    });
    const manager = makeManager(new Map([[child.id, child]]));
    const output = makeOutput();
    propagateTerminalChildUpward.mockResolvedValue('reported');
    const result = await propagateDrivenRunTerminal(
      manager as unknown as RunbookStateManagerType,
      CHILD_RUN_ID,
      '/test',
      output,
      LOOP_INFERRED,
    );
    expect(result).toEqual({ kind: 'delegation-reported', result: 'reported' });
  });

  it('forwards an operator-result trigger into the seam call (pass/fail commands)', async () => {
    // Correction 1 + SHOULD-FIX 5: an operator-result trigger overrides lifecycle
    // inference. The authored 'pass' is forwarded into the adapter and on into the
    // seam, even though the child is lifecycle 'stopped'.
    const child = makeState(CHILD_RUN_ID, {
      lifecycle: 'stopped',
      parentLinkage: makeDelegationLinkage(),
    });
    const manager = makeManager(new Map([[child.id, child]]));
    const output = makeOutput();
    propagateTerminalChildUpward.mockResolvedValue('reported');
    const result = await propagateDrivenRunTerminal(
      manager as unknown as RunbookStateManagerType,
      CHILD_RUN_ID,
      '/test',
      output,
      { kind: 'operator-result', result: 'pass' },
    );
    expect(result).toEqual({ kind: 'delegation-reported', result: 'reported' });
    expect(propagateTerminalChildUpward).toHaveBeenCalledWith(
      expect.objectContaining({ advanceInlineParent: expect.any(Function) }),
      child,
      'pass',
    );
  });
});

describe('propagationRequiresFailureExit', () => {
  // any-linkage rule: fires on ANY non-skipped propagation whose result is
  // stopped/blocked, delegation included (used by goto + run --step).
  it('returns false for a skipped propagation', () => {
    expect(propagationRequiresFailureExit({ kind: 'skipped' })).toBe(false);
  });

  it('returns true for an inline-advanced stopped/blocked propagation', () => {
    expect(propagationRequiresFailureExit({ kind: 'inline-advanced', result: 'stopped' })).toBe(
      true,
    );
    expect(propagationRequiresFailureExit({ kind: 'inline-advanced', result: 'blocked' })).toBe(
      true,
    );
  });

  it('returns false for an inline-advanced handled/not-applicable propagation', () => {
    expect(propagationRequiresFailureExit({ kind: 'inline-advanced', result: 'handled' })).toBe(
      false,
    );
    expect(
      propagationRequiresFailureExit({ kind: 'inline-advanced', result: 'not-applicable' }),
    ).toBe(false);
  });

  it('returns true for a delegation-reported blocked propagation (any-linkage semantics)', () => {
    expect(propagationRequiresFailureExit({ kind: 'delegation-reported', result: 'blocked' })).toBe(
      true,
    );
  });

  it('returns false for a delegation-reported reported propagation', () => {
    expect(
      propagationRequiresFailureExit({ kind: 'delegation-reported', result: 'reported' }),
    ).toBe(false);
  });
});

describe('inlineAdvanceRequiresFailureExit', () => {
  // inline-only rule: fires ONLY on inline-advanced stopped/blocked; delegation
  // reporting is report-only and never flips the exit (used by collect + pass/fail).
  it('returns true for an inline-advanced stopped/blocked propagation', () => {
    expect(inlineAdvanceRequiresFailureExit({ kind: 'inline-advanced', result: 'stopped' })).toBe(
      true,
    );
    expect(inlineAdvanceRequiresFailureExit({ kind: 'inline-advanced', result: 'blocked' })).toBe(
      true,
    );
  });

  it('returns false for an inline-advanced handled/not-applicable propagation', () => {
    expect(inlineAdvanceRequiresFailureExit({ kind: 'inline-advanced', result: 'handled' })).toBe(
      false,
    );
    expect(
      inlineAdvanceRequiresFailureExit({ kind: 'inline-advanced', result: 'not-applicable' }),
    ).toBe(false);
  });

  it('returns false for a delegation-reported blocked propagation (the key divergence)', () => {
    expect(
      inlineAdvanceRequiresFailureExit({ kind: 'delegation-reported', result: 'blocked' }),
    ).toBe(false);
  });

  it('returns false for a skipped propagation', () => {
    expect(inlineAdvanceRequiresFailureExit({ kind: 'skipped' })).toBe(false);
  });
});
