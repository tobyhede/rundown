import { brandInitialTemplateVarsForTest } from './brand-helpers.js';
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { mockErrorHelpers } from './mock-error-helpers.js';
import {
  brandDelegationTokenHashForTest,
  brandFrameKeyForTest,
  brandRunIdForTest,
  brandStoredOutputsForTest,
} from './brand-helpers.js';
import { mockFn } from './typed-mocks.js';
import { delegationRuntimeDouble } from './delegation-runtime-helpers.js';
import type {
  Frame,
  FrameKey,
  RunbookState,
  DelegationLinkage,
  InlineLinkage,
  SubstepState,
  ResolvedCompletion,
  DelegationCredentialIssuer,
  DelegationTokenDeriver,
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

/**
 * A core-composed refusal, as the seam now hands it back (#603).
 *
 * The message and code are core's (their text is pinned by the seam's own
 * tests); these adapters only render them, so the fixture deliberately uses a
 * placeholder message no adapter could have composed on its own — reproducing it
 * is what proves the render is pass-through.
 */
const REPEAT_CYCLE_SEAM_RESULT = {
  kind: 'linkage-cycle',
  trip: {
    cause: 'repeat',
    repeatedRunId: CHILD_RUN_ID,
    code: 'INLINE_PARENT_CYCLE',
    message: 'core-composed repeat message',
  },
} as const satisfies SeamResult;

/**
 * A refused inline advance, as the seam hands it back (#802).
 *
 * Same construction as the cycle fixture above and for the same reason: the
 * message and code are core's, so a placeholder no adapter could have composed
 * is what proves the render is pass-through rather than re-synthesis.
 */
const ADVANCE_REFUSED_SEAM_RESULT = {
  kind: 'advance-refused',
  refusal: {
    reason: 'target_mismatch',
    code: 'COMPLETION_TARGET_MISMATCH',
    message: 'core-composed target mismatch message',
    // The walk recurses, so the run that refused is routinely an ANCESTOR — not
    // the child this adapter was called for. A distinct id here is what proves
    // the envelope names the refusing run rather than the one in hand.
    runId: PARENT_RUN_ID,
  },
} as const satisfies SeamResult;

/** The envelope every adapter must emit when it collapses the refused advance. */
const ADVANCE_REFUSED_ENVELOPE = [
  'core-composed target mismatch message',
  'COMPLETION_TARGET_MISMATCH',
  { reason: 'target_mismatch', runId: PARENT_RUN_ID },
] as const;

/** The envelope every adapter must emit when it collapses the refusal. */
const REPEAT_CYCLE_ENVELOPE = [
  'core-composed repeat message',
  'INLINE_PARENT_CYCLE',
  { cause: 'repeat', runId: CHILD_RUN_ID },
] as const;

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
  // A real value, not a stub: the module composes the refused-advance envelope
  // from it, and the tests assert the code the operator actually sees.
  COMPLETION_TARGET_MISMATCH_CODE: 'COMPLETION_TARGET_MISMATCH',
  // The thin CLI adapters delegate the decision to the core seam. Mock it so
  // adapter tests assert routing + result mapping; the REAL seam logic is
  // covered by packages/core/__tests__/runbook/inline-parent-advance.test.ts.
  propagateTerminalChildUpward: mockFn<
    (
      deps: unknown,
      childState: RunbookState,
      result: 'pass' | 'fail' | undefined,
    ) => Promise<SeamResult>
  >().mockResolvedValue({ kind: 'handled' }),
  // Named exports of `run-progression-adapters.js`, which this module now
  // lazily imports to build the loop's public activation. Stubs only: these
  // tests assert drain/loop branches and never drive an inline launch, but the
  // ESM named-import link check resolves the whole graph the moment that
  // dynamic import runs, so every name it reaches must exist here.
  activateRunProgression: jest.fn(),
  createEffectfulActorMutationRunner: jest.fn(),
  flowBackInlineTerminal: jest.fn(),
  ObservationDeliveryError: class ObservationDeliveryError extends Error {},
  // A real value for the same reason as COMPLETION_TARGET_MISMATCH_CODE: the
  // adapters compose refusal envelopes from it.
  CLIErrorCodes: {
    ACTOR_CONTEXT_REQUIRED: 'ACTOR_CONTEXT_REQUIRED',
    CONCURRENT_MODIFICATION: 'CONCURRENT_MODIFICATION',
  },
  // advanceParentForInlineChild lazily constructs a bridged emitter; a no-op
  // stub satisfies the link check (these tests assert on drain/loop branches).
  ExecutionEventEmitter: jest.fn().mockImplementation(() => ({ subscribe: jest.fn() })),
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
  // Reached only through `run-progression-adapters.js`'s static edge back into
  // this module, resolved when the lazy import of the adapters runs. Never
  // called here — no test drives an inline launch — but the ESM link check
  // needs both names to exist.
  createCliCommandServices: jest.fn(),
  launchInlineChildFromIntent: jest.fn(),
  // The REAL builder, not a stub: it is the sole construction site for the
  // refusal envelope, and these tests assert the exact object the operator
  // ends up seeing. Stubbing it would assert the adapter forwards whatever it
  // is handed — which is not the property under test.
  refusalFromDrainFailure: (
    runId: string,
    drained: { reason: string; message: string },
  ): Record<string, unknown> => ({
    reason: drained.reason,
    message: drained.message,
    code: 'COMPLETION_TARGET_MISMATCH',
    runId,
  }),
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
  emitLinkageCycleDiagnostic,
  extractParentLinkage,
  propagateChildTerminal,
  propagateDrivenRunTerminal,
  propagationRequiresFailureExit,
  inlineAdvanceRequiresFailureExit,
  isInlinePropagationRefusal,
  renderInlinePropagationRefusal,
} = await import('../../src/helpers/delegation-completion.js');

function makeState(id: RunbookState['id'], overrides: Partial<RunbookState> = {}): RunbookState {
  const base: RunbookState = {
    prompted: false,
    templateVars: brandInitialTemplateVarsForTest({}),
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
  // Mirrors OutputEmitter.error's real (message, code, details) shape so the #602
  // diagnostic's code + payload are type-checked at the assertion, not just matched.
  error: jest.Mock<(message: string, code?: string, details?: Record<string, unknown>) => void>;
  warning: jest.Mock<(text: string) => void>;
}

function makeOutput(): MockOutput & OutputEmitter {
  // Cast through unknown — the OutputEmitter has many more methods, but
  // delegation-completion only consumes flush/status/error/warning.
  return {
    flush: mockFn<() => void>(),
    status: mockFn<(action: string, message?: string, data?: Record<string, unknown>) => void>(),
    error: mockFn<(message: string, code?: string, details?: Record<string, unknown>) => void>(),
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
        releaseRuns: mockFn<() => Promise<unknown>>().mockResolvedValue({
          kind: 'committed',
          value: undefined,
        }),
      }) as unknown as SessionServiceType,
  );

  return recordChildCompletion;
}

beforeEach(() => {
  jest.resetAllMocks();
  // Default the seam mock to 'handled'; suites that assert a specific mapping
  // override it per test.
  propagateTerminalChildUpward.mockResolvedValue({ kind: 'handled' });
  mockCreateCliRunbookActorService.mockImplementation(() => makeActorDouble());
  jest.mocked(drainResolvedCompletions).mockResolvedValue({
    unresolved: 0,
    status: 'continue',
    applied: 0,
    state: makeState(PARENT_RUN_ID),
  });
  jest.mocked(runExecutionLoop).mockResolvedValue({ status: 'waiting' });
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
    propagateTerminalChildUpward.mockResolvedValue({ kind: 'reported' });
    const result = await reportTerminalToDelegatingRun(childState, 'pass', '/test', output);
    expect(result).toBe('reported');
    expect(propagateTerminalChildUpward).toHaveBeenCalledWith(
      expect.objectContaining({ advanceInlineParent: expect.any(Function) }),
      childState,
      'pass',
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.flush).toHaveBeenCalled();
  });

  it('collapses a seam duplicate to reported — CLI never distinguished it (finding 2)', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeDelegationLinkage(),
    });
    const output = makeOutput();
    propagateTerminalChildUpward.mockResolvedValue({ kind: 'duplicate' });
    const result = await reportTerminalToDelegatingRun(childState, 'pass', '/test', output);
    expect(result).toBe('reported');
  });

  it('maps a seam blocked result to blocked', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'stopped',
      parentLinkage: makeDelegationLinkage(),
    });
    const output = makeOutput();
    propagateTerminalChildUpward.mockResolvedValue({ kind: 'blocked' });
    const result = await reportTerminalToDelegatingRun(childState, 'pass', '/test', output);
    expect(result).toBe('blocked');
  });

  it('renders the seam trip, then maps it onto the fail-closed blocked (#602/#603)', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeDelegationLinkage(),
    });
    const output = makeOutput();
    propagateTerminalChildUpward.mockResolvedValue(REPEAT_CYCLE_SEAM_RESULT);
    const result = await reportTerminalToDelegatingRun(childState, 'pass', '/test', output);
    expect(result).toBe('blocked');
    // The operator diagnostic is no longer pushed out of core through a sink —
    // this adapter owns the emitter, so it renders the returned trip itself.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.error).toHaveBeenCalledWith(...REPEAT_CYCLE_ENVELOPE);
  });

  // Unreachable in production — a delegation linkage takes the seam's
  // report-only arm and never calls the inline advance — but reachable through
  // the union this adapter must narrow. Pinned so the member cannot be dropped
  // from the narrowing and silently fall through to `return outcome.kind`,
  // which has no member to receive it (#802).
  it('renders the seam refusal, then maps it onto the fail-closed blocked (#802)', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeDelegationLinkage(),
    });
    const output = makeOutput();
    propagateTerminalChildUpward.mockResolvedValue(ADVANCE_REFUSED_SEAM_RESULT);
    const result = await reportTerminalToDelegatingRun(childState, 'pass', '/test', output);
    expect(result).toBe('blocked');
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.error).toHaveBeenCalledWith(...ADVANCE_REFUSED_ENVELOPE);
  });

  it('maps a seam not-applicable result to not-applicable', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeDelegationLinkage(),
    });
    const output = makeOutput();
    propagateTerminalChildUpward.mockResolvedValue({ kind: 'not-applicable' });
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
    propagateTerminalChildUpward.mockResolvedValue({ kind: 'stopped' });
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
    propagateTerminalChildUpward.mockResolvedValue({ kind: 'handled' });
    const result = await advanceParentForInlineChild(childState, 'pass', '/test', output);
    expect(result).toBe('handled');
  });

  it('maps a seam reported result (unreachable for inline) to not-applicable', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeInlineLinkage(),
    });
    const output = makeOutput();
    propagateTerminalChildUpward.mockResolvedValue({ kind: 'reported' });
    const result = await advanceParentForInlineChild(childState, 'pass', '/test', output);
    expect(result).toBe('not-applicable');
  });

  it('renders the seam trip, then maps it onto the fail-closed blocked (#602/#603)', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeInlineLinkage(),
    });
    const output = makeOutput();
    propagateTerminalChildUpward.mockResolvedValue(REPEAT_CYCLE_SEAM_RESULT);
    const result = await advanceParentForInlineChild(childState, 'pass', '/test', output);
    expect(result).toBe('blocked');
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.error).toHaveBeenCalledWith(...REPEAT_CYCLE_ENVELOPE);
  });

  // #802: the arm that replaced the bare throw. The reason reaches the operator
  // under its own permanent code, and the exit stays fail-closed.
  it('renders the seam refusal, then maps it onto the fail-closed blocked (#802)', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeInlineLinkage(),
    });
    const output = makeOutput();
    propagateTerminalChildUpward.mockResolvedValue(ADVANCE_REFUSED_SEAM_RESULT);
    const result = await advanceParentForInlineChild(childState, 'pass', '/test', output);
    expect(result).toBe('blocked');
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.error).toHaveBeenCalledWith(...ADVANCE_REFUSED_ENVELOPE);
    // Rendered BEFORE the flush, which is what the throw skipped: buffered
    // parent-stream output used to be discarded along with the diagnostic.
    //
    // ORDER, not presence. `output.error` only accumulates into the JSON
    // renderer while the action object goes straight to the writer, so a flush
    // that ran first would still satisfy two `toHaveBeenCalled` assertions
    // while breaking the "action object is the last line" contract this comment
    // names — the one regression the test exists for would be the one it could
    // not see.
    /* eslint-disable @typescript-eslint/unbound-method -- Jest inspects these structural mocks without invoking them. */
    const errorAt = jest.mocked(output.error).mock.invocationCallOrder[0];
    const flushAt = jest.mocked(output.flush).mock.invocationCallOrder[0];
    /* eslint-enable @typescript-eslint/unbound-method */
    expect(errorAt).toBeDefined();
    expect(flushAt).toBeDefined();
    expect(errorAt).toBeLessThan(flushAt);
  });

  it('renders no diagnostic when the seam did not refuse', async () => {
    // The collapse and the render are two statements around one flush; a render
    // that drifted outside the refusal arm would print INLINE_PARENT_CYCLE on a
    // healthy advance.
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeInlineLinkage(),
    });
    const output = makeOutput();
    propagateTerminalChildUpward.mockResolvedValue({ kind: 'handled' });
    await advanceParentForInlineChild(childState, 'pass', '/test', output);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.error).not.toHaveBeenCalled();
  });
});

// The ONE owner of "which arms are refusals", read by the three adapters above
// and by `rundown collect`. Both halves are pinned here because the two must
// agree: a renderer that draws a diagnostic the predicate does not classify as
// a refusal produces a command that prints a refusal and exits 0.
describe('isInlinePropagationRefusal / renderInlinePropagationRefusal', () => {
  const nonRefusals = [
    { kind: 'handled' },
    { kind: 'stopped' },
    { kind: 'blocked' },
    { kind: 'not-applicable' },
    { kind: 'reported' },
    { kind: 'duplicate' },
  ] as const satisfies readonly SeamResult[];

  it.each(nonRefusals.map((o) => [o.kind, o] as const))(
    'classifies %s as not a refusal and renders nothing',
    (_kind, outcome) => {
      const output = makeOutput();
      expect(isInlinePropagationRefusal(outcome)).toBe(false);
      expect(renderInlinePropagationRefusal(output, outcome)).toBe(false);
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
      expect(output.error).not.toHaveBeenCalled();
    },
  );

  // `undefined` is the shape `collect` holds when the walk never ran: a
  // non-terminal collect sets no `terminalInlineAdvance` at all.
  it('treats an absent outcome as no refusal', () => {
    const output = makeOutput();
    expect(isInlinePropagationRefusal(undefined)).toBe(false);
    expect(renderInlinePropagationRefusal(output, undefined)).toBe(false);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.error).not.toHaveBeenCalled();
  });

  const refusalArms: readonly [
    string,
    SeamResult,
    readonly [string, string, Record<string, unknown>],
  ][] = [
    ['linkage-cycle', REPEAT_CYCLE_SEAM_RESULT, REPEAT_CYCLE_ENVELOPE],
    ['advance-refused', ADVANCE_REFUSED_SEAM_RESULT, ADVANCE_REFUSED_ENVELOPE],
  ];

  it.each(refusalArms)(
    'classifies %s as a refusal and renders its envelope',
    (_kind, outcome, envelope) => {
      const output = makeOutput();
      expect(isInlinePropagationRefusal(outcome)).toBe(true);
      expect(renderInlinePropagationRefusal(output, outcome)).toBe(true);
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
      expect(output.error).toHaveBeenCalledWith(envelope[0], envelope[1], envelope[2]);
      // Exactly one diagnostic: the two arms are mutually exclusive, and drawing
      // both would print a cycle for a cursor mismatch.
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
      expect(output.error).toHaveBeenCalledTimes(1);
    },
  );

  // Rendering is the caller's decision to act on; it never flushes on their
  // behalf, because the flush POSITION differs between the adapters and
  // `collect` (which must flush here to keep the applied action object last).
  it('leaves the flush to the caller', () => {
    const output = makeOutput();
    renderInlinePropagationRefusal(output, ADVANCE_REFUSED_SEAM_RESULT);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.flush).not.toHaveBeenCalled();
  });
});

describe('propagateChildTerminal (linkage dispatcher over core seam)', () => {
  beforeEach(() => {
    propagateTerminalChildUpward.mockReset();
  });

  it('renders the seam trip, then maps it onto the fail-closed blocked (#602/#603)', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeInlineLinkage(),
    });
    const output = makeOutput();
    propagateTerminalChildUpward.mockResolvedValue(REPEAT_CYCLE_SEAM_RESULT);
    const result = await propagateChildTerminal(childState, 'pass', '/test', output);
    expect(result).toBe('blocked');
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.error).toHaveBeenCalledWith(...REPEAT_CYCLE_ENVELOPE);
  });

  it('renders the seam refusal, then maps it onto the fail-closed blocked (#802)', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeInlineLinkage(),
    });
    const output = makeOutput();
    propagateTerminalChildUpward.mockResolvedValue(ADVANCE_REFUSED_SEAM_RESULT);
    const result = await propagateChildTerminal(childState, 'pass', '/test', output);
    expect(result).toBe('blocked');
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.error).toHaveBeenCalledWith(...ADVANCE_REFUSED_ENVELOPE);
  });

  it('still collapses a seam duplicate to reported (finding 2 regression)', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeDelegationLinkage(),
    });
    const output = makeOutput();
    propagateTerminalChildUpward.mockResolvedValue({ kind: 'duplicate' });
    const result = await propagateChildTerminal(childState, 'pass', '/test', output);
    expect(result).toBe('reported');
  });
});

describe('emitLinkageCycleDiagnostic (#602/#603)', () => {
  // The renderer RENDERS; it does not compose. Core owns the message and code (the
  // seam's own tests pin their text), so these assert pass-through + the run id
  // each cause carries under its own field name.
  it('renders core-composed repeat trip verbatim, naming the repeated run', () => {
    const output = makeOutput();
    emitLinkageCycleDiagnostic(output, {
      cause: 'repeat',
      repeatedRunId: CHILD_RUN_ID,
      code: 'INLINE_PARENT_CYCLE',
      message: 'core-composed repeat message',
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.error).toHaveBeenCalledWith(
      'core-composed repeat message',
      'INLINE_PARENT_CYCLE',
      {
        cause: 'repeat',
        runId: CHILD_RUN_ID,
      },
    );
  });

  it('renders core-composed depth trip verbatim, naming the deepest run walked', () => {
    const output = makeOutput();
    emitLinkageCycleDiagnostic(output, {
      cause: 'depth',
      deepestRunId: CHILD_RUN_ID,
      code: 'INLINE_PARENT_CYCLE',
      message: 'core-composed depth message',
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.error).toHaveBeenCalledWith(
      'core-composed depth message',
      'INLINE_PARENT_CYCLE',
      {
        cause: 'depth',
        runId: CHILD_RUN_ID,
      },
    );
  });
});

describe('buildAdvanceInlineParent (CLI execution callable)', () => {
  const FRAME = brandFrameKeyForTest('1|');

  beforeEach(() => {
    jest.mocked(drainResolvedCompletions).mockReset();
    jest.mocked(runExecutionLoop).mockReset();
  });

  // #802: the drain's `target_mismatch` is a diagnosed, permanent refusal. It
  // used to be re-thrown as a bare `Error`, which unwound past the adapter's
  // renderer and past `output.flush()` — so the operator lost the buffered
  // parent stream AND the reason, and was handed RD-999 "Unknown error".
  it('returns the drain refusal as data rather than throwing, and flushes first', async () => {
    const parentState = makeState(PARENT_RUN_ID);
    const manager = makeManager(new Map([[parentState.id, parentState]]));
    const output = makeOutput();
    wireMocks(manager, makeLifecycleService());
    jest.mocked(drainResolvedCompletions).mockResolvedValue({
      unresolved: 0,
      status: 'failed',
      reason: 'target_mismatch',
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
    ).resolves.toEqual({
      status: 'refused',
      refusal: {
        reason: 'target_mismatch',
        message: 'drain blew up',
        code: 'COMPLETION_TARGET_MISMATCH',
        runId: PARENT_RUN_ID,
      },
    });
    // The buffered parent stream survives the refusal; the throw discarded it.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.flush).toHaveBeenCalled();
    expect(runExecutionLoop).not.toHaveBeenCalled();
    expect(jest.mocked(drainResolvedCompletions).mock.calls[0]?.[0].terminalRelease).toEqual({
      role: 'addressed',
    });
  });

  // The re-entrant arm: this callable's drain applied, so it runs the parent's
  // execution loop — whose drain can hit the same refusal. Refusal Hand-back
  // returns data instead of a false `'stopped'`; the upward seam then performs
  // no recursion for a terminal that never happened.
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
    jest.mocked(runExecutionLoop).mockResolvedValue({ status: 'stopped' });
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

  it('preserves blocked severity without repeating nested flow-back', async () => {
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
    jest.mocked(runExecutionLoop).mockResolvedValue({ status: 'blocked' });

    const advance = buildAdvanceInlineParent('/test', output);
    await expect(
      advance({
        parentRunId: PARENT_RUN_ID,
        parentFrameKey: FRAME,
        parentEntry: 1,
        result: 'pass',
      }),
    ).resolves.toEqual({ status: 'blocked' });
  });

  // The loop's non-terminal exit. It used to be this callable's fall-through, so
  // no test had to name it; making the refusal reachable only by exclusion made
  // it an explicit branch, and an untested one is a branch that could return the
  // refusal shape for a parent that is merely waiting on its siblings.
  it('collapses a loop that is still waiting to status active', async () => {
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
    jest.mocked(runExecutionLoop).mockResolvedValue({ status: 'waiting' });
    const advance = buildAdvanceInlineParent('/test', output);
    const outcome = await advance({
      parentRunId: PARENT_RUN_ID,
      parentFrameKey: FRAME,
      parentEntry: 1,
      result: 'pass',
    });
    // `active`, and nothing else: the seam releases nothing and recurses
    // nowhere on it, which is what a parent still waiting on siblings needs.
    expect(outcome).toEqual({ status: 'active' });
  });

  it('drives the loop with atomic release and refusal hand-back', async () => {
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
    jest.mocked(runExecutionLoop).mockResolvedValue({ status: 'done' });
    const advance = buildAdvanceInlineParent('/test', output);
    await advance({
      parentRunId: PARENT_RUN_ID,
      parentFrameKey: FRAME,
      parentEntry: 1,
      result: 'pass',
    });
    // `driveProgression`, not the retired `returnRefusals`. Re-running this
    // parent can reach its next inline-launch intent, and the child must enter
    // the PUBLIC Run Progression activation like every other entry (#857); a
    // call without the seam refuses that launch `ACTOR_CONTEXT_REQUIRED`, which
    // is the wrong answer for a launch that is perfectly legal.
    expect(runExecutionLoop).toHaveBeenCalledWith(
      expect.anything(),
      PARENT_RUN_ID,
      expect.anything(),
      '/test',
      expect.anything(),
      expect.objectContaining({ driveProgression: expect.any(Function) }),
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
    jest.mocked(runExecutionLoop).mockResolvedValue({ status: 'done' });
    const advance = buildAdvanceInlineParent('/test', output);
    const outcome = await advance({
      parentRunId: PARENT_RUN_ID,
      parentFrameKey: FRAME,
      parentEntry: 1,
      result: 'pass',
    });
    expect(outcome).toEqual({ status: 'done' });
  });

  it('does not report a terminal twice when a nested entry already completed the parent', async () => {
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
    // The nested inline flow-back already drove the parent progression.
    // Reporting another terminal here would start the upward walk twice (#842).
    jest.mocked(runExecutionLoop).mockResolvedValue({ status: 'handled' });

    const advance = buildAdvanceInlineParent('/test', output);
    const outcome = await advance({
      parentRunId: PARENT_RUN_ID,
      parentFrameKey: FRAME,
      parentEntry: 1,
      result: 'pass',
    });

    expect(outcome).toEqual({ status: 'active' });
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

  // The continuation this callable performs — drain, then loop — can step the
  // composing parent INTO a DELEGATE step. Both halves need the parent's verified
  // claim authority: the drain issues the frontier, the loop projects it. Without
  // them the machine refuses `actor_context_required` and a valid nested workflow
  // stops.
  describe('run-scoped delegation runtime', () => {
    const OTHER_RUN_ID = brandRunIdForTest('rd_33333333333333333333333333333333');
    const issueDelegationCredential = mockFn<
      () => never
    >() as unknown as DelegationCredentialIssuer;
    const deriveDelegationToken = mockFn<() => string>() as unknown as DelegationTokenDeriver;
    // ONE branded value now, not two fields the fixture could set apart: the
    // scoping decision below is a single decision about a single authority.
    const runtime = delegationRuntimeDouble({ issueDelegationCredential, deriveDelegationToken });

    function primeContinueThenLoop(): MockManager {
      const parentState = makeState(PARENT_RUN_ID, { parentLinkage: undefined });
      const manager = makeManager(new Map([[parentState.id, parentState]]));
      wireMocks(manager, makeLifecycleService());
      jest.mocked(drainResolvedCompletions).mockResolvedValue({
        unresolved: 0,
        status: 'continue',
        applied: 1,
        state: parentState,
      });
      jest.mocked(runExecutionLoop).mockResolvedValue({ status: 'waiting' });
      return manager;
    }

    it('supplies the issuer to the drain and both capabilities to the loop for the bound run', async () => {
      primeContinueThenLoop();
      const advance = buildAdvanceInlineParent('/test', makeOutput(), undefined, {
        runId: PARENT_RUN_ID,
        runtime,
      });

      await advance({
        parentRunId: PARENT_RUN_ID,
        parentFrameKey: FRAME,
        parentEntry: 1,
        result: 'pass',
      });

      // The drain takes only the issuer, so that half is unpacked at the call
      // site — pinned by identity, which is what fails if the unpack drifts to
      // the wrong half of the pair.
      expect(drainResolvedCompletions).toHaveBeenCalledWith(
        expect.objectContaining({ issueDelegationCredential }),
      );
      // The loop needs both, so it receives the branded pair intact — the SAME
      // object, not an equal one. `objectContaining` compares structurally, so
      // it also passes against a pair reassembled from the same two halves
      // somewhere downstream; reference identity is what fails there, and a
      // reassembled pair is exactly the forwarding defect this pins.
      expect(runExecutionLoop).toHaveBeenCalledWith(
        expect.anything(),
        PARENT_RUN_ID,
        expect.anything(),
        '/test',
        expect.anything(),
        expect.anything(),
      );
      expect(jest.mocked(runExecutionLoop).mock.calls[0][5]?.delegationRuntime).toBe(runtime);
    });

    // The core seam recurses up an inline chain, invoking this same callable for
    // every ancestor. The bound authority owns exactly ONE run, and
    // `createDelegationTokenDeriver` refuses a descriptor issued by any other
    // claim — so an ancestor must be advanced with no capabilities rather than
    // with a stranger's.
    it('withholds the capabilities when the seam advances a different run', async () => {
      primeContinueThenLoop();
      const advance = buildAdvanceInlineParent('/test', makeOutput(), undefined, {
        runId: OTHER_RUN_ID,
        runtime,
      });

      await advance({
        parentRunId: PARENT_RUN_ID,
        parentFrameKey: FRAME,
        parentEntry: 1,
        result: 'pass',
      });

      expect(drainResolvedCompletions).toHaveBeenCalledWith(
        expect.objectContaining({ issueDelegationCredential: undefined }),
      );
      expect(runExecutionLoop).toHaveBeenCalledWith(
        expect.anything(),
        PARENT_RUN_ID,
        expect.anything(),
        '/test',
        expect.anything(),
        expect.objectContaining({ delegationRuntime: undefined }),
      );
    });
  });
});

describe('propagateChildTerminal run-scoped delegation runtime', () => {
  it('forwards the caller-supplied parent runtime into the seam deps', async () => {
    const issueDelegationCredential = mockFn<
      () => never
    >() as unknown as DelegationCredentialIssuer;
    const deriveDelegationToken = mockFn<() => string>() as unknown as DelegationTokenDeriver;
    const runtime = delegationRuntimeDouble({ issueDelegationCredential, deriveDelegationToken });
    const childState = makeState(CHILD_RUN_ID, { parentLinkage: makeInlineLinkage() });
    const manager = makeManager(new Map([[CHILD_RUN_ID, childState]]));
    wireMocks(manager, makeLifecycleService());
    propagateTerminalChildUpward.mockResolvedValue({ kind: 'handled' });

    await propagateChildTerminal(childState, 'pass', '/test', makeOutput(), undefined, {
      runId: PARENT_RUN_ID,
      runtime,
    });

    // The runtime reaches the seam through the CLI-supplied advance callable, so
    // assert it is honoured by driving that callable for the bound run.
    const deps = propagateTerminalChildUpward.mock.calls[0][0] as {
      advanceInlineParent: (input: {
        parentRunId: typeof PARENT_RUN_ID;
        parentFrameKey: FrameKey;
        parentEntry: number;
        result: 'pass';
      }) => Promise<unknown>;
    };
    const parentState = makeState(PARENT_RUN_ID, { parentLinkage: undefined });
    manager.load.mockResolvedValue(parentState);
    jest.mocked(drainResolvedCompletions).mockResolvedValue({
      unresolved: 0,
      status: 'continue',
      applied: 1,
      state: parentState,
    });
    jest.mocked(runExecutionLoop).mockResolvedValue({ status: 'waiting' });

    await deps.advanceInlineParent({
      parentRunId: PARENT_RUN_ID,
      parentFrameKey: brandFrameKeyForTest('1|'),
      parentEntry: 1,
      result: 'pass',
    });

    expect(drainResolvedCompletions).toHaveBeenCalledWith(
      expect.objectContaining({ issueDelegationCredential }),
    );
    // Same identity contract as the bound-run case above: the caller-supplied
    // pair is forwarded, not reassembled, so it is pinned by reference rather
    // than by a structural matcher a clone would satisfy.
    expect(runExecutionLoop).toHaveBeenCalledWith(
      expect.anything(),
      PARENT_RUN_ID,
      expect.anything(),
      '/test',
      expect.anything(),
      expect.anything(),
    );
    expect(jest.mocked(runExecutionLoop).mock.calls[0][5]?.delegationRuntime).toBe(runtime);
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
    propagateTerminalChildUpward.mockResolvedValue({ kind: 'handled' });
    const result = await propagateDrivenRunTerminal(
      manager as unknown as RunbookStateManagerType,
      CHILD_RUN_ID,
      '/test',
      output,
      LOOP_INFERRED,
    );
    expect(result).toEqual({
      kind: 'inline-advanced',
      parentRunId: PARENT_RUN_ID,
      result: 'handled',
    });
  });

  it('lifts an inline-advanced STOP terminal as { inline-advanced, stopped }', async () => {
    const child = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeInlineLinkage(),
    });
    const manager = makeManager(new Map([[child.id, child]]));
    const output = makeOutput();
    propagateTerminalChildUpward.mockResolvedValue({ kind: 'stopped' });
    const result = await propagateDrivenRunTerminal(
      manager as unknown as RunbookStateManagerType,
      CHILD_RUN_ID,
      '/test',
      output,
      LOOP_INFERRED,
    );
    expect(result).toEqual({
      kind: 'inline-advanced',
      parentRunId: PARENT_RUN_ID,
      result: 'stopped',
    });
  });

  it('lifts an inline-advanced blocked terminal as { inline-advanced, blocked }', async () => {
    const child = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeInlineLinkage(),
    });
    const manager = makeManager(new Map([[child.id, child]]));
    const output = makeOutput();
    propagateTerminalChildUpward.mockResolvedValue({ kind: 'blocked' });
    const result = await propagateDrivenRunTerminal(
      manager as unknown as RunbookStateManagerType,
      CHILD_RUN_ID,
      '/test',
      output,
      LOOP_INFERRED,
    );
    expect(result).toEqual({
      kind: 'inline-advanced',
      parentRunId: PARENT_RUN_ID,
      result: 'blocked',
    });
  });

  it('reports a terminal delegation child through the seam', async () => {
    const child = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeDelegationLinkage(),
    });
    const manager = makeManager(new Map([[child.id, child]]));
    const output = makeOutput();
    propagateTerminalChildUpward.mockResolvedValue({ kind: 'reported' });
    const result = await propagateDrivenRunTerminal(
      manager as unknown as RunbookStateManagerType,
      CHILD_RUN_ID,
      '/test',
      output,
      LOOP_INFERRED,
    );
    expect(result).toEqual({ kind: 'delegation-reported', result: 'reported' });
  });

  it('forwards an explicit-result trigger into the seam call (pass/fail commands)', async () => {
    // Correction 1 + SHOULD-FIX 5: an explicit-result trigger overrides lifecycle
    // inference. The authored 'pass' is forwarded into the adapter and on into the
    // seam, even though the child is lifecycle 'stopped'.
    const child = makeState(CHILD_RUN_ID, {
      lifecycle: 'stopped',
      parentLinkage: makeDelegationLinkage(),
    });
    const manager = makeManager(new Map([[child.id, child]]));
    const output = makeOutput();
    propagateTerminalChildUpward.mockResolvedValue({ kind: 'reported' });
    const result = await propagateDrivenRunTerminal(
      manager as unknown as RunbookStateManagerType,
      CHILD_RUN_ID,
      '/test',
      output,
      { kind: 'explicit-result', result: 'pass' },
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
    expect(
      propagationRequiresFailureExit({
        kind: 'inline-advanced',
        parentRunId: PARENT_RUN_ID,
        result: 'stopped',
      }),
    ).toBe(true);
    expect(
      propagationRequiresFailureExit({
        kind: 'inline-advanced',
        parentRunId: PARENT_RUN_ID,
        result: 'blocked',
      }),
    ).toBe(true);
  });

  it('returns false for an inline-advanced handled/not-applicable propagation', () => {
    expect(
      propagationRequiresFailureExit({
        kind: 'inline-advanced',
        parentRunId: PARENT_RUN_ID,
        result: 'handled',
      }),
    ).toBe(false);
    expect(
      propagationRequiresFailureExit({
        kind: 'inline-advanced',
        parentRunId: PARENT_RUN_ID,
        result: 'not-applicable',
      }),
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
    expect(
      inlineAdvanceRequiresFailureExit({
        kind: 'inline-advanced',
        parentRunId: PARENT_RUN_ID,
        result: 'stopped',
      }),
    ).toBe(true);
    expect(
      inlineAdvanceRequiresFailureExit({
        kind: 'inline-advanced',
        parentRunId: PARENT_RUN_ID,
        result: 'blocked',
      }),
    ).toBe(true);
  });

  it('returns false for an inline-advanced handled/not-applicable propagation', () => {
    expect(
      inlineAdvanceRequiresFailureExit({
        kind: 'inline-advanced',
        parentRunId: PARENT_RUN_ID,
        result: 'handled',
      }),
    ).toBe(false);
    expect(
      inlineAdvanceRequiresFailureExit({
        kind: 'inline-advanced',
        parentRunId: PARENT_RUN_ID,
        result: 'not-applicable',
      }),
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
