import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { mockErrorHelpers } from './mock-error-helpers.js';
import { mockFn } from './typed-mocks.js';
import type {
  ActionType,
  ClaimId,
  ClaimLookupKey,
  ClaimRecord,
  CommandTargetResolution,
  DelegationTokenHash,
  EffectfulActorMutationRunner,
  ExecutionEpoch,
  FrameKey,
  LifecycleTransitionOutcome,
  RunId,
  RunbookState,
  TransitionObservationEvent,
} from '@rundown-org/core';
import type { ResolvedStep } from '@rundown-org/parser';
import { makeClaimRecord } from '@rundown-org/core/testing/claim-fixtures';
import type { OutputEmitter } from '../../src/services/output-emitter.js';

// The unit-under-test (runSeamTransition, renderRefusal, renderApplied,
// buildActionSink, renderTransitionEvents, the config + emit helpers,
// buildTransitionContext) is only reachable from the CLI command layer through a
// *dynamic* `import('../cli.js')` in the in-process CLI runner. Because Stryker
// scopes each mutant to its *static* importers, the pass/fail integration suites
// never count toward this module's mutation score. This suite statically imports
// transitions.ts and drives the seam through structural core doubles so those
// branches — including the correctness-critical result→action mapping and the
// typed-refusal render table — are pinned directly.

const PARENT_RUN_ID = 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as RunId;
const CHILD_RUN_ID = 'rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as RunId;
const TEST_CLAIM_ID =
  'rdclm_11111111111111111111111111111111_abcdefghijklmnopqrstuvwxyzABCDE1234567890-_' as ClaimId;
const TEST_CLAIM_KEY = 'rdclk_11111111111111111111111111111111' as ClaimLookupKey;
// Branded by cast like the ids above: core is mocked in this suite, so
// `assertExecutionEpoch` is unavailable and only the value's identity matters.
const TEST_EPOCH = 4 as ExecutionEpoch;

const mockRunTransition = mockFn<(args: unknown) => Promise<LifecycleTransitionOutcome>>();
const mockManagerLoad = mockFn<(id: RunId) => Promise<RunbookState | null>>();
const mockResolveCommandTarget = mockFn<(...args: unknown[]) => Promise<CommandTargetResolution>>();
const mockResolveTransitionTarget = mockFn<(...args: unknown[]) => Promise<unknown>>();
const mockActorMutationRun = mockFn<EffectfulActorMutationRunner['run']>().mockResolvedValue({
  kind: 'execution_in_progress',
  runId: PARENT_RUN_ID,
  message: 'execution owned elsewhere',
});

jest.unstable_mockModule('@rundown-org/core', () => ({
  RunbookStateManager: jest.fn().mockImplementation(() => ({ load: mockManagerLoad })),
  RunbookActorService: jest.fn(),
  RunbookCompletionService: jest.fn(),
  DelegationScanService: jest.fn(),
  RunbookLifecycleCommandService: jest
    .fn()
    .mockImplementation(() => ({ runTransition: mockRunTransition })),
  SessionService: jest.fn().mockImplementation(() => ({})),
  ExecutionLifecycleService: jest.fn().mockImplementation(() => ({})),
  createEffectfulActorMutationRunner: jest.fn().mockReturnValue({
    run: mockActorMutationRun,
    runAll: jest.fn(),
  }),
  resolveCommandTarget: mockResolveCommandTarget,
  resolveTransitionTarget: mockResolveTransitionTarget,
  // `refusal-renderers.ts` (via transitions.ts) redacts claim ids for output
  // through this seam; the confirmed-claim outcome carries TEST_CLAIM_ID.
  redactClaimId: mockFn<(id: ClaimId) => ClaimLookupKey>().mockReturnValue(TEST_CLAIM_KEY),
  claimKeyFromBearer: mockFn<(id: ClaimId) => ClaimLookupKey>().mockReturnValue(TEST_CLAIM_KEY),
  // `formatTransitionAction` is echoed into the buffered action object; the mock
  // returns a sentinel so we can assert the sink forwards the derived label.
  formatTransitionAction: mockFn<(action: ActionType) => string>().mockReturnValue('ACTION_LABEL'),
  // resolveManualCompletionCursor collaborators (only the --step path uses them).
  parseStepIdFromString: mockFn<(input: string) => unknown>().mockReturnValue({
    step: '1',
    substep: '1',
  }),
  buildFrameKey: mockFn<(step: string, iteration?: number) => string>().mockImplementation(
    (step, iteration) => (iteration !== undefined ? `${step}[${String(iteration)}]` : step),
  ),
  deriveExecutionAt:
    mockFn<(step: string, substep?: string, iteration?: number) => string>().mockReturnValue('1.1'),
  deriveActiveFrame: mockFn<
    (state: RunbookState) => { step: string; iteration?: number; frameKey: string }
  >().mockReturnValue({ step: '1', iteration: undefined, frameKey: '1' }),
  activeFrame: mockFn<
    (frameKey: string, entry: number) => { kind: 'active'; frameKey: string; entry: number }
  >().mockImplementation((frameKey, entry) => ({ kind: 'active', frameKey, entry })),
  inactiveFrame: mockFn<
    (frameKey: string) => { kind: 'inactive'; frameKey: string }
  >().mockImplementation((frameKey) => ({ kind: 'inactive', frameKey })),
  logger: { warn: mockFn<(...args: unknown[]) => void>() },
  ...mockErrorHelpers,
}));

jest.unstable_mockModule('@rundown-org/parser', () => ({
  resolvedStepHasSubsteps: mockFn<(step: ResolvedStep) => boolean>().mockReturnValue(true),
}));

jest.unstable_mockModule('../../src/helpers/actor-service-factory', () => ({
  createCliRunbookActorService: mockFn<() => Record<string, unknown>>().mockReturnValue({}),
}));

jest.unstable_mockModule('../../src/helpers/runbook-loader', () => ({
  getRunbookFromState: mockFn<() => readonly ResolvedStep[]>().mockReturnValue([]),
}));

const mockReadCallerEvidence = mockFn<(input?: { claimId?: ClaimId }) => unknown>();
jest.unstable_mockModule('../../src/helpers/caller-evidence', () => ({
  readLifecycleCallerEvidence: mockReadCallerEvidence,
}));

const mockRunExecutionLoop =
  mockFn<(...args: unknown[]) => Promise<string>>().mockResolvedValue('done');
const mockFindStepOrThrow =
  mockFn<(steps: readonly ResolvedStep[], name: string) => ResolvedStep>();
jest.unstable_mockModule('../../src/services/execution', () => ({
  findStepOrThrow: mockFindStepOrThrow,
  runExecutionLoop: mockRunExecutionLoop,
}));

jest.unstable_mockModule('../../src/helpers/execution-emitter', () => ({
  createBridgedEmitter: mockFn<() => Record<string, unknown>>().mockReturnValue({
    emit: jest.fn(),
  }),
}));

// A structural sink whose methods are jest fns so renderTransitionEvents can
// dispatch through the manual-completion (emitter-bridged) path without throwing.
const mockManualSink = {
  onErrorOccurred: mockFn<(payload: unknown) => void>(),
  onStepTransitioned: mockFn<(payload: unknown) => void>(),
  onRunbookCompleted: mockFn<(payload: unknown) => void>(),
  onRunbookStopped: mockFn<(payload: unknown) => void>(),
};
jest.unstable_mockModule('../../src/helpers/transition-orchestrator', () => ({
  transitionSinkFromEmitter: mockFn<() => typeof mockManualSink>().mockReturnValue(mockManualSink),
}));

const { getRunbookFromState } = await import('../../src/helpers/runbook-loader.js');
const {
  runSeamTransition,
  createPassTransitionConfig,
  createFailTransitionConfig,
  emitOpenDelegatedChildrenError,
  emitDelegationCollectionPendingError,
  buildTransitionContext,
} = await import('../../src/helpers/transitions.js');

interface MockOutput {
  error: jest.Mock<(message: string, code?: string, details?: unknown) => void>;
  noActiveRunbook: jest.Mock<(command?: string) => void>;
  json: jest.Mock<(data: unknown) => void>;
  message: jest.Mock<(text: string) => void>;
  action: jest.Mock<(block: unknown) => void>;
  complete: jest.Mock<(message?: string, position?: unknown) => void>;
  stopped: jest.Mock<(message?: string, position?: unknown) => void>;
  status: jest.Mock<(action: string, message?: string, data?: unknown) => void>;
  warning: jest.Mock<(text: string) => void>;
  isJson: jest.Mock<() => boolean>;
  flush: jest.Mock<() => void>;
}

function makeOutput(json = true): MockOutput & OutputEmitter {
  return {
    error: mockFn<(message: string, code?: string, details?: unknown) => void>(),
    noActiveRunbook: mockFn<(command?: string) => void>(),
    json: mockFn<(data: unknown) => void>(),
    message: mockFn<(text: string) => void>(),
    action: mockFn<(block: unknown) => void>(),
    complete: mockFn<(message?: string, position?: unknown) => void>(),
    stopped: mockFn<(message?: string, position?: unknown) => void>(),
    status: mockFn<(action: string, message?: string, data?: unknown) => void>(),
    warning: mockFn<(text: string) => void>(),
    isJson: mockFn<() => boolean>().mockReturnValue(json),
    flush: mockFn<() => void>(),
  } as unknown as MockOutput & OutputEmitter;
}

function claimRecord(): ClaimRecord {
  return makeClaimRecord({
    claimKey: TEST_CLAIM_KEY,
    controlledRunId: CHILD_RUN_ID,
    delegation: {
      childRunId: CHILD_RUN_ID,
      tokenHash: `sha256:${'a'.repeat(64)}` as DelegationTokenHash,
      parentRunId: PARENT_RUN_ID,
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: '1' as FrameKey,
      parentEntry: 1,
    },
    grants: [],
  });
}

function makeState(overrides: Record<string, unknown> = {}): RunbookState {
  return {
    id: PARENT_RUN_ID,
    step: '1',
    substep: undefined,
    activeEntry: 1,
    activeFrameKey: '1',
    ...overrides,
  } as unknown as RunbookState;
}

function stepEvent(
  overrides: Partial<Record<string, unknown>> = {},
): Extract<TransitionObservationEvent, { type: 'STEP_TRANSITIONED' }> {
  return {
    type: 'STEP_TRANSITIONED',
    payload: {
      action: 'CONTINUE',
      from: '1',
      at: '2',
      result: 'PASS',
      ...overrides,
    },
  } as unknown as Extract<TransitionObservationEvent, { type: 'STEP_TRANSITIONED' }>;
}

function appliedOutcome(
  overrides: Partial<Extract<LifecycleTransitionOutcome, { kind: 'applied' }>> = {},
): LifecycleTransitionOutcome {
  return {
    kind: 'applied',
    runId: PARENT_RUN_ID,
    mutation: 'run-transition',
    status: 'continue',
    events: [],
    loop: { kind: 'none' },
    ...overrides,
  } as unknown as LifecycleTransitionOutcome;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockReadCallerEvidence.mockReturnValue({ kind: 'direct_cli' });
  mockManagerLoad.mockResolvedValue(makeState());
  jest.mocked(getRunbookFromState).mockReturnValue([]);
  mockRunExecutionLoop.mockResolvedValue('done');
});

// ACCEPTED MUTATION SURVIVORS in transitions.ts (#485).
//
//  - The `default:` arm of `renderRefusal`'s switch (`transitions.ts:512`),
//    `ConditionalExpression` + `BlockStatement`. Unreachable by construction: it
//    binds `const _exhaustive: never = outcome`, so reaching it is a compile
//    error rather than a runtime state.
//  - `case 'unknown_run':` (`transitions.ts:497`), `ConditionalExpression`.
//    Equivalent: the adjacent `case 'missing':` emits the identical
//    `RUN_TARGET_UNAVAILABLE` envelope, so a mutant merging the two arms
//    produces the same output for every input. Both are covered below; the
//    survivor reflects that core, not the CLI, is where the two kinds differ.

describe('createPassTransitionConfig', () => {
  it('maps RETRY and STOP results to a false action-result but CONTINUE/NEXT to true', () => {
    const config = createPassTransitionConfig();
    expect(config.eventType).toBe('PASS');
    expect(config.commandName).toBe('pass');
    expect(config.lastResult).toBe('pass');
    // Correctness-critical: pass action-result depends on the action type.
    expect(config.computeActionResult('RETRY')).toBe(false);
    expect(config.computeActionResult('STOP')).toBe(false);
    expect(config.computeActionResult('CONTINUE')).toBe(true);
    expect(config.computeActionResult('NEXT')).toBe(true);
    expect(config.computeActionResult('COMPLETE')).toBe(true);
    expect(config.policy).toEqual({ releaseOnTerminal: true });
  });
});

describe('createFailTransitionConfig', () => {
  it('always maps the action-result to false regardless of action type', () => {
    const config = createFailTransitionConfig();
    expect(config.eventType).toBe('FAIL');
    expect(config.commandName).toBe('fail');
    expect(config.lastResult).toBe('fail');
    expect(config.computeActionResult('CONTINUE')).toBe(false);
    expect(config.computeActionResult('RETRY')).toBe(false);
    expect(config.computeActionResult('STOP')).toBe(false);
    expect(config.policy).toEqual({ releaseOnTerminal: true });
  });
});

describe('emitOpenDelegatedChildrenError', () => {
  it('emits OPEN_DELEGATED_CHILDREN with structured details', () => {
    const output = makeOutput();
    emitOpenDelegatedChildrenError(output, 'pass', PARENT_RUN_ID, [TEST_CLAIM_KEY], [CHILD_RUN_ID]);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.error).toHaveBeenCalledTimes(1);
    const [message, code, details] = output.error.mock.calls[0];
    expect(message).toContain('Cannot run bare rundown pass');
    expect(message).toContain(TEST_CLAIM_KEY);
    expect(message).toContain('--claim-id');
    expect(code).toBe('OPEN_DELEGATED_CHILDREN');
    expect(details).toEqual({
      command: 'pass',
      parentRunId: PARENT_RUN_ID,
      claimIds: [TEST_CLAIM_KEY],
      childRunIds: [CHILD_RUN_ID],
    });
  });
});

describe('emitDelegationCollectionPendingError', () => {
  it('emits DELEGATION_COLLECTION_PENDING with the core message and keys', () => {
    const output = makeOutput();
    emitDelegationCollectionPendingError(
      output,
      'fail',
      PARENT_RUN_ID,
      ['1|1|'],
      'Delegated outcome pending.',
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.error).toHaveBeenCalledTimes(1);
    const [message, code, details] = output.error.mock.calls[0];
    expect(message).toContain('Cannot run bare rundown fail');
    expect(message).toContain('Delegated outcome pending.');
    expect(message).toContain('rundown collect');
    expect(code).toBe('DELEGATION_COLLECTION_PENDING');
    expect(details).toEqual({
      command: 'fail',
      parentRunId: PARENT_RUN_ID,
      outcomeCompletionKeys: ['1|1|'],
    });
  });
});

describe('buildTransitionContext', () => {
  it('resolves a claim target and surfaces the claim', async () => {
    const output = makeOutput();
    mockResolveCommandTarget.mockResolvedValue({
      kind: 'claim',
      state: makeState({ id: CHILD_RUN_ID }),
      claim: claimRecord(),
    } as unknown as CommandTargetResolution);

    const result = await buildTransitionContext(output, '/cwd', { claimId: TEST_CLAIM_ID });

    expect(result.kind).toBe('ready');
    if (result.kind === 'ready') {
      expect(result.ctx.claim).toBeDefined();
    }
  });

  it('resolves a default target with no claim', async () => {
    const output = makeOutput();
    mockResolveCommandTarget.mockResolvedValue({
      kind: 'default',
      state: makeState(),
    } as unknown as CommandTargetResolution);

    const result = await buildTransitionContext(output, '/cwd');

    expect(result.kind).toBe('ready');
    if (result.kind === 'ready') {
      expect(result.ctx.claim).toBeUndefined();
    }
  });

  it('passes a "none" refusal straight through without building a context', async () => {
    const output = makeOutput();
    mockResolveCommandTarget.mockResolvedValue({
      kind: 'none',
    } as unknown as CommandTargetResolution);

    const result = await buildTransitionContext(output, '/cwd');

    expect(result.kind).toBe('none');
  });

  it('passes a stale_claim refusal straight through', async () => {
    const output = makeOutput();
    mockResolveCommandTarget.mockResolvedValue({
      kind: 'stale_claim',
      claimId: TEST_CLAIM_ID,
      message: 'stale',
    } as unknown as CommandTargetResolution);

    const result = await buildTransitionContext(output, '/cwd', { claimId: TEST_CLAIM_ID });

    expect(result.kind).toBe('stale_claim');
  });

  it('passes a terminal_claim refusal straight through', async () => {
    const output = makeOutput();
    mockResolveCommandTarget.mockResolvedValue({
      kind: 'terminal_claim',
    } as unknown as CommandTargetResolution);

    const result = await buildTransitionContext(output, '/cwd', { claimId: TEST_CLAIM_ID });

    expect(result.kind).toBe('terminal_claim');
  });
});

describe('runSeamTransition — explicit --step target resolution', () => {
  it('forwards a raw --step explicitTarget and an explicit-step selector without resolving CLI-side', async () => {
    const output = makeOutput();
    // Under #500 the CLI performs no cursor resolution: it forwards the raw step
    // id as an explicitTarget and the seam derives the completion cursor in-core,
    // inside its guarded compute-and-commit cycle. resolveTransitionTarget is
    // never called on the CLI side (it now lives behind the seam).
    mockRunTransition.mockResolvedValue(appliedOutcome());

    const result = await runSeamTransition(output, '/cwd', createPassTransitionConfig(), {
      step: '1.1',
    });

    const runArgs = mockRunTransition.mock.calls[0][0] as Record<string, unknown>;
    expect(runArgs.targetSelector).toEqual({ kind: 'explicit-step', step: '1.1' });
    // toStrictEqual (not toEqual): a bare --step must forward NO `iteration` key
    // at all. toEqual treats `{ stepId, iteration: undefined }` as equal to
    // `{ stepId }`, which lets the always-spread mutation of the iteration
    // ternary survive; strict equality pins the optional-iteration branch.
    expect(runArgs.explicitTarget).toStrictEqual({ stepId: '1.1' });
    expect(mockResolveTransitionTarget).not.toHaveBeenCalled();
    expect(result.applied).toBeDefined();
  });

  it('carries the pre-parsed --index iteration on the forwarded explicitTarget', async () => {
    const output = makeOutput();
    // A numeric --index is pre-parsed CLI-side (Category-A) and rides on the raw
    // explicitTarget as `iteration`; pins the optional-iteration spread so the
    // frontend cannot silently drop the caller's iteration.
    mockRunTransition.mockResolvedValue(appliedOutcome());

    await runSeamTransition(output, '/cwd', createPassTransitionConfig(), {
      step: '1.1',
      index: '3',
    });

    const runArgs = mockRunTransition.mock.calls[0][0] as Record<string, unknown>;
    expect(runArgs.explicitTarget).toStrictEqual({ stepId: '1.1', iteration: 3 });
    expect(runArgs.targetSelector).toEqual({ kind: 'explicit-step', step: '1.1' });
  });

  it('still forwards the explicitTarget when the seam refuses, and renders the typed refusal', async () => {
    const output = makeOutput();
    // The explicitTarget is built from the raw --step BEFORE the seam call, so a
    // seam refusal (kind 'none') still carries it; the CLI renders the typed
    // refusal and requests no error exit.
    mockRunTransition.mockResolvedValue({ kind: 'none' });

    const result = await runSeamTransition(output, '/cwd', createFailTransitionConfig(), {
      step: '1.1',
    });

    const runArgs = mockRunTransition.mock.calls[0][0] as Record<string, unknown>;
    expect(runArgs.targetSelector).toEqual({ kind: 'explicit-step', step: '1.1' });
    expect(runArgs.explicitTarget).toStrictEqual({ stepId: '1.1' });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.noActiveRunbook).toHaveBeenCalledWith('fail');
    expect(result.exitError).toBe(false);
  });

  it('uses a claim selector when both --step and --claim-id are supplied', async () => {
    const output = makeOutput();
    mockResolveTransitionTarget.mockResolvedValue({ kind: 'none' });
    mockRunTransition.mockResolvedValue({ kind: 'none' });

    await runSeamTransition(output, '/cwd', createPassTransitionConfig(), {
      step: '1.1',
      claimId: TEST_CLAIM_ID,
    });

    const runArgs = mockRunTransition.mock.calls[0][0] as Record<string, unknown>;
    expect(runArgs.targetSelector).toEqual({ kind: 'claim', claimId: TEST_CLAIM_ID });
    // Caller evidence is built from the SAME `--claim-id` that named the target.
    // The seam reconciles the two and refuses a divergence (#613), so a frontend
    // that sourced them independently would refuse every claim-targeted
    // transition at runtime; pin the coupling here, where drift would originate.
    expect(mockReadCallerEvidence).toHaveBeenCalledWith({ claimId: TEST_CLAIM_ID });
  });

  it('uses a claim selector for a bare --claim-id transition without --step', async () => {
    const output = makeOutput();
    mockRunTransition.mockResolvedValue({ kind: 'none' });

    await runSeamTransition(output, '/cwd', createPassTransitionConfig(), {
      claimId: TEST_CLAIM_ID,
    });

    const runArgs = mockRunTransition.mock.calls[0][0] as Record<string, unknown>;
    expect(runArgs.targetSelector).toEqual({ kind: 'claim', claimId: TEST_CLAIM_ID });
    expect(mockReadCallerEvidence).toHaveBeenCalledWith({ claimId: TEST_CLAIM_ID });
    expect(mockResolveTransitionTarget).not.toHaveBeenCalled();
  });

  it('selects the default target when neither --step nor --claim-id is supplied', async () => {
    const output = makeOutput();
    mockRunTransition.mockResolvedValue({ kind: 'none' });

    // A bare transition must target the default stack — never fall through to a
    // claim selector or an empty/mistyped selector (pins the else-branch default
    // against the claim/explicit-step branches so target selection can't silently
    // change for a bare pass/fail).
    await runSeamTransition(output, '/cwd', createPassTransitionConfig());

    const runArgs = mockRunTransition.mock.calls[0][0] as Record<string, unknown>;
    expect(runArgs.targetSelector).toEqual({ kind: 'default' });
    // The other half of the #613 coupling: with no `--claim-id`, the evidence
    // builder is handed no bearer, so a bare transition can never present one.
    expect(mockReadCallerEvidence).toHaveBeenCalledWith({});
    expect(mockResolveTransitionTarget).not.toHaveBeenCalled();
  });
});

describe('runSeamTransition — refusal render table', () => {
  it('renders the no-active-runbook refusal without an error exit', async () => {
    const output = makeOutput();
    mockRunTransition.mockResolvedValue({ kind: 'none' });

    const result = await runSeamTransition(output, '/cwd', createPassTransitionConfig());

    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.noActiveRunbook).toHaveBeenCalledWith('pass');
    expect(result.applied).toBeUndefined();
    expect(result.exitError).toBe(false);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.flush).toHaveBeenCalled();
  });

  it('renders a stale claim refusal with a non-zero exit', async () => {
    const output = makeOutput();
    mockRunTransition.mockResolvedValue({
      kind: 'stale_claim',
      claimId: TEST_CLAIM_ID,
      message: 'claim gone',
      code: 'CLAIMED_RUNBOOK_UNAVAILABLE',
    });

    const result = await runSeamTransition(output, '/cwd', createFailTransitionConfig());

    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.error).toHaveBeenCalledWith('claim gone', 'CLAIMED_RUNBOOK_UNAVAILABLE');
    expect(result.exitError).toBe(true);
  });

  it('renders a superseded claim refusal as DELEGATION_SUPERSEDED', async () => {
    // pass/fail is the seam a delegated child reports through, so this is where
    // the no-retry code matters most: core assigns it, the seam must not
    // overwrite it with the generic unavailable envelope.
    const output = makeOutput();
    mockRunTransition.mockResolvedValue({
      kind: 'stale_claim',
      claimId: TEST_CLAIM_ID,
      message: 'parent moved past this delegation',
      code: 'DELEGATION_SUPERSEDED',
    });

    const result = await runSeamTransition(output, '/cwd', createFailTransitionConfig());

    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.error).toHaveBeenCalledWith(
      'parent moved past this delegation',
      'DELEGATION_SUPERSEDED',
    );
    expect(result.exitError).toBe(true);
  });

  it('renders a confirmed terminal claim as an idempotent JSON payload without error exit', async () => {
    const output = makeOutput(true);
    mockRunTransition.mockResolvedValue({
      kind: 'terminal_claim_confirmed',
      claimId: TEST_CLAIM_ID,
      lifecycle: 'completed',
      result: 'pass',
    });

    const result = await runSeamTransition(output, '/cwd', createPassTransitionConfig());

    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.json).toHaveBeenCalledWith({
      kind: 'action',
      action: 'pass',
      status: 'already-resolved',
      // Identity is the non-secret lookup key, never the bearer (credential leak).
      claimKey: TEST_CLAIM_KEY,
      lifecycle: 'completed',
    });
    expect(result.exitError).toBe(false);
  });

  it('renders a confirmed terminal claim as a text message when not in JSON mode', async () => {
    const output = makeOutput(false);
    mockRunTransition.mockResolvedValue({
      kind: 'terminal_claim_confirmed',
      claimId: TEST_CLAIM_ID,
      lifecycle: 'stopped',
      result: 'fail',
    });

    await runSeamTransition(output, '/cwd', createFailTransitionConfig());

    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.json).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.message).toHaveBeenCalledTimes(1);
    expect(output.message.mock.calls[0][0]).toContain('ALREADY FAIL');
  });

  it('renders a terminal claim conflict with a non-zero exit', async () => {
    const output = makeOutput();
    mockRunTransition.mockResolvedValue({
      kind: 'terminal_claim_conflict',
      claimId: TEST_CLAIM_ID,
      lifecycle: 'completed',
      expectedResult: 'pass',
      requestedResult: 'fail',
    });

    const result = await runSeamTransition(output, '/cwd', createFailTransitionConfig());

    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.error).toHaveBeenCalledTimes(1);
    const [message, code] = output.error.mock.calls[0];
    expect(message).toContain('already resolved as pass');
    expect(message).toContain('cannot fail');
    expect(code).toBe('DELEGATION_RESULT_CONFLICT');
    expect(result.exitError).toBe(true);
  });

  it('renders the open-delegated-children refusal derived from the outcome claims', async () => {
    const output = makeOutput();
    mockRunTransition.mockResolvedValue({
      kind: 'open_delegated_children',
      parentRunId: PARENT_RUN_ID,
      claims: [claimRecord()],
    });

    const result = await runSeamTransition(output, '/cwd', createPassTransitionConfig());

    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.error).toHaveBeenCalledTimes(1);
    const [, code, details] = output.error.mock.calls[0];
    expect(code).toBe('OPEN_DELEGATED_CHILDREN');
    expect(details).toEqual({
      command: 'pass',
      parentRunId: PARENT_RUN_ID,
      claimIds: [TEST_CLAIM_KEY],
      childRunIds: [CHILD_RUN_ID],
    });
    expect(result.exitError).toBe(true);
  });

  it('renders the delegation-collection-pending refusal', async () => {
    const output = makeOutput();
    mockRunTransition.mockResolvedValue({
      kind: 'delegation_collection_pending',
      parentRunId: PARENT_RUN_ID,
      outcomeCompletionKeys: ['1|1|'],
      message: 'pending',
    } as unknown as LifecycleTransitionOutcome);

    const result = await runSeamTransition(output, '/cwd', createPassTransitionConfig());

    const [, code, details] = output.error.mock.calls[0];
    expect(code).toBe('DELEGATION_COLLECTION_PENDING');
    expect(details).toEqual({
      command: 'pass',
      parentRunId: PARENT_RUN_ID,
      outcomeCompletionKeys: ['1|1|'],
    });
    expect(result.exitError).toBe(true);
  });

  it('renders the actor-context-required refusal without echoing the target run id', async () => {
    const output = makeOutput();
    mockRunTransition.mockResolvedValue({
      kind: 'actor_context_required',
    });

    const result = await runSeamTransition(output, '/cwd', createFailTransitionConfig());

    const [message, code, details] = output.error.mock.calls[0];
    expect(code).toBe('ACTOR_CONTEXT_REQUIRED');
    // The remediation names the bearer-authority lane.
    expect(message).toContain('--claim-id');
    expect(message).toContain('rundown fail');
    // ...and never hands the id back: no details object, no run id anywhere
    // in the envelope (accident barrier, decision 4).
    expect(details).toBeUndefined();
    expect(JSON.stringify(output.error.mock.calls[0])).not.toContain(PARENT_RUN_ID);
    expect(result.exitError).toBe(true);
  });

  it('renders a bearer divergence under its own code, not the bare-form advice (#613)', async () => {
    const output = makeOutput();
    mockRunTransition.mockResolvedValue({
      kind: 'claim_bearer_mismatch',
    });

    const result = await runSeamTransition(output, '/cwd', createFailTransitionConfig());

    const [message, code, details] = output.error.mock.calls[0];
    expect(code).toBe('CLAIM_BEARER_MISMATCH');
    expect(code).not.toBe('ACTOR_CONTEXT_REQUIRED');
    // The whole point of the split: this caller DID present a claim id, so the
    // bare-form remediation would misdiagnose it. Assert the wrong advice is
    // absent, not merely that the right advice is present.
    expect(message).not.toContain('Pass `--claim-id');
    expect(message).toContain('rundown fail');
    expect(message).toContain('targeting');
    // Names neither claim: the seam refuses before resolving either one, so
    // there is no non-secret claimKey to echo and a raw claimId would leak a
    // bearer into output.
    expect(details).toBeUndefined();
    expect(JSON.stringify(output.error.mock.calls[0])).not.toContain(PARENT_RUN_ID);
    expect(result.exitError).toBe(true);
  });

  it('renders the claim-grant-required refusal with the specific error code', async () => {
    const output = makeOutput();
    mockRunTransition.mockResolvedValue({
      kind: 'claim_grant_required',
      claimId: TEST_CLAIM_ID,
      runId: PARENT_RUN_ID,
    });

    const result = await runSeamTransition(output, '/cwd', createPassTransitionConfig());

    const [, code] = output.error.mock.calls[0];
    expect(code).toBe('CLAIM_GRANT_REQUIRED');
    expect(result.exitError).toBe(true);
  });

  // The fenced-mutation refusals. Core owns the discriminants; the seam owns the
  // symbolic code an agent branches on, and each arm maps to a DIFFERENT code —
  // so a table that only asserted `exitError` would pass with every arm folded
  // into one envelope.
  //
  // Each outcome is typed as the concrete union member rather than cast, so the
  // fixtures are checked against the contract they stand in for: only
  // `recovery_required` carries an epoch, and a row that drifted from core's
  // shape would fail to compile instead of silently testing a shape core never
  // produces.
  it.each<{
    readonly label: string;
    readonly outcome: Extract<
      LifecycleTransitionOutcome,
      {
        kind:
          | 'missing'
          | 'claim_superseded'
          | 'concurrent_modification'
          | 'unknown_run'
          | 'execution_in_progress'
          | 'recovery_required';
      }
    >;
    readonly code: string;
  }>([
    {
      label: 'a vanished run target',
      outcome: { kind: 'missing', runId: PARENT_RUN_ID, message: 'Run rd_… does not exist.' },
      code: 'RUN_TARGET_UNAVAILABLE',
    },
    {
      label: 'a superseded claim',
      outcome: {
        kind: 'claim_superseded',
        runId: PARENT_RUN_ID,
        message: 'A newer claim controls this run.',
      },
      code: 'STALE_CLAIM',
    },
    {
      label: 'a concurrent state change',
      outcome: {
        kind: 'concurrent_modification',
        runId: PARENT_RUN_ID,
        message: 'The run changed while this command was deciding.',
      },
      code: 'CONCURRENT_MODIFICATION',
    },
    {
      label: 'an unknown run selector',
      outcome: {
        kind: 'unknown_run',
        runId: PARENT_RUN_ID,
        message: 'No run matches that selector.',
      },
      code: 'RUN_TARGET_UNAVAILABLE',
    },
    {
      label: 'an in-flight execution',
      outcome: {
        kind: 'execution_in_progress',
        runId: PARENT_RUN_ID,
        message: 'Another actor owns this run.',
      },
      code: 'EXECUTION_IN_PROGRESS',
    },
    {
      label: 'an interrupted execution',
      outcome: {
        kind: 'recovery_required',
        runId: PARENT_RUN_ID,
        epoch: TEST_EPOCH,
        message: 'The execution outcome is unknown and requires recovery.',
      },
      code: 'RECOVERY_REQUIRED',
    },
  ])('renders $label as $code', async ({ outcome, code }) => {
    const output = makeOutput();
    mockRunTransition.mockResolvedValue(outcome);

    const result = await runSeamTransition(output, '/cwd', createPassTransitionConfig());

    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.error).toHaveBeenCalledWith(outcome.message, code);
    expect(result.exitError).toBe(true);
  });
});

describe('runSeamTransition — applied render (buildActionSink / renderTransitionEvents)', () => {
  it('renders a run-transition STEP_TRANSITIONED event as a buffered action block', async () => {
    const output = makeOutput();
    mockRunTransition.mockResolvedValue(
      appliedOutcome({
        events: [stepEvent({ command: 'pass', forIndex: 2, forEnd: 5 })],
      }),
    );

    const result = await runSeamTransition(output, '/cwd', createPassTransitionConfig());

    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.action).toHaveBeenCalledTimes(1);
    const block = output.action.mock.calls[0][0] as Record<string, unknown>;
    expect(block.action).toBe('ACTION_LABEL');
    expect(block.from).toBe('1');
    expect(block.at).toBe('2');
    expect(block.result).toBe('PASS');
    expect(block.forIndex).toBe(2);
    expect(block.forEnd).toBe(5);
    expect(block.command).toBe('pass');
    expect(result.applied).toEqual({ status: 'continue', runId: PARENT_RUN_ID });
    expect(result.exitError).toBe(false);
  });

  it('omits forIndex/forEnd from the action block for a non-FOR STEP_TRANSITIONED event', async () => {
    const output = makeOutput();
    mockRunTransition.mockResolvedValue(
      appliedOutcome({
        // No forIndex on the event → the buffered action must not carry forIndex
        // or forEnd (pins the `forIndex !== undefined ? {...} : {}` spread guard).
        events: [stepEvent({ command: 'pass' })],
      }),
    );

    await runSeamTransition(output, '/cwd', createPassTransitionConfig());

    const block = output.action.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.hasOwn(block, 'forIndex')).toBe(false);
    expect(Object.hasOwn(block, 'forEnd')).toBe(false);
  });

  it('renders a RUNBOOK_COMPLETED event via output.complete', async () => {
    const output = makeOutput();
    mockRunTransition.mockResolvedValue(
      appliedOutcome({
        status: 'done',
        events: [
          {
            type: 'RUNBOOK_COMPLETED',
            payload: { message: 'all done', finalPosition: { at: '2' } },
          } as unknown as TransitionObservationEvent,
        ],
      }),
    );

    await runSeamTransition(output, '/cwd', createPassTransitionConfig());

    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.complete).toHaveBeenCalledWith('all done', { at: '2' });
  });

  it('renders a RUNBOOK_STOPPED event via output.stopped and reports a stopped status exit', async () => {
    const output = makeOutput();
    mockRunTransition.mockResolvedValue(
      appliedOutcome({
        status: 'stopped',
        events: [
          {
            type: 'RUNBOOK_STOPPED',
            payload: { message: 'halted', position: { at: '1' } },
          } as unknown as TransitionObservationEvent,
        ],
      }),
    );

    const result = await runSeamTransition(output, '/cwd', createFailTransitionConfig());

    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.stopped).toHaveBeenCalledWith('halted', { at: '1' });
    expect(result.applied).toEqual({ status: 'stopped', runId: PARENT_RUN_ID });
    expect(result.exitError).toBe(true);
  });

  it('renders an ERROR_OCCURRED event via output.error', async () => {
    const output = makeOutput();
    mockRunTransition.mockResolvedValue(
      appliedOutcome({
        events: [
          {
            type: 'ERROR_OCCURRED',
            payload: { message: 'boom', code: 'RD-999' },
          } as unknown as TransitionObservationEvent,
        ],
      }),
    );

    await runSeamTransition(output, '/cwd', createPassTransitionConfig());

    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.error).toHaveBeenCalledWith('boom', 'RD-999');
  });

  it('emits an already-resolved status for a duplicate re-record', async () => {
    const output = makeOutput();
    mockRunTransition.mockResolvedValue(
      appliedOutcome({
        duplicate: { at: '1.1', frameKey: '1' as FrameKey, entry: 2 },
      }),
    );

    await runSeamTransition(output, '/cwd', createPassTransitionConfig());

    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.status).toHaveBeenCalledWith('pass', 'Completion already recorded for 1.1', {
      status: 'already-resolved',
      at: '1.1',
      frameKey: '1',
      entry: 2,
    });
  });

  it('drives the execution loop for a run directive and propagates a stopped loop result', async () => {
    const output = makeOutput();
    mockRunExecutionLoop.mockResolvedValue('stopped');
    mockRunTransition.mockResolvedValue(
      appliedOutcome({
        loop: { kind: 'run' },
      }),
    );

    const result = await runSeamTransition(output, '/cwd', createPassTransitionConfig());

    expect(mockRunExecutionLoop).toHaveBeenCalledTimes(1);
    const loopArgs = mockRunExecutionLoop.mock.calls[0];
    // The output is forwarded, and NO release ownership: the loop owns its own
    // release by default, and this path never names a different owner.
    expect(loopArgs[5]).toEqual({ output });
    // A bare caller presented no bearer, so the key must be ABSENT rather than
    // present-and-undefined: the loop spreads this object into the fence input,
    // where an explicit `claimKey: undefined` is a different request from no key.
    expect(Object.hasOwn(loopArgs[5] as object, 'claimKey')).toBe(false);
    expect(result.applied).toEqual({ status: 'stopped', runId: PARENT_RUN_ID });
    expect(result.exitError).toBe(true);
  });

  it('threads the presented bearer into the execution loop as a lookup key', async () => {
    // The bearer is what lets the loop's fenced command mutation commit under the
    // caller's authority. Derived once here — never forwarded as the raw bearer,
    // which would push a credential down into the loop's options.
    const output = makeOutput();
    mockRunTransition.mockResolvedValue(
      appliedOutcome({
        loop: { kind: 'run' },
      }),
    );

    await runSeamTransition(output, '/cwd', createPassTransitionConfig(), {
      claimId: TEST_CLAIM_ID,
    });

    const loopArgs = mockRunExecutionLoop.mock.calls[0];
    expect(loopArgs[5]).toEqual({
      claimKey: TEST_CLAIM_KEY,
      output,
    });
  });

  it('routes a manual-completion drain through the emitter-bridged sink, not the action sink', async () => {
    const output = makeOutput();
    mockRunTransition.mockResolvedValue(
      appliedOutcome({
        mutation: 'manual-completion',
        events: [stepEvent()],
      }),
    );

    await runSeamTransition(output, '/cwd', createPassTransitionConfig());

    // manual-completion renders through the bridged emitter sink...
    expect(mockManualSink.onStepTransitioned).toHaveBeenCalledTimes(1);
    // ...and NOT through the buffered top-level action sink.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(output.action).not.toHaveBeenCalled();
  });
});
