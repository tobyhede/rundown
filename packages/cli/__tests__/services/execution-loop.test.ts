import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type {
  DelegationRuntimeCapabilities,
  DelegationTokenDeriver,
  DelegationTokenHash,
  EnterExecutionUnitInput,
  ErrorCodeKey,
  ExecutionEventEmitter,
  ExecutionUnitEntry,
  FrameKey,
  InlineLaunchStart,
  InlineLinkage,
  ParentLinkage,
  PopIfActiveResult,
  PushIfNotActiveResult,
  ReleaseRunbookResult,
  RunbookActorService,
  RunbookStateManager,
  RunId,
  SessionMutationResult,
} from '@rundown-org/core';
import type { ResolvedStep } from '@rundown-org/parser';
import type { ExecutionTerminalReleaseMode } from '../../src/services/execution.js';
import { mockFn } from '../helpers/typed-mocks.js';
import {
  delegationRuntimeDouble,
  unusedDelegationCredentialIssuer,
  unusedDelegationTokenDeriver,
} from '../helpers/delegation-runtime-helpers.js';
import { committed } from '../helpers/session-mutation-fixtures.js';

/**
 * The loop's delegation authority for a frontier already persisted on disk.
 *
 * Every frontier test below exercises the DERIVATION half only — the frontier
 * was minted on some earlier turn, and this turn merely projects it — but
 * `DelegationRuntimeCapabilities` is one branded pair, so the issuer travels
 * with it whether or not the path uses it. A throwing issuer keeps that
 * unexercised half honest: it turns "projection never re-issues" from an
 * unstated assumption into a failure.
 *
 * @param deriveDelegationToken - The deriver whose behaviour the test is about.
 * @returns A branded pair carrying that deriver and a throwing issuer.
 */
function frontierProjectionRuntime(
  deriveDelegationToken: DelegationTokenDeriver,
): DelegationRuntimeCapabilities {
  return delegationRuntimeDouble({
    issueDelegationCredential: unusedDelegationCredentialIssuer(),
    deriveDelegationToken,
  });
}

// The recovery-required refusal arm, so a fixture epoch carries core's brand
// without core having to export it. Reaching it through the union also means a
// change to the arm surfaces here rather than in a cast that keeps compiling.
type RecoveryRefusal = Extract<
  SessionMutationResult<ReleaseRunbookResult>,
  { readonly kind: 'recovery_required' }
>;

// Mock dependencies
const mockActorService = {
  sendAndSync: mockFn<
    (id: string, steps: unknown, event: unknown) => Promise<Record<string, unknown>>
  >() as any,
  getContextSnapshot: mockFn<
    (id: string, steps: unknown) => Promise<Record<string, unknown> | null>
  >() as any,
  // The entry seam. Declared with core's own input/output types because the
  // default implementation below IS core's derivation — the double stands in for
  // the service, not for the rendering, so it cannot drift from what production
  // renders. Tests that need a specific classification override it per call.
  enterExecutionUnit: mockFn<
    (input: EnterExecutionUnitInput) => Promise<ExecutionUnitEntry>
  >() as any,
  prepareActorMutation: mockFn<RunbookActorService['prepareActorMutation']>(),
};

const mockActorMutationRunner = {
  run: mockFn<
    (input: {
      runId: string;
      compute: (state: Record<string, unknown>) => Promise<{
        previousState: Record<string, unknown>;
        nextState: Record<string, unknown>;
        snapshot: unknown;
        effects: unknown[];
      }>;
    }) => Promise<Record<string, unknown>>
  >(),
};

/**
 * Every `nextState` the loop's fenced `compute` projected, in call order.
 *
 * The fence commits whatever `compute` returns, so this is the only place a
 * test can observe the loop's own active-entry projection before the committed
 * state is folded back into the loop.
 */
const fencedComputeProjections: Record<string, unknown>[] = [];

const mockSessionService = {
  getActive: mockFn<() => Promise<{ id: string } | null>>().mockResolvedValue(null),
  pushRunbook: mockFn<(id: string) => Promise<void>>().mockResolvedValue(undefined),
  // The conditional pop every inline stand-down/rollback path uses. Declared on
  // the double deliberately: those callers swallow every throw, so a missing
  // method would make each of their tests pass without the pop ever being
  // attempted — the blind check, not a green one.
  // Typed against core's own union rather than `unknown`, so a change to the
  // result shape is a compile error here instead of a double that silently
  // stops resembling the method it stands in for. `not-active` is the default
  // because it is the one arm needing no fabricated `RunId`: both callers
  // switch on `pop.kind` and discard the value, so the arm is inert, and a
  // `popped` default would have to brand an id this module cannot mint at
  // declaration time.
  popRunbookIfActive: mockFn<
    (id: RunId) => Promise<SessionMutationResult<PopIfActiveResult>>
  >().mockResolvedValue(committed({ status: 'not-active', activeRunbookId: null })),
  // The conditional activation the launch span performs once it has won the
  // latch. `pushed` is the default because it is the arm that arms the undo:
  // defaulting to `already-active` would make every rollback assertion below
  // vacuous, since the span only pops back what it pushed.
  pushRunbookIfNotActive: mockFn<(id: RunId) => Promise<PushIfNotActiveResult>>().mockResolvedValue(
    { status: 'pushed' },
  ),
  releaseRunbook:
    mockFn<
      (
        id: RunId,
        options?: { readonly retainClaimsAsTerminal?: boolean },
      ) => Promise<SessionMutationResult<ReleaseRunbookResult>>
    >(),
  // A resumed inline child re-establishes its own run-control authority through
  // core. These loop tests are about the launch/repair sequence, not the
  // credential seam, so the double refuses adoption — the arm that leaves the
  // continuation exactly as it was before authority was threaded here.
  // The parameter is the loop's own `Record<string, unknown>` state fixture
  // shape, as every other state-taking double in this file declares it. Naming
  // a narrower `{ id: string }` here would type-check the declaration and then
  // reject the fixture at the `toHaveBeenCalledWith` site, whose whole point is
  // that the resumed CHILD state is what reaches core.
  adoptRunControlClaim: mockFn<
    (state: Record<string, unknown>) => Promise<{ readonly kind: 'refused_credential_issued' }>
  >().mockResolvedValue({ kind: 'refused_credential_issued' }),
};

const consumeResolvedCompletionFn = mockFn<(id: string) => Promise<unknown>>();
consumeResolvedCompletionFn.mockResolvedValue(null);
const completionApplyNextFn =
  mockFn<(args: Record<string, unknown>) => Promise<Record<string, unknown>>>();
const recordChildCompletionFn =
  mockFn<(args: Record<string, unknown>) => Promise<'recorded' | 'blocked'>>();
const mockCompletionService = {
  applyNextResolvedCompletion: completionApplyNextFn,
  recordChildCompletion: recordChildCompletionFn,
};

const mockLifecycleService = {
  setLastResult: jest.fn() as any,
  consumeResolvedCompletion: consumeResolvedCompletionFn,
};

// Capture the real @rundown-org/core module before the mock is registered.
// jest.unstable_mockModule does NOT hoist (unlike jest.mock), so this top-level
// await executes first and captures the real implementations. The mock factory
// then closure-captures `actualCore` and spreads it — `await import` inside the
// factory would recurse through the registered mock and OOM the heap.
const actualCore = await import('@rundown-org/core');

jest.unstable_mockModule('@rundown-org/core', () => {
  return {
    ...actualCore,
    // I/O — fork shell processes
    executeCommand: jest.fn(),
    executeCommandWithEnv: (jest.fn() as any).mockResolvedValue({ success: true, exitCode: 0 }),
    executeCommandWithPolicy: jest.fn(),

    // Pass/fail evaluators — introspected via jest.mocked(core.evaluate*Condition)
    evaluatePassCondition: jest.fn(),
    evaluateFailCondition: jest.fn(),

    // Print / terminal output
    printActionBlock: jest.fn(),
    printStepBlock: jest.fn(),
    printStepSeparator: jest.fn(),
    printCommandExec: jest.fn(),
    printRunbookComplete: jest.fn(),
    printRunbookStoppedAtStep: jest.fn(),
    printPolicyDenied: jest.fn(),

    // Actor / session / lifecycle services — replaced by test doubles
    RunbookActorService: jest.fn(() => mockActorService),
    createEffectfulActorMutationRunner: jest.fn(() => mockActorMutationRunner),
    SessionService: jest.fn(() => mockSessionService),
    ExecutionLifecycleService: jest.fn(() => mockLifecycleService),
    RunbookCompletionService: jest.fn(() => mockCompletionService),
    // Delegation factory — introspected via jest.mocked(core.createDelegation)
    createDelegation: jest.fn(),

    // Run-id generator — deterministic for assertions
    generateRunId: jest.fn(() => 'rd_0123456789abcdef0123456789abcdef'),

    // Resolver — depends on filesystem in real impl
    resolveCurrentExecutionUnit: jest.fn((step: any, substepId: string | undefined) => {
      if (!substepId || !Array.isArray(step?.substeps)) return step;
      return step.substeps.find((s: any) => s.id === substepId) ?? step;
    }),
  };
});

jest.unstable_mockModule('../../src/helpers/resolve-runbook', () => ({
  resolveRunbookFile: (jest.fn() as any).mockResolvedValue(null),
  // Reached transitively: the resumed-child branch lazily imports the launch
  // pipeline to announce an adopted bearer, and the pipeline imports this.
  resolveRunbookRef: (jest.fn() as any).mockResolvedValue({ ok: false, reason: 'not-found' }),
  buildRunbookRef: jest.fn((resolved: { source: string; path: string; sourceRoot?: string }) => ({
    source: resolved.source,
    path:
      resolved.sourceRoot && resolved.path.startsWith(`${resolved.sourceRoot}/`)
        ? resolved.path.slice(resolved.sourceRoot.length + 1)
        : resolved.path,
  })),
}));

jest.unstable_mockModule('../../src/services/internal-commands', () => ({
  isInternalRdCommand: (jest.fn() as any).mockReturnValue(false),
  executeRdCommandInternal: jest.fn(),
}));

jest.unstable_mockModule('../../src/services/policy-context', () => ({
  getPolicyEvaluator: jest.fn(),
  getPolicyPrompter: jest.fn(),
  isPolicyEnforced: (jest.fn() as any).mockReturnValue(false),
  getSandboxOptions: (jest.fn() as any).mockReturnValue({ sandbox: true, sandboxStrict: false }),
}));

// Import after mocking
const core = await import('@rundown-org/core');
const policyContext = await import('../../src/services/policy-context.js');
const { getHelperRegistry, resetHelperRegistry, setHelperRegistry } = await import(
  '../../src/services/helper-registry.js'
);
const { runExecutionLoop, executeCommandWithPolicyCheck, drainResolvedCompletions } = await import(
  '../../src/services/execution.js'
);
const resolveRunbookModule = await import('../../src/helpers/resolve-runbook.js');
const mockedResolveRunbookRef = jest.mocked(resolveRunbookModule.resolveRunbookRef);
const mockedPolicyContext = jest.mocked(policyContext);

// Production types — used solely for the `as unknown as` casts below.
type RunbookStateManagerType = RunbookStateManager;
type ExecutionEventEmitterType = ExecutionEventEmitter;
type ResolvedStepType = ResolvedStep;

// Permissive shapes used in tests to seed the loop. Real types live in core
// (RunbookStateManager, ExecutionEventEmitter, ResolvedStep) but the tests
// only exercise narrow surfaces — typing those surfaces structurally keeps
// the test in line with what `runExecutionLoop` actually inspects.
type LoadFn = jest.Mock<(id: string) => Promise<Record<string, unknown> | null>>;
type UpdateFn = jest.Mock<(id: string, patch: Record<string, unknown>) => Promise<void>>;
type EmitFn = jest.Mock<(input: { type: string; payload?: unknown }) => void>;
type MutateStateReturningSignature = (
  id: string,
  build: (
    current: Record<string, unknown>,
  ) => Promise<{ next: Record<string, unknown> | null; value: unknown }>,
) => Promise<{ state: Record<string, unknown> | null; value: unknown }>;
type MutateStateReturningFn = jest.Mock<MutateStateReturningSignature>;
type MockManagerLike = {
  cwd: string;
  load: LoadFn;
  update: UpdateFn;
  delete: jest.Mock<(id: string) => Promise<void>>;
  /** Whole-state compare-and-swap seam; the inline-launch latch runs on it. */
  mutateStateReturning: MutateStateReturningFn;
};
type MockEmitterLike = {
  emit: EmitFn;
};
// `unknown` is the strongest type we can give the steps array without
// hand-rolling every ResolvedStep variant — the loop receives them via
// `as ResolvedStep[]` casts at call sites.
type LooseStep = Record<string, unknown>;

/**
 * Narrow `as unknown as` cast for the mock manager. The runbook state
 * manager has dozens of fields the loop never inspects on this code path;
 * the mock only stubs `load` and `update`. Casting at the call site keeps
 * this explicit at every invocation rather than smuggling it into the
 * mock's own type. Same idea applies to the emitter and steps casts.
 */
const asManager = (m: MockManagerLike): RunbookStateManagerType =>
  m as unknown as RunbookStateManagerType;
const asEmitter = (e: MockEmitterLike): ExecutionEventEmitterType =>
  e as unknown as ExecutionEventEmitterType;
const asSteps = (s: readonly LooseStep[]): ResolvedStepType[] => s as unknown as ResolvedStepType[];

// PREVIOUSLY UNCOVERED MUTANTS in the fenced command block of execution.ts
// (#485). Both are now killed; recorded here so neither regresses back into
// an unreachable position, and so the next reader knows WHERE each is killed.
// The common cause was that this suite replaces the mutation runner with a
// double that only ever calls `compute`, and replaces core wholesale — so no
// real fence, real recovery, or real claim authority is reachable from here.
//
//  - `makeRecoveryActor: (state) => ...` (`execution.ts:1742`), `ArrowFunction ->
//    () => undefined`. Only an interrupted command whose fence actually recovers
//    distinguishes the two, and this suite's runner double calls `compute` alone
//    — it never reaches `makeRecoveryActor`. Killed by
//    `execution-recovery-actor.test.ts`, which drives the real
//    `createEffectfulActorMutationRunner` against a temp project dir so the
//    loop's own closure builds the recovery actor the fence then drives.
//  - `{ issueDelegationCredential: options.delegationRuntime?.… }`
//    (`execution.ts:1771`), `ObjectLiteral -> {}`. That argument is the only
//    route by which the verified issuer reaches the machine's
//    `delegationIssueActor`, which runs inside the SAME fenced mutation when a
//    command's transition lands on a DELEGATE frontier; with `{}` issuance
//    refuses `actor_context_required` instead of minting. A real issuer cannot
//    exist here — `DelegationRuntimeCapabilities` is branded by a
//    module-private symbol whose sole producer is inside core — so it is killed
//    by `execution-delegation-issuance.test.ts`.
//
// The third, `deriveActiveEntry(..., true)`, is gone with the projection it
// belonged to: the machine owns the entry bump (#680), so the CLI no longer
// projects one.

/**
 * A pid that can never be alive: above every platform's pid_max (Linux 4194304,
 * macOS 99998), so `kill(pid, 0)` is always ESRCH. The same constant is used by
 * core's process-identity, lease and file-lock suites.
 */
const DEAD_PID = 999999999;

describe('runExecutionLoop', () => {
  let mockManager: MockManagerLike;
  let mockEmitter: MockEmitterLike;
  const runbookId = actualCore.assertRunId(`rd_${'1'.repeat(32)}`);
  const persistedFrontierEntry = (id: string, runbook: string, token: string) => ({
    id,
    runbook,
    credential: {
      version: 1 as const,
      issuerClaimKey: `rdclk_${'a'.repeat(32)}`,
      issuanceNonce: id.replace('.', '').padEnd(43, '0'),
      parentRunId: runbookId,
      parentStepId: id,
      parentFrameKey: '1|',
      parentEntry: 1,
    },
    tokenHash: actualCore.hashDelegationToken(token),
  });
  const steps: LooseStep[] = [
    {
      kind: 'command',
      name: '1',
      description: 'Step 1',
      command: { code: 'echo hello', lang: 'sh' },
      transitions: {
        pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' }, next: '2' },
        fail: { kind: 'fail', retry: 0, action: { type: 'STOP' }, next: 'STOP' },
      },
    },
    {
      kind: 'command',
      name: '2',
      description: 'Step 2',
      command: { code: 'echo world', lang: 'sh' },
      transitions: {
        pass: {
          kind: 'pass',
          retry: 0,
          action: { type: 'COMPLETE', message: 'Success' },
          next: 'COMPLETE',
        },
        fail: { kind: 'fail', retry: 0, action: { type: 'STOP' }, next: 'STOP' },
      },
    },
  ];
  const makeLoopState = (
    step = '1',
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => {
    const baseTemplateVars = {
      RunId: runbookId,
      RunbookRef: { source: 'project', path: 'test.runbook.md' },
      ContextId: 'ctx-unit',
      WorkPath: '.rundown/work',
    };
    return {
      id: runbookId,
      runbook: { source: 'project', path: 'test.runbook.md' },
      runbookPath: 'test.runbook.md',
      step,
      status: 'running',
      // Every persisted run carries this: `create` always writes it and `load`
      // refuses a row without it, so a loose fixture that omitted it modelled a
      // state the manager cannot hand back. Ahead of the spread so a test that
      // is about prompted mode still overrides it.
      prompted: false,
      ...overrides,
      templateVars: {
        ...baseTemplateVars,
        ...(overrides.templateVars ?? {}),
      },
    };
  };
  /**
   * Loop state whose persisted snapshot carries a delegate frontier.
   *
   * The shared core seam reads the frontier out of committed state — the same
   * read `rundown collect` performs — so the fixture lives on the state rather
   * than on a separate `getContextSnapshot` read.
   */
  const frontierLoopState = (frontier: unknown, overrides: Record<string, unknown> = {}) =>
    makeLoopState('1', {
      substep: '1',
      substepStates: [],
      snapshot: { context: { delegateFrontier: frontier } },
      ...overrides,
    });
  /**
   * Realistic post-commit state for a `DELEGATE_FRONTIER_CONSUMED` `sendAndSync`
   * mock result.
   *
   * The entry is rendered from the COMMITTED state (RD-827 finding 1: rendering
   * — which can run `--helpers` JS — must not run before the consume that gates
   * it, so it now runs against `consumed.state` rather than the pre-commit
   * capture). A bare `{ id, step, substep, status }` stub carries no
   * `templateVars`, so it trips `deriveExecutionUnitEntry`'s missing-`WorkPath`
   * guard the instant it is used for rendering instead of only for loop control.
   * The frontier is cleared from context, mirroring what the real consume retires.
   */
  const frontierConsumedState = (overrides: Record<string, unknown> = {}) =>
    frontierLoopState(undefined, { snapshot: { context: {} }, ...overrides });
  const commandCompletedEffect = (result: 'pass' | 'fail' = 'pass') => ({
    kind: 'execution_observation',
    event: {
      type: 'COMMAND_COMPLETED',
      payload: {
        command: 'echo hello',
        success: result === 'pass',
        exitCode: result === 'pass' ? 0 : 1,
        position: { current: '1', total: 2 },
      },
    },
    commandOutput: {
      kind: 'completed',
      command: 'echo hello',
      displayCommand: 'echo hello',
      success: result === 'pass',
      result,
      exitCode: result === 'pass' ? 0 : 1,
      channels: [],
    },
  });
  const policyDeniedEffect = (reason = 'Not allowed') => ({
    kind: 'execution_observation',
    event: {
      type: 'POLICY_DENIED',
      payload: {
        command: 'echo hello',
        reason,
        position: { current: '1', total: 2 },
      },
    },
    commandOutput: {
      kind: 'policy_denied',
      command: 'echo hello',
      displayCommand: 'echo hello',
      success: false,
      exitCode: 126,
      policyDenied: true,
      denialReason: reason,
      channels: [],
    },
  });
  const commandStartedEffectFixture = () => ({
    kind: 'execution_observation' as const,
    event: {
      type: 'COMMAND_STARTED' as const,
      payload: {
        command: 'echo hello',
        displayCommand: 'echo hello',
        position: { current: '1', total: 2 },
      },
    },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    resetHelperRegistry();

    mockedPolicyContext.isPolicyEnforced.mockReturnValue(false);
    mockedPolicyContext.getSandboxOptions.mockReturnValue({ sandbox: true, sandboxStrict: false });
    mockedPolicyContext.getPolicyEvaluator.mockReturnValue({
      setRunbookPath: jest.fn(),
    } as unknown as ReturnType<typeof policyContext.getPolicyEvaluator>);
    mockedPolicyContext.getPolicyPrompter.mockReturnValue(
      {} as unknown as ReturnType<typeof policyContext.getPolicyPrompter>,
    );
    (core.executeCommand as any).mockReset();
    (core.executeCommandWithPolicy as any).mockReset();

    mockManager = {
      cwd: process.env.TMPDIR ?? '/tmp',
      load: mockFn<(id: string) => Promise<Record<string, unknown> | null>>(),
      update: mockFn<(id: string, patch: Record<string, unknown>) => Promise<void>>(),
      delete: mockFn<(id: string) => Promise<void>>(),
      mutateStateReturning: mockFn<MutateStateReturningSignature>(),
    };
    mockManager.update.mockResolvedValue(undefined);
    mockManager.delete.mockResolvedValue(undefined);
    // Stands in for the store's optimistic cycle: read the row, derive against
    // it, report what the derivation decided. Reading through `load` keeps this
    // double honest about the one read a real cycle performs — a test that
    // sequences `load` sees the latch consume exactly one entry, as the pre-read
    // it replaced did.
    mockManager.mutateStateReturning.mockImplementation(async (id, build) => {
      const current = await mockManager.load(id);
      if (!current) return { state: null, value: null };
      const { next, value } = await build(current);
      return { state: next ?? current, value };
    });

    mockLifecycleService.consumeResolvedCompletion.mockReset();
    mockLifecycleService.consumeResolvedCompletion.mockResolvedValue(null);
    mockCompletionService.applyNextResolvedCompletion.mockReset();
    mockCompletionService.applyNextResolvedCompletion.mockImplementation(async () => ({
      kind: 'none',
      state: makeLoopState(),
      unresolved: 0,
    }));
    mockCompletionService.recordChildCompletion.mockReset();
    mockCompletionService.recordChildCompletion.mockResolvedValue('recorded');

    mockActorService.sendAndSync.mockReset();
    mockActorService.prepareActorMutation.mockReset();
    mockActorService.prepareActorMutation.mockImplementation(
      async (id, previousState, actorSteps, event) => {
        const synchronized = await mockActorService.sendAndSync(id, actorSteps, event);
        if (!synchronized) throw new Error('Actor synchronization failed');
        return {
          previousState,
          nextState: synchronized.state,
          snapshot: synchronized.snapshot,
          effects: synchronized.effects ?? [],
        };
      },
    );
    mockActorMutationRunner.run.mockReset();
    fencedComputeProjections.length = 0;
    mockActorMutationRunner.run.mockImplementation(async (input) => {
      const capturedState = await mockManager.load(input.runId);
      if (!capturedState) {
        return { kind: 'missing', runId: input.runId, message: 'Runbook not found' };
      }
      const prepared = await input.compute(capturedState);
      fencedComputeProjections.push(prepared.nextState);
      return {
        kind: 'committed',
        value: {
          state: prepared.nextState,
          snapshot: prepared.snapshot,
          effects: prepared.effects,
        },
      };
    });
    mockActorService.getContextSnapshot.mockReset();
    mockActorService.getContextSnapshot.mockResolvedValue(null);
    mockActorService.enterExecutionUnit.mockReset();
    // Core's own derivation, with the two dependencies the real service binds
    // supplied here: the project directory and the CLI helper registry. The
    // double therefore renders exactly what production renders, and these tests
    // stay about the loop's wiring rather than about rendering.
    mockActorService.enterExecutionUnit.mockImplementation(async (input: EnterExecutionUnitInput) =>
      actualCore.deriveExecutionUnitEntry({
        ...input,
        cwd: '/tmp',
        helpers: getHelperRegistry(),
      }),
    );

    mockEmitter = {
      emit: mockFn<(input: { type: string; payload?: unknown }) => void>(),
    };
    mockSessionService.getActive.mockReset();
    mockSessionService.getActive.mockResolvedValue(null);
    mockSessionService.pushRunbook.mockReset();
    mockSessionService.pushRunbook.mockResolvedValue(undefined);
    mockSessionService.releaseRunbook.mockReset();
    mockSessionService.releaseRunbook.mockResolvedValue(
      committed({
        status: 'released',
        runbookId,
        removedFromDefaultStack: true,
        nextDefaultRunbookId: null,
      }),
    );
    mockSessionService.popRunbookIfActive.mockReset();
    mockSessionService.popRunbookIfActive.mockResolvedValue(
      committed({ status: 'not-active', activeRunbookId: null }),
    );
    mockSessionService.pushRunbookIfNotActive.mockReset();
    mockSessionService.pushRunbookIfNotActive.mockResolvedValue({ status: 'pushed' });

    // Re-seeded rather than left to the module factory: one test replaces this
    // implementation to interleave a second observer inside the inline launch
    // span, and `jest.clearAllMocks()` clears calls without restoring
    // implementations.
    mockedResolveRunbookRef.mockReset();
    mockedResolveRunbookRef.mockResolvedValue({
      ok: false,
      reason: 'file-missing',
      runbookRef: { source: 'project', path: 'child.runbook.md' },
    });

    // Default evaluate behavior. ConditionResult requires `action`; the test
    // bodies only check the `message` field so we cast through `unknown` to
    // a partial — this asserts the test contract while still exercising the
    // real return type at the call site.
    jest
      .mocked(core.evaluatePassCondition)
      .mockReturnValue({ message: 'Success' } as unknown as ReturnType<
        typeof core.evaluatePassCondition
      >);
    jest
      .mocked(core.evaluateFailCondition)
      .mockReturnValue({ message: 'Failed' } as unknown as ReturnType<
        typeof core.evaluateFailCondition
      >);
  });

  it('renders runtime Step and helper expressions through the core renderer before command execution', () => {
    setHelperRegistry(new Map([['wrap', (value: string) => `[${value}]`]]));

    const result = core.expandLoopVariablesForCommand(
      'echo {{ wrap Step }}',
      { Step: '2.1' },
      { helpers: getHelperRegistry() },
    );

    expect(result).toBe("echo '[2.1]'");
  });

  it('stops if state cannot be loaded', async () => {
    mockManager.load.mockResolvedValue(null);
    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(steps),
      '/tmp',
      asEmitter(mockEmitter),
    );
    expect(result).toBe('stopped');
  });

  it('observes each drained completion before applying the next one', async () => {
    const order: string[] = [];
    const substepSteps: LooseStep[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Parent',
        aggregation: { strategy: 'ALL' },
        substeps: [
          {
            id: '1',
            description: 'First',
            transitions: {
              pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' }, next: '1.2' },
              fail: { kind: 'fail', retry: 0, action: { type: 'STOP' }, next: 'STOP' },
            },
          },
          {
            id: '2',
            description: 'Second',
            transitions: {
              pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' }, next: 'COMPLETE' },
              fail: { kind: 'fail', retry: 0, action: { type: 'STOP' }, next: 'STOP' },
            },
          },
        ],
        transitions: {
          pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' }, next: 'COMPLETE' },
          fail: { kind: 'fail', retry: 0, action: { type: 'STOP' }, next: 'STOP' },
        },
      },
    ];
    const beforeFirst = makeLoopState('1', {
      substep: '1',
      retryCount: 0,
      lifecycle: 'running',
      activeFrameKey: '1|',
      activeEntry: 1,
    });
    const afterFirst = makeLoopState('1', {
      substep: '2',
      retryCount: 0,
      lifecycle: 'running',
      activeFrameKey: '1|',
      activeEntry: 1,
    });
    const afterSecond = makeLoopState('1', {
      substep: undefined,
      retryCount: 0,
      lifecycle: 'running',
      activeFrameKey: '1|',
      activeEntry: 1,
    });

    // No state is threaded in: the primitive reads its own, so the loop's only
    // input per call is the run and its steps.
    mockCompletionService.applyNextResolvedCompletion
      .mockImplementationOnce(async (args) => {
        order.push('apply-1');
        expect(args).not.toHaveProperty('currentState');
        expect(args).not.toHaveProperty('maxApplied');
        return {
          kind: 'applied',
          unresolved: 1,
          entry: {
            key: '1|1|1',
            completion: { result: 'pass', targetSubstep: '1' },
            stateBefore: beforeFirst,
            stateAfter: afterFirst,
            snapshot: { status: 'active', context: { lastAction: { type: 'CONTINUE' } } },
          },
        };
      })
      .mockImplementationOnce(async () => {
        order.push('apply-2');
        return {
          kind: 'applied',
          unresolved: 0,
          entry: {
            key: '1|1|2',
            completion: { result: 'pass', targetSubstep: '2' },
            stateBefore: afterFirst,
            stateAfter: afterSecond,
            snapshot: { status: 'active', context: { lastAction: { type: 'CONTINUE' } } },
          },
        };
      })
      .mockImplementationOnce(async () => {
        order.push('empty');
        return { kind: 'none', state: afterSecond, unresolved: 0 };
      });
    // The observation probe is the emitter, which is what "observes" actually
    // means here. It used to be the `ensureActiveEntry` projection call, but
    // frame entry is machine-owned now (#680) and the loop no longer projects.
    mockEmitter.emit.mockImplementation((event: { type: string }) => {
      order.push(`emit:${event.type}`);
    });

    const drained = await drainResolvedCompletions({
      actorService: mockActorService as any,
      manager: asManager(mockManager),
      sessionService: mockSessionService as any,
      emitter: asEmitter(mockEmitter),
      runbookId: runbookId,
      steps: asSteps(substepSteps),
      currentState: beforeFirst as any,
      transitionPolicy: {
        onComplete: { releaseRunbook: false },
        onStopped: { releaseRunbook: false },
      },
    });

    expect(drained).toEqual({
      status: 'continue',
      state: afterSecond,
      unresolved: 0,
      applied: 2,
    });
    // The applies are strictly ordered and each one's observation lands before
    // the next apply begins — that interleaving is the whole claim.
    expect(order.filter((entry) => !entry.startsWith('emit:'))).toEqual([
      'apply-1',
      'apply-2',
      'empty',
    ]);
    const at = (label: string): number => order.indexOf(label);
    const emittedBetween = (from: string, to: string): string[] =>
      order.slice(at(from) + 1, at(to)).filter((entry) => entry.startsWith('emit:'));
    expect(emittedBetween('apply-1', 'apply-2').length).toBeGreaterThan(0);
    expect(emittedBetween('apply-2', 'empty').length).toBeGreaterThan(0);
  });

  it('preserves unresolved completion count when draining fails', async () => {
    const currentState = makeLoopState('1', {
      lifecycle: 'running',
      activeFrameKey: '1|',
      activeEntry: 1,
    });

    mockCompletionService.applyNextResolvedCompletion.mockResolvedValueOnce({
      kind: 'mismatch',
      state: currentState,
      mismatch: {
        status: 'failed',
        reason: 'stale_state',
        message: 'Runbook state is stale',
        completion: { result: 'pass', targetSubstep: '1' },
      },
      unresolved: 2,
    });

    const drained = await drainResolvedCompletions({
      actorService: mockActorService as any,
      manager: asManager(mockManager),
      sessionService: mockSessionService as any,
      emitter: asEmitter(mockEmitter),
      runbookId: runbookId,
      steps: asSteps(steps),
      currentState: currentState as any,
      transitionPolicy: {
        onComplete: { releaseRunbook: false },
        onStopped: { releaseRunbook: false },
      },
    });

    expect(drained).toEqual({
      status: 'failed',
      reason: 'stale_state',
      message: 'Runbook state is stale',
      unresolved: 2,
      applied: 0,
    });
  });

  it('reports the terminating pass unresolved count and the observed state on the ordinary exit', async () => {
    // The `none` arm is how the drain ordinarily stops, and both values it
    // passes through there were unpinned: every other non-zero `unresolved`
    // assertion in this file rides the `mismatch` refusal arm, and every `none`
    // exercised here carries zero. A drain that reported a constant 0, or the
    // count from the FIRST apply rather than the terminating one, or the idle
    // pass's own state instead of the state it actually observed, would have
    // been invisible. Both are load-bearing for the caller: `unresolved` is the
    // remaining-work count `rundown collect` reports, and `state` is what the
    // next stage continues from.
    const substepSteps: LooseStep[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Parent',
        aggregation: { strategy: 'ALL' },
        substeps: [
          {
            id: '1',
            description: 'First',
            transitions: {
              pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' }, next: '1.2' },
              fail: { kind: 'fail', retry: 0, action: { type: 'STOP' }, next: 'STOP' },
            },
          },
          {
            id: '2',
            description: 'Second',
            transitions: {
              pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' }, next: '1.3' },
              fail: { kind: 'fail', retry: 0, action: { type: 'STOP' }, next: 'STOP' },
            },
          },
        ],
        transitions: {
          pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' }, next: 'COMPLETE' },
          fail: { kind: 'fail', retry: 0, action: { type: 'STOP' }, next: 'STOP' },
        },
      },
    ];
    const beforeFirst = makeLoopState('1', {
      substep: '1',
      retryCount: 0,
      lifecycle: 'running',
      activeFrameKey: '1|',
      activeEntry: 1,
    });
    const afterFirst = makeLoopState('1', {
      substep: '2',
      retryCount: 0,
      lifecycle: 'running',
      activeFrameKey: '1|',
      activeEntry: 1,
    });
    // Deliberately NOT `afterFirst`. The drain must report the state it
    // observed, and the idle pass's state is the plausible wrong answer.
    const idlePassState = makeLoopState('1', {
      substep: '9',
      retryCount: 0,
      lifecycle: 'running',
      activeFrameKey: '1|',
      activeEntry: 1,
    });

    mockCompletionService.applyNextResolvedCompletion
      // A count distinct from the terminating one, so reporting this apply's
      // number instead of the last one's is a visible failure rather than a
      // coincidence.
      .mockImplementationOnce(async () => ({
        kind: 'applied',
        unresolved: 5,
        entry: {
          key: '1|1|1',
          completion: { result: 'pass', targetSubstep: '1' },
          stateBefore: beforeFirst,
          stateAfter: afterFirst,
          snapshot: { status: 'active', context: { lastAction: { type: 'CONTINUE' } } },
        },
      }))
      .mockImplementationOnce(async () => ({
        kind: 'none',
        state: idlePassState,
        unresolved: 2,
      }));

    const drained = await drainResolvedCompletions({
      actorService: mockActorService as any,
      manager: asManager(mockManager),
      sessionService: mockSessionService as any,
      emitter: asEmitter(mockEmitter),
      runbookId: runbookId,
      steps: asSteps(substepSteps),
      currentState: beforeFirst as any,
      transitionPolicy: {
        onComplete: { releaseRunbook: false },
        onStopped: { releaseRunbook: false },
      },
    });

    expect(drained).toEqual({
      status: 'continue',
      state: afterFirst,
      unresolved: 2,
      applied: 1,
    });
    // One apply plus the idle pass that ends the loop. A drain that stopped
    // after the first call never reaches the `none` arm these values come from.
    expect(mockCompletionService.applyNextResolvedCompletion).toHaveBeenCalledTimes(2);
  });

  it('preserves observed progress when an override frame becomes inactive after a drain', async () => {
    const substepSteps: LooseStep[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Parent',
        aggregation: { strategy: 'ALL' },
        substeps: [
          {
            id: '1',
            description: 'Only',
            transitions: {
              pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' }, next: '2' },
              fail: { kind: 'fail', retry: 0, action: { type: 'STOP' }, next: 'STOP' },
            },
          },
        ],
        transitions: {
          pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' }, next: '2' },
          fail: { kind: 'fail', retry: 0, action: { type: 'STOP' }, next: 'STOP' },
        },
      },
      {
        kind: 'base',
        name: '2',
        description: 'Next',
        transitions: {
          pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' }, next: 'COMPLETE' },
          fail: { kind: 'fail', retry: 0, action: { type: 'STOP' }, next: 'STOP' },
        },
      },
    ];
    const before = makeLoopState('1', {
      substep: '1',
      retryCount: 0,
      lifecycle: 'running',
      activeFrameKey: '1|',
      activeEntry: 1,
    });
    const after = makeLoopState('2', {
      substep: undefined,
      retryCount: 0,
      lifecycle: 'running',
      activeFrameKey: '2|',
      activeEntry: 1,
    });

    mockCompletionService.applyNextResolvedCompletion
      .mockResolvedValueOnce({
        kind: 'applied',
        unresolved: 0,
        entry: {
          key: '1|1|1',
          completion: { result: 'pass', targetSubstep: '1' },
          stateBefore: before,
          stateAfter: after,
          snapshot: { status: 'active', context: { lastAction: { type: 'CONTINUE' } } },
        },
      })
      .mockResolvedValueOnce({
        kind: 'not_active',
        state: after,
        frameKey: '1|',
        activeFrameKey: '2|',
        unresolved: 0,
      });
    const drained = await drainResolvedCompletions({
      actorService: mockActorService as any,
      manager: asManager(mockManager),
      sessionService: mockSessionService as any,
      emitter: asEmitter(mockEmitter),
      runbookId: runbookId,
      steps: asSteps(substepSteps),
      currentState: before as any,
      transitionPolicy: {
        onComplete: { releaseRunbook: false },
        onStopped: { releaseRunbook: false },
      },
      frameOverride: { kind: 'inactive', frameKey: '1|' } as any,
    });

    expect(drained).toEqual({
      status: 'continue',
      state: after,
      unresolved: 0,
      applied: 1,
    });
  });

  it('emits derived completion without entering a step when initialization already completed', async () => {
    mockManager.load.mockResolvedValue(
      makeLoopState('2', {
        lifecycle: 'completed',
        snapshot: {
          status: 'done',
          value: 'COMPLETE',
          context: {
            lastAction: { type: 'COMPLETE', origin: 'direct' },
          },
        },
      }),
    );
    jest.mocked(core.executeCommand).mockResolvedValue({ success: true, exitCode: 0 });

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(steps),
      '/tmp',
      asEmitter(mockEmitter),
    );

    expect(result).toBe('done');
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'RUNBOOK_COMPLETED',
      payload: expect.objectContaining({
        message: 'Success',
        finalPosition: { current: '2', total: 2 },
      }),
    });
    const emittedEvents = mockEmitter.emit.mock.calls.map(([event]) => event.type);
    expect(emittedEvents).not.toContain('STEP_ENTERED');
    expect(emittedEvents).not.toContain('COMMAND_STARTED');
    expect(emittedEvents).not.toContain('COMMAND_COMPLETED');
    expect(core.executeCommand).not.toHaveBeenCalled();
    // Bare `runbookId`, asserted by exact arguments: the retaining form belongs
    // to `release-runbook`, and the two modes must stay distinguishable here.
    expect(mockSessionService.releaseRunbook).toHaveBeenCalledWith(runbookId);
  });

  it('returns waiting if prompted mode is on', async () => {
    mockManager.load.mockResolvedValue(makeLoopState('1', { prompted: true }));

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(steps),
      '/tmp',
      asEmitter(mockEmitter),
    );

    expect(result).toBe('waiting');
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'STEP_ENTERED',
      payload: expect.objectContaining({
        stepName: '1',
        prompted: true,
      }),
    });
  });

  it('emits STEP_ENTERED.artifacts from the actor snapshot working set', async () => {
    const artifact = {
      kind: 'artifact-record' as const,
      uri: 'rd://artifacts/ctx1/rd_22222222222222222222222222222222/plan.json',
      runId: 'rd_22222222222222222222222222222222',
      contextId: 'ctx1',
      runbook: { source: 'project' as const, path: 'plan.md' },
      key: 'plan.json',
      timestamp: '2026-05-12T00:00:00.000Z',
    };
    // Off the run's own persisted snapshot, which is where core reads it: the
    // entry seam takes the state it renders against, so a separate context read
    // is not a source it consults.
    mockManager.load.mockResolvedValue(
      makeLoopState('1', {
        prompted: true,
        snapshot: { context: { enteredArtifacts: { PlanPath: artifact } } },
      }),
    );

    await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(steps),
      '/tmp',
      asEmitter(mockEmitter),
    );

    const stepEntered = mockEmitter.emit.mock.calls.find((call) => call[0].type === 'STEP_ENTERED');
    expect(stepEntered?.[0]?.payload).toEqual(
      expect.objectContaining({
        artifacts: {
          PlanPath: expect.objectContaining({
            kind: 'artifact-record',
            uri: artifact.uri,
            path: expect.stringContaining(
              '.rundown/work/.rd-ctx1/rd_22222222222222222222222222222222/plan.json',
            ),
          }),
        },
      }),
    );
  });

  it('emits STEP_ENTERED.artifacts as an empty object when no ARTIFACTS resolved', async () => {
    mockManager.load.mockResolvedValue(
      makeLoopState('1', {
        prompted: true,
        snapshot: { context: { enteredArtifacts: undefined } },
      }),
    );

    await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(steps),
      '/tmp',
      asEmitter(mockEmitter),
    );

    const stepEntered = mockEmitter.emit.mock.calls.find((call) => call[0].type === 'STEP_ENTERED');
    expect(stepEntered?.[0]?.payload).toEqual(expect.objectContaining({ artifacts: {} }));
  });

  it('returns waiting if step has no command', async () => {
    const stepsNoCmd = [
      {
        kind: 'base',
        name: '1',
        description: 'No command',
        transitions: { pass: { next: 'COMPLETE' } },
      },
    ];
    mockManager.load.mockResolvedValue(makeLoopState());

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(stepsNoCmd),
      '/tmp',
      asEmitter(mockEmitter),
    );

    expect(result).toBe('waiting');
  });

  it('executes command and advances to next step', async () => {
    mockManager.load
      .mockResolvedValueOnce(makeLoopState('1'))
      .mockResolvedValueOnce(makeLoopState('2'));

    mockActorService.sendAndSync.mockResolvedValue({
      state: makeLoopState('2'),
      snapshot: {
        status: 'active',
        value: '2',
        context: { lastAction: { type: 'CONTINUE', origin: 'direct' } },
      },
      effects: [commandCompletedEffect('pass')],
    });

    const testSteps = [
      steps[0],
      {
        kind: 'base',
        name: '2',
        description: 'Step 2',
        transitions: { pass: { next: 'COMPLETE' } },
      },
    ];

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(testSteps),
      '/tmp',
      asEmitter(mockEmitter),
    );

    expect(result).toBe('waiting');
    expect(mockActorService.sendAndSync).toHaveBeenCalledWith(
      runbookId,
      asSteps(testSteps),
      expect.objectContaining({ type: 'EXECUTE_COMMAND', command: 'echo hello' }),
    );
  });

  it('injects canonical RD_RUN_ID from template vars and persisted runbook identity', async () => {
    // Downstream tools (e.g. rdpath) treat these env vars as a structurally
    // paired triple. Asserting them here keeps a regression in the injection
    // gates at execution.ts (`if (typeof workPath === 'string') ...`) from
    // silently dropping one half of the pair without any test failing.
    mockManager.load.mockResolvedValue({
      id: runbookId,
      runbook: { source: 'project', path: 'test.runbook.md' },
      step: '1',
      status: 'running',
      templateVars: {
        WorkPath: '/tmp/work',
        ContextId: 'ctx-abc',
        RunId: runbookId,
      },
    });

    jest.mocked(core.executeCommand).mockResolvedValue({ success: true, exitCode: 0 });
    jest.mocked(core.executeCommandWithEnv).mockResolvedValue({ success: true, exitCode: 0 });

    mockActorService.sendAndSync.mockResolvedValue({
      state: {
        id: runbookId,
        step: '1',
        status: 'done',
        variables: {},
        runbook: { source: 'project', path: 'test.runbook.md' },
        templateVars: {
          WorkPath: '/tmp/work',
          ContextId: 'ctx-abc',
          RunId: runbookId,
        },
      },
      snapshot: {
        status: 'done',
        value: 'COMPLETE',
        context: { lastAction: { type: 'COMPLETE', origin: 'direct' }, lastMessage: 'Success' },
      },
      effects: [commandCompletedEffect('pass')],
    });

    await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps([steps[0]]),
      '/tmp',
      asEmitter(mockEmitter),
    );

    expect(mockActorService.sendAndSync).toHaveBeenCalledTimes(1);
    const envArg = (
      mockActorService.sendAndSync.mock.calls[0][2] as { rdInjected: Record<string, string> }
    ).rdInjected;
    expect(envArg.RD_WORK_PATH).toBe('/tmp/work');
    expect(envArg.RD_CONTEXT_ID).toBe('ctx-abc');
    expect(envArg.RD_RUN_ID).toBe(runbookId);
    expect(envArg.RD_RUNBOOK_REF).toBe('test.runbook.md');
    expect(envArg.RD_RUNBOOK_SOURCE).toBe('project');
  });

  it.each([
    { source: 'plugin', path: 'planning/review.runbook.md' },
    { source: 'external', path: '/tmp/review.runbook.md' },
  ])('injects persisted $source runbook identity into RD env', async (runbook) => {
    mockManager.load.mockResolvedValue({
      id: runbookId,
      runbook,
      step: '1',
      status: 'running',
      templateVars: {
        WorkPath: '/tmp/work',
        ContextId: 'ctx-abc',
        RunId: runbookId,
      },
    });

    jest.mocked(core.executeCommand).mockResolvedValue({ success: true, exitCode: 0 });
    jest.mocked(core.executeCommandWithEnv).mockResolvedValue({ success: true, exitCode: 0 });

    mockActorService.sendAndSync.mockResolvedValue({
      state: {
        id: runbookId,
        step: '1',
        status: 'done',
        variables: {},
        runbook,
        templateVars: {
          WorkPath: '/tmp/work',
          ContextId: 'ctx-abc',
          RunId: runbookId,
        },
      },
      snapshot: {
        status: 'done',
        value: 'COMPLETE',
        context: { lastAction: { type: 'COMPLETE', origin: 'direct' }, lastMessage: 'Success' },
      },
      effects: [commandCompletedEffect('pass')],
    });

    await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps([steps[0]]),
      '/tmp',
      asEmitter(mockEmitter),
    );

    expect(mockActorService.sendAndSync).toHaveBeenCalledTimes(1);
    const envArg = (
      mockActorService.sendAndSync.mock.calls[0][2] as { rdInjected: Record<string, string> }
    ).rdInjected;
    expect(envArg.RD_RUNBOOK_REF).toBe(runbook.path);
    expect(envArg.RD_RUNBOOK_SOURCE).toBe(runbook.source);
  });

  it('handles policy denial', async () => {
    mockManager.load.mockResolvedValue(makeLoopState());
    jest.mocked(policyContext.isPolicyEnforced).mockReturnValue(true);

    mockActorService.sendAndSync.mockResolvedValue({
      state: makeLoopState('1', {
        lifecycle: 'stopped',
        lastAction: { type: 'POLICY_DENIED', message: 'Not allowed' },
      }),
      snapshot: {
        status: 'done',
        value: 'STOPPED',
        context: { lastAction: { type: 'POLICY_DENIED', message: 'Not allowed' } },
      },
      effects: [policyDeniedEffect('Not allowed')],
    });

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(steps),
      '/tmp',
      asEmitter(mockEmitter),
    );

    expect(result).toBe('stopped');
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'POLICY_DENIED',
      payload: expect.objectContaining({
        reason: 'Not allowed',
      }),
    });
  });

  it('emits COMMAND_STARTED then COMMAND_COMPLETED from effects when executing a command', async () => {
    mockManager.load.mockResolvedValue(makeLoopState());

    mockActorService.sendAndSync.mockResolvedValue({
      state: {
        id: runbookId,
        step: '1',
        status: 'done',
        variables: {},
        runbookPath: '/tmp/test.md',
      },
      snapshot: {
        status: 'done',
        value: 'COMPLETE',
        context: { lastAction: { type: 'COMPLETE' }, lastMessage: 'Done' },
      },
      effects: [commandStartedEffectFixture(), commandCompletedEffect('pass')],
    });

    await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps([steps[0]]),
      '/tmp',
      asEmitter(mockEmitter),
    );

    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'COMMAND_STARTED',
      payload: expect.objectContaining({ command: 'echo hello', displayCommand: 'echo hello' }),
    });
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'COMMAND_COMPLETED',
      payload: expect.objectContaining({ command: 'echo hello', success: true, exitCode: 0 }),
    });

    const emitCalls = mockEmitter.emit.mock.calls;
    const startedIdx = emitCalls.findIndex((c) => c[0].type === 'COMMAND_STARTED');
    const completedIdx = emitCalls.findIndex((c) => c[0].type === 'COMMAND_COMPLETED');
    expect(startedIdx).toBeGreaterThanOrEqual(0);
    expect(completedIdx).toBeGreaterThan(startedIdx);
  });

  it('completes the runbook', async () => {
    mockManager.load.mockResolvedValue(makeLoopState());
    jest.mocked(core.executeCommand).mockResolvedValue({ success: true, exitCode: 0 });

    mockActorService.sendAndSync.mockResolvedValue({
      state: {
        id: runbookId,
        step: '1',
        status: 'done',
        variables: {},
        runbookPath: '/tmp/test.md',
      },
      snapshot: {
        status: 'done',
        value: 'COMPLETE',
        context: { lastAction: { type: 'COMPLETE', origin: 'direct' }, lastMessage: 'Success' },
      },
      effects: [commandCompletedEffect('pass')],
    });

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(steps),
      '/tmp',
      asEmitter(mockEmitter),
    );

    expect(result).toBe('done');
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'RUNBOOK_COMPLETED',
      payload: expect.objectContaining({
        message: 'Success',
      }),
    });
    // 'stack-pop' retains the claim exactly as 'release-runbook' does: the run
    // reached terminal under its own steam, so its bearer becomes a tombstone
    // rather than being deleted. Pinned end-to-end against a real store by
    // `run.test.ts` "retains the run-control claim as a terminal tombstone" —
    // this mocked runner ignores `terminalRelease`, so it can only pin the
    // request, never the release itself.
    expect(mockActorMutationRunner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalRelease: {
          onComplete: true,
          onStopped: true,
          retainClaimsAsTerminal: true,
        },
      }),
    );
    expect(mockSessionService.releaseRunbook).not.toHaveBeenCalled();
  });

  describe('terminal release refused for execution ownership (#608)', () => {
    /**
     * Every RUNBOOK_STOPPED the emitter received this test.
     *
     * `toHaveBeenCalledWith` passes when ANY call matches, so it cannot tell a
     * single correct stop from one accompanied by a spurious second. These
     * paths differ precisely in how many stops they emit.
     *
     * @returns The stopped events, in emission order.
     */
    function stoppedEmissions(): { type: string }[] {
      return mockEmitter.emit.mock.calls
        .map(([event]) => event as { type: string })
        .filter((event) => event.type === 'RUNBOOK_STOPPED');
    }

    /** Drive the loop to a COMPLETE terminal so the release is the only variable. */
    function seedCompletingRun(): void {
      mockManager.load.mockResolvedValue(makeLoopState());
      jest.mocked(core.executeCommand).mockResolvedValue({ success: true, exitCode: 0 });
      mockActorService.sendAndSync.mockResolvedValue({
        state: {
          id: runbookId,
          step: '1',
          status: 'done',
          variables: {},
          runbookPath: '/tmp/test.md',
        },
        snapshot: {
          status: 'done',
          value: 'COMPLETE',
          context: { lastAction: { type: 'COMPLETE', origin: 'direct' }, lastMessage: 'Success' },
        },
        effects: [commandCompletedEffect('pass')],
      });
    }

    it.each([
      {
        label: 'execution_in_progress',
        refusal: {
          kind: 'execution_in_progress' as const,
          runId: runbookId,
          message: `Run ${runbookId} has an execution in progress.`,
        },
        code: 'EXECUTION_IN_PROGRESS',
      },
      {
        label: 'recovery_required',
        refusal: {
          kind: 'recovery_required' as const,
          runId: runbookId,
          epoch: 4 as RecoveryRefusal['epoch'],
          message:
            `Run ${runbookId} ended execution with an unknown outcome at epoch 4; its recovery ` +
            `has not completed. Nothing was written and no recovery was started here, so ` +
            `retrying this command will not clear it.`,
        },
        code: 'RECOVERY_REQUIRED',
      },
    ])('reports $label and returns stopped instead of done', async ({ refusal, code }) => {
      mockManager.load.mockResolvedValue(makeLoopState());
      mockActorMutationRunner.run.mockResolvedValueOnce(refusal);

      const result = await runExecutionLoop(
        asManager(mockManager),
        runbookId,
        asSteps(steps),
        '/tmp',
        asEmitter(mockEmitter),
      );

      expect(result).toBe('stopped');
      expect(mockEmitter.emit).toHaveBeenCalledWith({
        type: 'ERROR_OCCURRED',
        payload: { message: refusal.message, code },
      });
      expect(mockSessionService.releaseRunbook).not.toHaveBeenCalled();
    });

    it('reports a refused stack pop and downgrades an already-completed run', async () => {
      // The stack-pop disposition of the same release. The run is already
      // terminal at loop entry, so the pop is the loop's only session write —
      // and a refused pop must not report `done`.
      mockManager.load.mockResolvedValue(
        makeLoopState('2', {
          lifecycle: 'completed',
          snapshot: {
            status: 'done',
            value: 'COMPLETE',
            context: { lastAction: { type: 'COMPLETE', origin: 'direct' } },
          },
        }),
      );
      const refusal = {
        kind: 'execution_in_progress' as const,
        runId: runbookId,
        message: `Run ${runbookId} has an execution in progress.`,
      };
      mockSessionService.releaseRunbook.mockResolvedValue(refusal);

      const result = await runExecutionLoop(
        asManager(mockManager),
        runbookId,
        asSteps(steps),
        '/tmp',
        asEmitter(mockEmitter),
      );

      expect(result).toBe('stopped');
      expect(mockSessionService.releaseRunbook).toHaveBeenCalledWith(runbookId);
      expect(mockEmitter.emit).toHaveBeenCalledWith({
        type: 'ERROR_OCCURRED',
        payload: { message: refusal.message, code: 'EXECUTION_IN_PROGRESS' },
      });
      // The stream must not claim the run completed: the release it owed was
      // refused, so the run is still on the session stack. A consumer reading
      // only the events would otherwise see a clean completion.
      expect(mockEmitter.emit).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'RUNBOOK_COMPLETED' }),
      );
      // The stop names where the run halted rather than being a bare marker,
      // and it is the ONLY one: this path suppresses the completion rather than
      // correcting it, so the helper must not add a second stop on top.
      expect(mockEmitter.emit).toHaveBeenCalledWith({
        type: 'RUNBOOK_STOPPED',
        payload: { position: { current: '2', total: 2 } },
      });
      expect(stoppedEmissions()).toHaveLength(1);
    });

    it('does not release the winner when a stale command claimant is refused', async () => {
      mockManager.load.mockResolvedValue(makeLoopState());
      const refusal = {
        kind: 'claim_superseded' as const,
        runId: runbookId,
        message: `Claim authority for run ${runbookId} was superseded.`,
      };
      mockActorMutationRunner.run.mockResolvedValueOnce(refusal);

      const result = await runExecutionLoop(
        asManager(mockManager),
        runbookId,
        asSteps(steps),
        '/tmp',
        asEmitter(mockEmitter),
        { terminalReleaseMode: 'release-runbook' },
      );

      expect(result).toBe('stopped');
      expect(mockEmitter.emit).toHaveBeenCalledWith({
        type: 'ERROR_OCCURRED',
        payload: { message: refusal.message, code: 'STALE_CLAIM' },
      });
      expect(mockSessionService.releaseRunbook).not.toHaveBeenCalled();
    });

    it('returns done and emits no stop when the command path release commits', async () => {
      // The committing half of the command path. Without it nothing pins that
      // this site reports `done`: the refusal tests return `stopped` whatever
      // the committed outcome would have been.
      seedCompletingRun();

      const result = await runExecutionLoop(
        asManager(mockManager),
        runbookId,
        asSteps(steps),
        '/tmp',
        asEmitter(mockEmitter),
        { terminalReleaseMode: 'release-runbook' },
      );

      expect(result).toBe('done');
      expect(mockActorMutationRunner.run).toHaveBeenCalledWith(
        expect.objectContaining({
          terminalRelease: {
            onComplete: true,
            onStopped: true,
            retainClaimsAsTerminal: true,
          },
        }),
      );
      expect(mockSessionService.releaseRunbook).not.toHaveBeenCalled();
      expect(stoppedEmissions()).toHaveLength(0);
    });

    it.each([
      { label: 'commits', refuse: false, expected: 'done', stops: 0 },
      { label: 'is refused', refuse: true, expected: 'stopped', stops: 1 },
    ])(
      'drives the drain terminal through the release when it $label',
      async ({ refuse, expected, stops }) => {
        // The drain reaches its own terminal release site, distinct from the
        // command path. It was uncovered in `release-runbook` mode entirely.
        mockManager.load.mockResolvedValue(makeLoopState());
        // Terminal rides on the applied arm: a run cannot reach terminal without
        // an apply that carried it there, so the entry is part of the shape.
        mockCompletionService.applyNextResolvedCompletion.mockResolvedValue({
          kind: 'applied',
          unresolved: 0,
          terminal: 'done',
          entry: {
            key: '1|1|1',
            completion: { result: 'pass', targetSubstep: '1' },
            stateBefore: makeLoopState(),
            stateAfter: makeLoopState('1', { lifecycle: 'completed' }),
            snapshot: { status: 'active', context: { lastAction: { type: 'CONTINUE' } } },
          },
        });
        if (refuse) {
          mockSessionService.releaseRunbook.mockResolvedValue({
            kind: 'execution_in_progress' as const,
            runId: runbookId,
            message: `Run ${runbookId} has an execution in progress.`,
          });
        }

        const result = await runExecutionLoop(
          asManager(mockManager),
          runbookId,
          asSteps(steps),
          '/tmp',
          asEmitter(mockEmitter),
          { terminalReleaseMode: 'release-runbook' },
        );

        expect(result).toBe(expected);
        expect(mockSessionService.releaseRunbook).toHaveBeenCalledWith(runbookId, {
          retainClaimsAsTerminal: true,
        });
        expect(stoppedEmissions()).toHaveLength(stops);
      },
    );

    it('does not fabricate a corrective stop when the refused terminal was already stopped', async () => {
      // The correction exists only to contradict a completion that was already
      // announced. A terminal that stopped emitted its own stop, so adding a
      // second one would double-report the same halt.
      mockManager.load.mockResolvedValue(
        makeLoopState('2', {
          lifecycle: 'stopped',
          snapshot: {
            status: 'done',
            value: 'STOPPED',
            context: { lastAction: { type: 'STOP', origin: 'direct' } },
          },
        }),
      );
      const refusal = {
        kind: 'execution_in_progress' as const,
        runId: runbookId,
        message: `Run ${runbookId} has an execution in progress.`,
      };
      mockSessionService.releaseRunbook.mockResolvedValue(refusal);

      const result = await runExecutionLoop(
        asManager(mockManager),
        runbookId,
        asSteps(steps),
        '/tmp',
        asEmitter(mockEmitter),
      );

      expect(result).toBe('stopped');
      expect(mockEmitter.emit).toHaveBeenCalledWith({
        type: 'ERROR_OCCURRED',
        payload: { message: refusal.message, code: 'EXECUTION_IN_PROGRESS' },
      });
      expect(stoppedEmissions()).toHaveLength(1);
    });

    it('announces completion from state when the snapshot is not recognizably terminal', async () => {
      // A completed run whose snapshot does not read as terminal takes the
      // fallback: the completion payload is derived from the run state rather
      // than from a transition observation. Both branches announce completion,
      // so only the payload distinguishes them.
      mockManager.load.mockResolvedValue(
        makeLoopState('2', {
          lifecycle: 'completed',
          snapshot: {
            status: 'active',
            value: { 'step::2': 'idle' },
            context: { lastAction: { type: 'CONTINUE', origin: 'direct' }, lastMessage: 'Wrapped' },
          },
        }),
      );

      const result = await runExecutionLoop(
        asManager(mockManager),
        runbookId,
        asSteps(steps),
        '/tmp',
        asEmitter(mockEmitter),
      );

      expect(result).toBe('done');
      expect(mockEmitter.emit).toHaveBeenCalledWith({
        type: 'RUNBOOK_COMPLETED',
        payload: { message: 'Wrapped', finalPosition: { current: '2', total: 2 } },
      });
    });

    it('emits the completion and returns done when the pre-loop release commits', async () => {
      // The committed half of the same branch. Without it, forcing the refusal
      // path always-on would still pass: nothing else drives an already-terminal
      // run through this branch with a release that succeeds.
      mockManager.load.mockResolvedValue(
        makeLoopState('2', {
          lifecycle: 'completed',
          snapshot: {
            status: 'done',
            value: 'COMPLETE',
            context: { lastAction: { type: 'COMPLETE', origin: 'direct' } },
          },
        }),
      );

      const result = await runExecutionLoop(
        asManager(mockManager),
        runbookId,
        asSteps(steps),
        '/tmp',
        asEmitter(mockEmitter),
      );

      expect(result).toBe('done');
      expect(mockEmitter.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'RUNBOOK_COMPLETED' }),
      );
      expect(mockEmitter.emit).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'RUNBOOK_STOPPED' }),
      );
    });
  });

  describe("terminalReleaseMode 'defer-to-caller' (#598)", () => {
    it('drives a run to done without releasing — caller owns release', async () => {
      // Mirror the "completes the runbook" fixture: an in-loop command drive to
      // a 'done' terminal. Under 'defer-to-caller' the drain policy is
      // non-releasing AND the in-loop guard skips applyExecutionTerminalRelease,
      // so NO session release fires — the caller (the inline
      // parent-advance core seam) owns the single terminal release.
      mockManager.load.mockResolvedValue(makeLoopState());
      jest.mocked(core.executeCommand).mockResolvedValue({ success: true, exitCode: 0 });
      mockActorService.sendAndSync.mockResolvedValue({
        state: {
          id: runbookId,
          step: '1',
          status: 'done',
          variables: {},
          runbookPath: '/tmp/test.md',
        },
        snapshot: {
          status: 'done',
          value: 'COMPLETE',
          context: { lastAction: { type: 'COMPLETE', origin: 'direct' }, lastMessage: 'Success' },
        },
        effects: [commandCompletedEffect('pass')],
      });

      const result = await runExecutionLoop(
        asManager(mockManager),
        runbookId,
        asSteps(steps),
        '/tmp',
        asEmitter(mockEmitter),
        { terminalReleaseMode: 'defer-to-caller' },
      );

      expect(result).toBe('done');
      expect(mockSessionService.releaseRunbook).not.toHaveBeenCalled();
      // The release is folded INTO the fenced command mutation, so "the caller
      // owns it" has to be visible in the request the fence received — not only
      // in the absence of a separate session call, which would also hold if the
      // fence had released it inside its own transaction.
      expect(mockActorMutationRunner.run).toHaveBeenCalledWith(
        expect.objectContaining({
          terminalRelease: {
            onComplete: false,
            onStopped: false,
            retainClaimsAsTerminal: true,
          },
        }),
      );
    });

    it('drives a run to stopped without releasing', async () => {
      // Pre-loaded stopped state (CLI-owned stop recovery). Under
      // 'defer-to-caller' applyExecutionTerminalRelease no-ops, so the terminal
      // return releases nothing.
      mockManager.load.mockResolvedValue(
        makeLoopState('1', {
          lifecycle: 'stopped',
          snapshot: {
            status: 'active',
            value: { 'step::1': 'idle' },
            context: { lastAction: { type: 'CONTINUE', origin: 'direct' } },
          },
        }),
      );

      const result = await runExecutionLoop(
        asManager(mockManager),
        runbookId,
        asSteps(steps),
        '/tmp',
        asEmitter(mockEmitter),
        { terminalReleaseMode: 'defer-to-caller' },
      );

      expect(result).toBe('stopped');
      expect(mockSessionService.releaseRunbook).not.toHaveBeenCalled();
    });

    it("'release-runbook' releases the run and retains the claim as a terminal tombstone", async () => {
      // No test drove this mode through runExecutionLoop before: the suite's
      // other retainClaimsAsTerminal assertion is satisfied by a release from a
      // different module, and the loop's default mode is 'stack-pop'. That left
      // the flag unpinned here — a mutant flipping it to `false` survived, even
      // though the disposition is load-bearing: retaining the tombstone is what
      // lets a later `--claim-id` confirm-or-conflict resolve `terminal` rather
      // than `missing` (RD-598).
      mockManager.load.mockResolvedValue(
        makeLoopState('1', {
          lifecycle: 'stopped',
          snapshot: {
            status: 'active',
            value: { 'step::1': 'idle' },
            context: { lastAction: { type: 'CONTINUE', origin: 'direct' } },
          },
        }),
      );

      const result = await runExecutionLoop(
        asManager(mockManager),
        runbookId,
        asSteps(steps),
        '/tmp',
        asEmitter(mockEmitter),
        { terminalReleaseMode: 'release-runbook' },
      );

      expect(result).toBe('stopped');
      expect(mockSessionService.releaseRunbook).toHaveBeenCalledWith(runbookId, {
        retainClaimsAsTerminal: true,
      });
    });

    it('refuses an unrecognized release mode instead of falling through to a stack pop', async () => {
      // The mode dispatch must not treat "not release-runbook" as "stack-pop":
      // a future ExecutionTerminalReleaseMode added to the union would then
      // silently pop the default stack, releasing a run its owner still holds.
      // The `never` check makes the compiler the primary gate; this pins the
      // runtime half, which is what a cast at a call site would slip past.
      // Pre-loaded stopped state, mirroring the sibling test: that path reaches
      // applyExecutionTerminalRelease unconditionally, whereas the in-loop
      // transition sites guard the call on the mode and would never reach it.
      mockManager.load.mockResolvedValue(
        makeLoopState('1', {
          lifecycle: 'stopped',
          snapshot: {
            status: 'active',
            value: { 'step::1': 'idle' },
            context: { lastAction: { type: 'CONTINUE', origin: 'direct' } },
          },
        }),
      );

      await expect(
        runExecutionLoop(
          asManager(mockManager),
          runbookId,
          asSteps(steps),
          '/tmp',
          asEmitter(mockEmitter),
          // Cast against the RELEASE-OWNING overload's mode: `runExecutionLoop`
          // is now overloaded on the mode, so a bare
          // `ExecutionTerminalReleaseMode` matches neither signature. The test
          // is unchanged in substance — an unknown mode still reaches the
          // runtime exhaustiveness guard in `applyExecutionTerminalRelease`.
          {
            terminalReleaseMode: 'future-mode' as Exclude<
              ExecutionTerminalReleaseMode,
              'defer-to-caller'
            >,
          },
        ),
      ).rejects.toThrow(/future-mode/);

      expect(mockSessionService.releaseRunbook).not.toHaveBeenCalled();
    });
  });

  describe('claim authority threaded into the fenced command mutation', () => {
    /** Drive one command step and return the fence input the loop built. */
    async function fenceInputForCommand(
      options: Record<string, unknown> = {},
    ): Promise<Record<string, unknown>> {
      mockManager.load.mockResolvedValue(makeLoopState());
      jest.mocked(core.executeCommand).mockResolvedValue({ success: true, exitCode: 0 });
      mockActorService.sendAndSync.mockResolvedValue({
        state: {
          id: runbookId,
          step: '1',
          status: 'done',
          variables: {},
          runbookPath: '/tmp/test.md',
        },
        snapshot: {
          status: 'done',
          value: 'COMPLETE',
          context: { lastAction: { type: 'COMPLETE', origin: 'direct' }, lastMessage: 'Success' },
        },
        effects: [commandCompletedEffect('pass')],
      });

      await runExecutionLoop(
        asManager(mockManager),
        runbookId,
        asSteps(steps),
        '/tmp',
        asEmitter(mockEmitter),
        options,
      );

      return mockActorMutationRunner.run.mock.calls[0][0];
    }

    it('presents the caller claim key as the fence authority when one was supplied', async () => {
      // A delegated child runs its commands under its bearer. Losing the key here
      // downgrades the commit to a bare capture, which resolves whatever claim
      // currently controls the run rather than the one the caller presented.
      const claimKey = 'rdclk_11111111111111111111111111111111';

      const input = await fenceInputForCommand({ claimKey });

      expect(input.claimKey).toBe(claimKey);
    });

    it('omits the key entirely for a bare caller rather than presenting undefined', async () => {
      const input = await fenceInputForCommand();

      expect(Object.hasOwn(input, 'claimKey')).toBe(false);
    });

    // `displayCommand` is what the operator sees attributed to the step, while
    // `command` stays the string actually executed. An `rd echo` wrapper is
    // scaffolding, so the display strips it — unless stripping leaves nothing,
    // in which case showing an empty command is worse than showing the wrapper.
    it.each([
      {
        label: 'strips an rd echo wrapper for display',
        code: 'rd echo --result pass npm run build',
        displayCommand: 'npm run build',
      },
      {
        label: 'falls back to the raw command when stripping leaves nothing',
        code: 'rd echo --result pass',
        displayCommand: 'rd echo --result pass',
      },
    ])('$label', async ({ code, displayCommand }) => {
      const commandSteps = [{ ...steps[0], command: { code, lang: 'sh' } }, steps[1]];
      mockManager.load.mockResolvedValue(makeLoopState());
      jest.mocked(core.executeCommand).mockResolvedValue({ success: true, exitCode: 0 });
      mockActorService.sendAndSync.mockResolvedValue({
        state: {
          id: runbookId,
          step: '1',
          status: 'done',
          variables: {},
          runbookPath: '/tmp/test.md',
        },
        snapshot: {
          status: 'done',
          value: 'COMPLETE',
          context: { lastAction: { type: 'COMPLETE', origin: 'direct' }, lastMessage: 'Success' },
        },
        effects: [commandCompletedEffect('pass')],
      });

      await runExecutionLoop(
        asManager(mockManager),
        runbookId,
        asSteps(commandSteps),
        '/tmp',
        asEmitter(mockEmitter),
      );

      expect(mockActorService.prepareActorMutation).toHaveBeenCalledWith(
        runbookId,
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ type: 'EXECUTE_COMMAND', command: code, displayCommand }),
        { issueDelegationCredential: undefined },
      );
    });
  });

  it('emits ERROR_OCCURRED when the state machine stops with a RETRY_ERROR lastAction', async () => {
    // Seed the actor to report a stopped lifecycle with a RETRY_ERROR
    // lastAction variant on the returned snapshot. runExecutionLoop should
    // emit ERROR_OCCURRED with the hook error's code + message before the
    // terminal RUNBOOK_STOPPED event.
    mockManager.load.mockResolvedValue(makeLoopState());
    jest.mocked(core.executeCommand).mockResolvedValue({ success: false, exitCode: 1 });

    mockActorService.sendAndSync.mockResolvedValue({
      state: {
        id: runbookId,
        step: '1',
        status: 'done',
        lifecycle: 'stopped',
        variables: {},
        runbookPath: '/tmp/test.md',
      },
      snapshot: {
        status: 'done',
        value: 'STOPPED',
        context: {
          lastAction: {
            type: 'RETRY_ERROR' as const,
            origin: 'direct',
            code: 'RD-902',
            message: 'hook failed: createDelegation returned step_not_found',
          },
          lifecycle: 'stopped',
        },
      },
      effects: [],
    });

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(steps),
      '/tmp',
      asEmitter(mockEmitter),
    );

    expect(result).toBe('stopped');

    // ERROR_OCCURRED is emitted with the RETRY_ERROR lastAction payload fields.
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'ERROR_OCCURRED',
      payload: expect.objectContaining({
        code: 'RD-902',
        message: 'hook failed: createDelegation returned step_not_found',
      }),
    });

    // RUNBOOK_STOPPED still fires afterwards with a reason distinct from an
    // author-configured FAIL STOP transition.
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'RUNBOOK_STOPPED',
      payload: expect.objectContaining({ reason: 'retry_error_failed' }),
    });

    // Ordering: ERROR_OCCURRED precedes RUNBOOK_STOPPED.
    const emitCalls = mockEmitter.emit.mock.calls;
    const errorIdx = emitCalls.findIndex((c) => c[0].type === 'ERROR_OCCURRED');
    const stoppedIdx = emitCalls.findIndex((c) => c[0].type === 'RUNBOOK_STOPPED');
    expect(errorIdx).toBeGreaterThanOrEqual(0);
    expect(stoppedIdx).toBeGreaterThanOrEqual(0);
    expect(errorIdx).toBeLessThan(stoppedIdx);

    // Invariant: STEP_TRANSITIONED is NEVER emitted with action: 'RETRY_ERROR'.
    // RETRY_ERROR is a machine-internal failure signal already surfaced via
    // ERROR_OCCURRED + RUNBOOK_STOPPED; leaking it through STEP_TRANSITIONED
    // would widen the public action enum beyond the scenario schema
    // (CONTINUE/DEFER/GOTO/STOP/COMPLETE/RETRY/BREAK/NEXT).
    const stepTransitionedCalls = emitCalls.filter((c) => c[0].type === 'STEP_TRANSITIONED');
    for (const call of stepTransitionedCalls) {
      const payload = call[0].payload as { action?: string } | undefined;
      expect(payload?.action).not.toBe('RETRY_ERROR');
    }
  });

  it('emits ERROR_OCCURRED when the state machine stops with an OUTPUT_CAPTURE_FAILED lastAction', async () => {
    mockManager.load.mockResolvedValue(makeLoopState());
    jest.mocked(core.executeCommand).mockResolvedValue({ success: false, exitCode: 1 });

    mockActorService.sendAndSync.mockResolvedValue({
      state: {
        id: runbookId,
        step: '1',
        status: 'done',
        lifecycle: 'stopped',
        variables: {},
        runbookPath: '/tmp/test.md',
      },
      snapshot: {
        status: 'done',
        value: 'STOPPED',
        context: {
          lastAction: {
            type: 'OUTPUT_CAPTURE_FAILED' as const,
            origin: 'direct',
            message: 'failed to read channel file: /tmp/outputs/Foo',
          },
          lifecycle: 'stopped',
        },
      },
      effects: [],
    });

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(steps),
      '/tmp',
      asEmitter(mockEmitter),
    );

    expect(result).toBe('stopped');

    // ERROR_OCCURRED is emitted with the OUTPUT_CAPTURE_FAILED message.
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'ERROR_OCCURRED',
      payload: expect.objectContaining({
        message: 'failed to read channel file: /tmp/outputs/Foo',
      }),
    });

    // RUNBOOK_STOPPED still fires afterwards so terminal state is reported.
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'RUNBOOK_STOPPED',
      payload: expect.any(Object),
    });

    // Ordering: ERROR_OCCURRED precedes RUNBOOK_STOPPED.
    const emitCalls = mockEmitter.emit.mock.calls;
    const errorIdx = emitCalls.findIndex((c) => c[0].type === 'ERROR_OCCURRED');
    const stoppedIdx = emitCalls.findIndex((c) => c[0].type === 'RUNBOOK_STOPPED');
    expect(errorIdx).toBeGreaterThanOrEqual(0);
    expect(stoppedIdx).toBeGreaterThanOrEqual(0);
    expect(errorIdx).toBeLessThan(stoppedIdx);
  });

  it('emits ERROR_OCCURRED + RUNBOOK_STOPPED when loaded state is already stopped with ARTIFACT_RESOLUTION_FAILED', async () => {
    // Batch-2 introduced the pre-loop stopped-on-entry projection so artifact
    // resolution failures surfaced during initializeState() (before the loop
    // sends any machine event) still route through deriveTransitionObservation
    // and emit ERROR_OCCURRED before RUNBOOK_STOPPED. STEP_TRANSITIONED is
    // suppressed because the failure is machine-internal.
    mockManager.load.mockResolvedValue(
      makeLoopState('1', {
        lifecycle: 'stopped',
        snapshot: {
          status: 'done',
          value: 'STOPPED',
          context: {
            lastAction: {
              type: 'ARTIFACT_RESOLUTION_FAILED' as const,
              origin: 'direct',
              message: 'artifact "PlanPath" failed to resolve',
            },
            lifecycle: 'stopped',
          },
        },
      }),
    );

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(steps),
      '/tmp',
      asEmitter(mockEmitter),
    );

    expect(result).toBe('stopped');
    expect(mockActorService.sendAndSync).not.toHaveBeenCalled();

    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'ERROR_OCCURRED',
      payload: expect.objectContaining({
        message: 'artifact "PlanPath" failed to resolve',
      }),
    });
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'RUNBOOK_STOPPED',
      payload: expect.objectContaining({
        message: 'artifact "PlanPath" failed to resolve',
        reason: 'artifact_resolution_failed',
      }),
    });

    const emitCalls = mockEmitter.emit.mock.calls;
    const errorIdx = emitCalls.findIndex((c) => c[0].type === 'ERROR_OCCURRED');
    const stoppedIdx = emitCalls.findIndex((c) => c[0].type === 'RUNBOOK_STOPPED');
    expect(errorIdx).toBeGreaterThanOrEqual(0);
    expect(stoppedIdx).toBeGreaterThan(errorIdx);

    const stepTransitionedCalls = emitCalls.filter((c) => c[0].type === 'STEP_TRANSITIONED');
    expect(stepTransitionedCalls).toHaveLength(0);
  });

  it('emits RUNBOOK_STOPPED when lifecycle is stopped but XState snapshot is non-terminal (CLI-owned stop recovery)', async () => {
    // Regression: policy denial / delegation-resolution failure patches only
    // lifecycle:'stopped' without driving the XState machine to its terminal STOPPED
    // state. The snapshot stays active. deriveTransitionObservation must not be used
    // for this path — it returns { status:'continue' } for non-terminal snapshots
    // and RUNBOOK_STOPPED is never emitted.
    mockManager.load.mockResolvedValue(
      makeLoopState('1', {
        lifecycle: 'stopped',
        snapshot: {
          status: 'active',
          value: { 'step::1': 'idle' },
          context: { lastAction: { type: 'CONTINUE', origin: 'direct' } },
        },
      }),
    );

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(steps),
      '/tmp',
      asEmitter(mockEmitter),
    );

    expect(result).toBe('stopped');
    expect(mockActorService.sendAndSync).not.toHaveBeenCalled();
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'RUNBOOK_STOPPED',
      payload: expect.objectContaining({
        position: expect.any(Object),
        reason: expect.any(String),
      }),
    });
    expect(
      (mockEmitter.emit as jest.Mock).mock.calls.filter(
        (c) => (c[0] as { type?: string } | undefined)?.type === 'STEP_TRANSITIONED',
      ),
    ).toHaveLength(0);
  });

  it('emits command_execution_failed for stopped command infrastructure state without transition events', async () => {
    mockManager.load.mockResolvedValue(
      makeLoopState('1', {
        lifecycle: 'stopped',
        lastAction: {
          type: 'COMMAND_EXECUTION_FAILED',
          origin: 'direct',
          message: 'Timeout of 30000 ms exceeded',
        },
        snapshot: {
          status: 'active',
          value: { 'step::1': 'idle' },
          context: {
            lastAction: {
              type: 'COMMAND_EXECUTION_FAILED',
              origin: 'direct',
              message: 'Timeout of 30000 ms exceeded',
            },
          },
        },
      }),
    );

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(steps),
      '/tmp',
      asEmitter(mockEmitter),
    );

    expect(result).toBe('stopped');
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'RUNBOOK_STOPPED',
      payload: expect.objectContaining({
        reason: 'command_execution_failed',
        message: 'Timeout of 30000 ms exceeded',
      }),
    });
    expect(
      (mockEmitter.emit as jest.Mock).mock.calls.filter(
        (c) => (c[0] as { type?: string } | undefined)?.type === 'STEP_TRANSITIONED',
      ),
    ).toHaveLength(0);
  });

  it('emits RUNBOOK_STOPPED when lifecycle is stopped and snapshot has no lastAction', async () => {
    mockManager.load.mockResolvedValue(
      makeLoopState('1', {
        lifecycle: 'stopped',
        snapshot: { status: 'active', value: { 'step::1': 'idle' }, context: {} },
      }),
    );

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(steps),
      '/tmp',
      asEmitter(mockEmitter),
    );

    expect(result).toBe('stopped');
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'RUNBOOK_STOPPED',
      payload: expect.objectContaining({ position: expect.any(Object) }),
    });
    expect(
      (mockEmitter.emit as jest.Mock).mock.calls.filter(
        (c) => (c[0] as { type?: string } | undefined)?.type === 'STEP_TRANSITIONED',
      ),
    ).toHaveLength(0);
  });

  it('prompted-for step returns waiting without CLI prompted mode', async () => {
    const promptedForSteps = [
      {
        kind: 'prompted-for',
        name: '1',
        description: 'Process items',
        prompt: 'FOR item IN 1 TO {{N}}',
        substeps: [
          {
            id: '1',
            description: 'Handle {{item}}',
            command: { code: 'rd echo item={{item}}', lang: 'bash' },
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
        ],
        transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
      },
    ];

    mockManager.load.mockResolvedValue(makeLoopState('1', { substep: '1' }));

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(promptedForSteps),
      '/tmp', // prompted=false — step itself gates execution
      asEmitter(mockEmitter),
    );

    expect(result).toBe('waiting');
  });

  it('prompted-for step emits STEP_ENTERED with prompted: true', async () => {
    const promptedForSteps = [
      {
        kind: 'prompted-for',
        name: '1',
        description: 'Process items',
        prompt: 'FOR item IN 1 TO {{N}}',
        substeps: [
          {
            id: '1',
            description: 'Handle {{item}}',
            command: { code: 'rd echo item={{item}}', lang: 'bash' },
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
        ],
        transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
      },
    ];

    mockManager.load.mockResolvedValue(makeLoopState('1', { substep: '1' }));

    await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(promptedForSteps),
      '/tmp',
      asEmitter(mockEmitter),
    );

    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'STEP_ENTERED',
      payload: expect.objectContaining({
        prompted: true,
      }),
    });
  });

  it('prompted-for step falls back to step-level prompt', async () => {
    const promptedForSteps = [
      {
        kind: 'prompted-for',
        name: '1',
        description: 'Process items',
        prompt: 'FOR item IN 1 TO {{N}}',
        substeps: [
          {
            id: '1',
            description: 'Handle {{item}}',
            // substep has no prompt field — falls back to step prompt
            command: { code: 'rd echo item={{item}}', lang: 'bash' },
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
        ],
        transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
      },
    ];

    mockManager.load.mockResolvedValue(makeLoopState('1', { substep: '1' }));

    await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(promptedForSteps),
      '/tmp',
      asEmitter(mockEmitter),
    );

    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'STEP_ENTERED',
      payload: expect.objectContaining({
        prompt: 'FOR item IN 1 TO {{N}}',
      }),
    });
  });

  it('prompted-for step does not inject loop variables', async () => {
    const promptedForSteps = [
      {
        kind: 'prompted-for',
        name: '1',
        description: 'Process items',
        prompt: 'FOR item IN 1 TO {{N}}',
        substeps: [
          {
            id: '1',
            description: 'Handle {{item}}',
            command: { code: 'rd echo item={{item}}', lang: 'bash' },
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
        ],
        transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
      },
    ];

    mockManager.load.mockResolvedValue(makeLoopState('1', { substep: '1' }));

    await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(promptedForSteps),
      '/tmp',
      asEmitter(mockEmitter),
    );

    // {{item}} should stay literal since no forClause drives variable injection
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'STEP_ENTERED',
      payload: expect.objectContaining({
        description: 'Handle {{item}}',
        commandCode: 'rd echo item={{item}}',
      }),
    });
  });

  it('emits expanded command text in STEP_ENTERED payload for prompted mode', async () => {
    const forSteps = [
      {
        kind: 'for',
        name: '1',
        description: 'Process',
        forClause: { variable: 'item', start: 1, end: 1 },
        substeps: [
          {
            id: '1',
            description: 'Handle {{item}}',
            command: { code: 'rd echo item={{item}}', lang: 'bash' },
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
        ],
        transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
      },
    ];

    mockManager.load.mockResolvedValue(makeLoopState('1', { substep: '1', prompted: true }));

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(forSteps),
      '/tmp',
      asEmitter(mockEmitter),
    );

    expect(result).toBe('waiting');
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'STEP_ENTERED',
      payload: expect.objectContaining({
        description: 'Handle 1',
        commandCode: 'rd echo item=1',
        prompted: true,
      }),
    });
  });

  describe('machine-driven auto-execution does not break on a step declaring OUTPUTS', () => {
    const stepsWithOutputs: any[] = [
      {
        kind: 'command',
        name: '1',
        description: 'Step 1 with outputs',
        command: { code: 'rd echo --result pass', lang: 'sh' },
        outputs: [{ name: 'PlanPath', value: '"plan-value"' }],
        transitions: {
          pass: { next: '2' },
          fail: { next: 'STOP' },
        },
      },
      {
        kind: 'base',
        name: '2',
        description: 'Step 2',
        transitions: {
          pass: { next: 'COMPLETE' },
          fail: { next: 'STOP' },
        },
      },
    ];

    it('runs command step auto-execution with PASS without errors when outputs declared', async () => {
      // orchestrateTransition calls manager.load once more (for the reloaded continue state),
      // so we need two sequential returns: step 1 (initial load) → step 2 (reload after transition).
      mockManager.load
        .mockResolvedValueOnce(makeLoopState('1', { templateVars: { ContextId: 'ctx-unit' } }))
        .mockResolvedValueOnce(makeLoopState('2', { templateVars: { ContextId: 'ctx-unit' } }));

      jest.mocked(core.executeCommand).mockResolvedValue({ success: true, exitCode: 0 });

      // Non-terminal snapshot (active/CONTINUE) → orchestrateTransition takes the reload path
      mockActorService.sendAndSync.mockResolvedValue({
        state: {
          ...makeLoopState('2', { templateVars: { ContextId: 'ctx-unit' } }),
        },
        snapshot: {
          status: 'active',
          value: '2',
          context: { lastAction: { type: 'CONTINUE', origin: 'direct' } },
        },
        effects: [commandCompletedEffect('pass')],
      });

      const result = await runExecutionLoop(
        asManager(mockManager),
        runbookId,
        asSteps(stepsWithOutputs),
        '/tmp',
        asEmitter(mockEmitter),
      );

      // OUTPUTS evaluation lives in the state machine; this is a regression
      // guard that the CLI auto-execution path still runs to completion when
      // a step declares outputs. Behavioral coverage is in integration tests.
      expect(result).not.toBe('stopped');
    });

    it('sends COMMAND_RESULT, not SET_VARIABLES or PASS, after a successful command with OUTPUTS', async () => {
      // Use the file-local `LooseStep` shape (Record<string, unknown>) — the
      // ExecutionLoop only inspects narrow surfaces, and `asSteps(...)` at
      // the call site casts through to `ResolvedStep[]` for the function
      // signature. This replaces a prior `any[]` annotation with a typed
      // structural mock.
      const stepsWithOutputsForCommandResult: LooseStep[] = [
        {
          kind: 'command',
          name: '1',
          description: 'Capture version',
          command: { code: 'printf v1 > "$RD_OUTPUTS_Version"', lang: 'sh' },
          outputs: [{ name: 'Version' }],
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' }, next: '2' },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' }, next: 'STOP' },
          },
        },
        {
          kind: 'base',
          name: '2',
          description: 'After capture',
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' }, next: 'COMPLETE' },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' }, next: 'STOP' },
          },
        },
      ];

      mockManager.load
        .mockResolvedValueOnce(makeLoopState('1', { templateVars: { ContextId: 'ctx-unit' } }))
        .mockResolvedValueOnce(
          makeLoopState('2', {
            variables: { Version: 'v1' },
            templateVars: { ContextId: 'ctx-unit' },
          }),
        );
      jest.mocked(core.executeCommand).mockResolvedValue({ success: true, exitCode: 0 });
      mockActorService.sendAndSync.mockResolvedValue({
        state: makeLoopState('2', {
          variables: { Version: 'v1' },
          templateVars: { ContextId: 'ctx-unit' },
        }),
        snapshot: {
          status: 'active',
          value: 'step::2',
          context: {
            lastAction: { type: 'CONTINUE', origin: 'direct' },
            variables: { Version: 'v1' },
          },
        },
        effects: [commandCompletedEffect('pass')],
      });

      const result = await runExecutionLoop(
        asManager(mockManager),
        runbookId,
        asSteps(stepsWithOutputsForCommandResult),
        '/tmp',
        asEmitter(mockEmitter),
      );

      expect(result).not.toBe('stopped');
      const events = mockActorService.sendAndSync.mock.calls.map((call: unknown[]) => call[2]);
      expect(events).toEqual([
        // The event names the command only. Which OUTPUTS this unit captures
        // is derived inside the machine from the leaf's own declarations, so
        // the CLI has nothing to assert about them here.
        expect.objectContaining({ type: 'EXECUTE_COMMAND' }),
      ]);
      expect(events).not.toContainEqual(expect.objectContaining({ type: 'SET_VARIABLES' }));
      expect(events).not.toContainEqual(expect.objectContaining({ type: 'PASS' }));
      expect(events).not.toContainEqual(expect.objectContaining({ type: 'FAIL' }));
      expect(mockLifecycleService.setLastResult).not.toHaveBeenCalled();
    });
  });

  it('includes machine-owned delegateFrontier in STEP_ENTERED when entering a DELEGATE step', async () => {
    const delegateSteps: any[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Parallel work',
        substeps: [
          {
            id: '1',
            description: 'First task',
            delegate: true,
            runbooks: ['child-a.runbook.md'],
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
          {
            id: '2',
            description: 'Second task',
            delegate: true,
            runbooks: ['child-b.runbook.md'],
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
        ],
        transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
      },
    ];

    mockManager.load.mockResolvedValue(
      frontierLoopState([
        persistedFrontierEntry('1.1', 'child-a.runbook.md', 'rdtk_aaaa1111'),
        persistedFrontierEntry('1.2', 'child-b.runbook.md', 'rdtk_bbbb2222'),
      ]),
    );
    mockActorService.sendAndSync.mockResolvedValue({
      state: frontierConsumedState(),
      snapshot: {},
    });

    await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(delegateSteps),
      '/tmp',
      asEmitter(mockEmitter),
      {
        delegationRuntime: frontierProjectionRuntime((credential) =>
          credential.parentStepId === '1.1' ? 'rdtk_aaaa1111' : 'rdtk_bbbb2222',
        ),
      },
    );

    // STEP_ENTERED should have been emitted with delegateFrontier
    const stepEnteredCall = mockEmitter.emit.mock.calls.find(
      (call) => call[0].type === 'STEP_ENTERED',
    );
    expect(stepEnteredCall).toBeDefined();
    // STEP_ENTERED payload shape is the test contract — mockEmitter.emit's
    // `payload?: unknown` parameter is intentionally permissive, so this
    // narrows to the fields the test actually asserts on.
    const payload = stepEnteredCall![0].payload as {
      delegateFrontier?: { id: string; runbook: string; token: string }[];
    };

    expect(payload.delegateFrontier).toBeDefined();
    expect(payload.delegateFrontier).toHaveLength(2);

    expect(payload.delegateFrontier![0]).toMatchObject({
      id: '1.1',
      runbook: 'child-a.runbook.md',
      token: 'rdtk_aaaa1111',
    });
    expect(payload.delegateFrontier![1]).toMatchObject({
      id: '1.2',
      runbook: 'child-b.runbook.md',
      token: 'rdtk_bbbb2222',
    });

    expect(core.createDelegation).not.toHaveBeenCalled();
  });

  it('STEP_ENTERED uses delegateFrontier from context when present', async () => {
    const delegateSteps: any[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Parallel work',
        substeps: [
          {
            id: '1',
            description: 'First task',
            delegate: true,
            runbooks: ['child-a.runbook.md'],
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
          {
            id: '2',
            description: 'Second task',
            delegate: true,
            runbooks: ['child-b.runbook.md'],
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
        ],
        transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
      },
    ];

    mockManager.load.mockResolvedValue(
      frontierLoopState([
        persistedFrontierEntry('1.1', 'child-a.runbook.md', 'rdtk_retry_a'),
        persistedFrontierEntry('1.2', 'child-b.runbook.md', 'rdtk_retry_b'),
      ]),
    );

    const preIssued = [
      { id: '1.1', runbook: 'child-a.runbook.md', token: 'rdtk_retry_a' },
      { id: '1.2', runbook: 'child-b.runbook.md', token: 'rdtk_retry_b' },
    ];

    mockActorService.sendAndSync.mockResolvedValue({
      state: frontierConsumedState(),
      snapshot: {},
    });

    await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(delegateSteps),
      '/tmp',
      asEmitter(mockEmitter),
      {
        delegationRuntime: frontierProjectionRuntime((credential) =>
          credential.parentStepId === '1.1' ? 'rdtk_retry_a' : 'rdtk_retry_b',
        ),
      },
    );

    // STEP_ENTERED payload should carry the pre-issued frontier
    const stepEnteredCall = mockEmitter.emit.mock.calls.find(
      (call) => call[0].type === 'STEP_ENTERED',
    );
    expect(stepEnteredCall).toBeDefined();
    const payload = stepEnteredCall![0].payload as { delegateFrontier?: unknown };

    expect(payload.delegateFrontier).toEqual(preIssued);

    expect(core.createDelegation).not.toHaveBeenCalled();
    expect(mockActorService.sendAndSync).toHaveBeenCalledWith(runbookId, delegateSteps, {
      type: 'DELEGATE_FRONTIER_CONSUMED',
    });
  });

  // #802: the drain's `target_mismatch` is the same class as the three frontier
  // refusals below, and used to be the one that still threw. A throw unwinds
  // past `applyExecutionTerminalRelease`, stranding the refused run on the
  // session stack, and reaches the operator as RD-999 "Unknown error" — telling
  // them to retry a cursor mismatch no retry can resolve.
  it('refuses a completion that is not for the active cursor as a coded stop', async () => {
    const currentState = makeLoopState('1', {
      lifecycle: 'running',
      activeFrameKey: '1|',
      activeEntry: 1,
    });
    mockManager.load.mockResolvedValue(currentState);
    mockCompletionService.applyNextResolvedCompletion.mockResolvedValueOnce({
      kind: 'mismatch',
      state: currentState,
      mismatch: {
        status: 'failed',
        reason: 'target_mismatch',
        message: 'Completion targets substep 2, cursor is on 1',
        completion: { result: 'pass', targetSubstep: '2' },
      },
      unresolved: 1,
    });

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(steps),
      '/tmp',
      asEmitter(mockEmitter),
    );

    expect(result).toBe('stopped');
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'ERROR_OCCURRED',
      payload: {
        message: 'Completion targets substep 2, cursor is on 1',
        code: 'COMPLETION_TARGET_MISMATCH',
      },
    });
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'RUNBOOK_STOPPED',
      payload: {
        position: { current: '1', total: 2 },
        message: 'Completion targets substep 2, cursor is on 1',
      },
    });
    // The release the throw used to skip. Without it the refused run stays on
    // the session stack and every later bare command still resolves it.
    expect(mockSessionService.releaseRunbook).toHaveBeenCalledWith(runbookId);
  });

  // The drain's mismatch arm reports `applied: 0` and carries no state, so a
  // drain that APPLIED before it mismatched leaves the loop's captured
  // `currentState` behind the committed cursor. Building the corrective stop's
  // position from that capture named a step the run had already left, while the
  // message named the real one — one envelope contradicting itself, and an agent
  // routing on the machine-readable `position` targeting the wrong step.
  it('names the committed cursor in the corrective stop, not the pre-drain capture', async () => {
    const before = makeLoopState('1', {
      lifecycle: 'running',
      activeFrameKey: '1|',
      activeEntry: 1,
    });
    const afterApply = makeLoopState('2', {
      lifecycle: 'running',
      activeFrameKey: '2|',
      activeEntry: 1,
    });
    // Loop entry reads the pre-drain state; the refusal path re-reads and sees
    // the cursor the applies committed.
    mockManager.load.mockResolvedValueOnce(before).mockResolvedValue(afterApply);
    mockCompletionService.applyNextResolvedCompletion.mockResolvedValueOnce({
      kind: 'mismatch',
      state: before,
      mismatch: {
        status: 'failed',
        reason: 'target_mismatch',
        message: 'Resolved completion target does not match current cursor 2.',
        completion: { result: 'pass', targetSubstep: '3' },
      },
      unresolved: 1,
    });

    await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(steps),
      '/tmp',
      asEmitter(mockEmitter),
    );

    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'RUNBOOK_STOPPED',
      payload: {
        position: { current: '2', total: 2 },
        message: 'Resolved completion target does not match current cursor 2.',
      },
    });
  });

  // `defer-to-caller` is the mode where the loop releases NOTHING and its caller
  // acts on the status it is handed: the inline parent-advance seam releases the
  // run and recurses one level up on 'stopped'. A refusal applied nothing and
  // left the run RUNNING, so 'stopped' there released a live parent and reported
  // a terminal to ITS parent that never happened.
  it('hands the refusal back instead of a terminal when the release is deferred', async () => {
    const currentState = makeLoopState('1', {
      lifecycle: 'running',
      activeFrameKey: '1|',
      activeEntry: 1,
    });
    mockManager.load.mockResolvedValue(currentState);
    mockCompletionService.applyNextResolvedCompletion.mockResolvedValueOnce({
      kind: 'mismatch',
      state: currentState,
      mismatch: {
        status: 'failed',
        reason: 'target_mismatch',
        message: 'Completion targets substep 2, cursor is on 1',
        completion: { result: 'pass', targetSubstep: '2' },
      },
      unresolved: 1,
    });

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(steps),
      '/tmp',
      asEmitter(mockEmitter),
      { terminalReleaseMode: 'defer-to-caller' },
    );

    expect(result).toEqual({
      kind: 'refused',
      refusal: {
        reason: 'target_mismatch',
        message: 'Completion targets substep 2, cursor is on 1',
        code: 'COMPLETION_TARGET_MISMATCH',
        // In an inline chain the refusing run is an ANCESTOR, not the run the
        // operator invoked, and neither core message names one — so without
        // this the recovery the docs prescribe has no run to name.
        runId: runbookId,
      },
    });
    // Nothing released — that is what the mode means, and what makes reporting
    // a terminal here a lie the caller would act on.
    expect(mockSessionService.releaseRunbook).not.toHaveBeenCalled();
    // And nothing announced: a caller that owns the terminal owns reporting it,
    // and the adapter renders this same code and message. A RUNBOOK_STOPPED
    // here would announce a stop for a run that is still running.
    expect(mockEmitter.emit).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ERROR_OCCURRED' }),
    );
    expect(mockEmitter.emit).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'RUNBOOK_STOPPED' }),
    );
  });

  // The missing-authority refusal must behave exactly like its neighbour, the
  // frontier-consume failure: a coded ERROR_OCCURRED, a positioned
  // RUNBOOK_STOPPED, and a terminal release — never an untyped throw. A throw
  // unwinds past `applyExecutionTerminalRelease`, so the refused run stays on
  // the session stack (no release runs) and every later bare command
  // still resolves it as the active runbook. That stranding, not the message,
  // is what these tests pin.
  const singleDelegateFrontierSteps = (): LooseStep[] => [
    {
      kind: 'substeps',
      name: '1',
      description: 'Parallel work',
      substeps: [
        {
          id: '1',
          description: 'First task',
          delegate: true,
          runbooks: ['child-a.runbook.md'],
          transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
        },
      ],
      transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
    },
  ];

  it('refuses a persisted delegation frontier without a token deriver as a coded stop', async () => {
    const delegateSteps = singleDelegateFrontierSteps();

    mockManager.load.mockResolvedValue(
      frontierLoopState([persistedFrontierEntry('1.1', 'child-a.runbook.md', 'rdtk_pending')]),
    );

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(delegateSteps),
      '/tmp',
      asEmitter(mockEmitter),
    );

    expect(result).toBe('stopped');
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'ERROR_OCCURRED',
      payload: {
        message: 'Delegation frontier cannot be projected without verified claim authority',
        code: 'ACTOR_CONTEXT_REQUIRED',
      },
    });
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'RUNBOOK_STOPPED',
      payload: {
        position: { current: '1', total: 1, substep: '1' },
        message: 'Delegation frontier cannot be projected without verified claim authority',
        // The machine-owned issuance refusal for the very same condition
        // (`delegationIssueActor`, missing verified claim authority) stops with
        // `reason: 'actor_context_required'`. This is the DISCLOSURE half of that
        // condition, so the two stop events must be shaped identically.
        reason: 'actor_context_required',
      },
    });

    // None of the frontier-dependent work may run on the refusal path.
    expect(mockActorService.enterExecutionUnit).not.toHaveBeenCalled();
    expect(mockActorService.sendAndSync).not.toHaveBeenCalledWith(runbookId, delegateSteps, {
      type: 'DELEGATE_FRONTIER_CONSUMED',
    });
    expect(mockEmitter.emit).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'STEP_ENTERED' }),
    );
  });

  it('releases the run from the session stack when the frontier refusal fires', async () => {
    mockManager.load.mockResolvedValue(
      frontierLoopState([persistedFrontierEntry('1.1', 'child-a.runbook.md', 'rdtk_pending')]),
    );

    await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(singleDelegateFrontierSteps()),
      '/tmp',
      asEmitter(mockEmitter),
    );

    // The stranding assertion: the default 'stack-pop' release must have run,
    // so the refused run is no longer targeted by the session. Asserted by
    // exact arguments — the bare form deletes claims, the retaining form is
    // `release-runbook`'s, and a mode that silently swapped them would still
    // satisfy a bare call-count check.
    expect(mockSessionService.releaseRunbook).toHaveBeenCalledTimes(1);
    expect(mockSessionService.releaseRunbook).toHaveBeenCalledWith(runbookId);
  });

  it('releases a claimed child through releaseRunbook when the frontier refusal fires', async () => {
    mockManager.load.mockResolvedValue(
      frontierLoopState([persistedFrontierEntry('1.1', 'child-a.runbook.md', 'rdtk_pending')]),
    );

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(singleDelegateFrontierSteps()),
      '/tmp',
      asEmitter(mockEmitter),
      { terminalReleaseMode: 'release-runbook' },
    );

    expect(result).toBe('stopped');
    expect(mockSessionService.releaseRunbook).toHaveBeenCalledWith(runbookId, {
      retainClaimsAsTerminal: true,
    });
  });

  // The projection refusal is the sibling failure of the missing-deriver one
  // above: the authority IS present, but it cannot reproduce the persisted
  // frontier. `projectDelegateFrontier` throws for that, and the throw must be
  // caught here for the same reason — an escaping error unwinds past the
  // emitter and `applyExecutionTerminalRelease`, leaving the refused run on the
  // session stack as the active runbook for every later bare command.
  //
  // Two distinct entry paths reach the throw and both are pinned below:
  //   1. the derived bearer does not hash to the persisted verifier;
  //   2. the deriver itself throws — what a rotated run-control claim does,
  //      since the descriptor then names a superseded issuer claim.
  const FRONTIER_PROJECTION_PREFIX =
    'Delegation frontier cannot be projected by the presented claim authority';
  const rotatedIssuerDeriver = () => {
    throw new Error('Delegation credential belongs to a different issuer claim');
  };

  it('refuses a frontier whose derived credential fails hash verification as a coded stop', async () => {
    const delegateSteps = singleDelegateFrontierSteps();

    mockManager.load.mockResolvedValue(
      frontierLoopState([persistedFrontierEntry('1.1', 'child-a.runbook.md', 'rdtk_pending')]),
    );

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(delegateSteps),
      '/tmp',
      asEmitter(mockEmitter),
      // Derives a well-formed bearer that is not the one the frontier recorded.
      { delegationRuntime: frontierProjectionRuntime(() => 'rdtk_other') },
    );

    expect(result).toBe('stopped');
    // RD-821 (DELEGATION_INVARIANT_VIOLATED) — the same code core already
    // attaches to this exact pair of conditions on the delegation echo seam.
    // The detail names the frontier id and never the bearer.
    const message = `${FRONTIER_PROJECTION_PREFIX}: Derived delegation credential does not match frontier 1.1`;
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'ERROR_OCCURRED',
      payload: { message, code: 'RD-821' },
    });
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'RUNBOOK_STOPPED',
      payload: { position: { current: '1', total: 1, substep: '1' }, message },
    });

    // None of the frontier-dependent work may run on the refusal path.
    expect(mockActorService.enterExecutionUnit).not.toHaveBeenCalled();
    expect(mockActorService.sendAndSync).not.toHaveBeenCalledWith(runbookId, delegateSteps, {
      type: 'DELEGATE_FRONTIER_CONSUMED',
    });
    expect(mockEmitter.emit).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'STEP_ENTERED' }),
    );
  });

  it('refuses a frontier a rotated issuing claim can no longer derive as a coded stop', async () => {
    const delegateSteps = singleDelegateFrontierSteps();

    mockManager.load.mockResolvedValue(
      frontierLoopState([persistedFrontierEntry('1.1', 'child-a.runbook.md', 'rdtk_pending')]),
    );

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(delegateSteps),
      '/tmp',
      asEmitter(mockEmitter),
      { delegationRuntime: frontierProjectionRuntime(rotatedIssuerDeriver) },
    );

    expect(result).toBe('stopped');
    const message = `${FRONTIER_PROJECTION_PREFIX}: Delegation credential belongs to a different issuer claim`;
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'ERROR_OCCURRED',
      payload: { message, code: 'RD-821' },
    });
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'RUNBOOK_STOPPED',
      payload: { position: { current: '1', total: 1, substep: '1' }, message },
    });

    expect(mockActorService.enterExecutionUnit).not.toHaveBeenCalled();
    expect(mockActorService.sendAndSync).not.toHaveBeenCalledWith(runbookId, delegateSteps, {
      type: 'DELEGATE_FRONTIER_CONSUMED',
    });
    expect(mockEmitter.emit).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'STEP_ENTERED' }),
    );
  });

  it('releases the run from the session stack when the frontier projection is refused', async () => {
    mockManager.load.mockResolvedValue(
      frontierLoopState([persistedFrontierEntry('1.1', 'child-a.runbook.md', 'rdtk_pending')]),
    );

    await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(singleDelegateFrontierSteps()),
      '/tmp',
      asEmitter(mockEmitter),
      { delegationRuntime: frontierProjectionRuntime(() => 'rdtk_other') },
    );

    // The stranding assertion: the default 'stack-pop' release must have run,
    // so the refused run is no longer targeted by the session. Asserted by
    // exact arguments — the bare form deletes claims, the retaining form is
    // `release-runbook`'s, and a mode that silently swapped them would still
    // satisfy a bare call-count check.
    expect(mockSessionService.releaseRunbook).toHaveBeenCalledTimes(1);
    expect(mockSessionService.releaseRunbook).toHaveBeenCalledWith(runbookId);
  });

  it('releases a claimed child through releaseRunbook when the frontier projection is refused', async () => {
    mockManager.load.mockResolvedValue(
      frontierLoopState([persistedFrontierEntry('1.1', 'child-a.runbook.md', 'rdtk_pending')]),
    );

    // The rotated-issuer path releases exactly like the hash-mismatch one: both
    // enter the catch, so neither may strand the claimed child.
    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(singleDelegateFrontierSteps()),
      '/tmp',
      asEmitter(mockEmitter),
      {
        terminalReleaseMode: 'release-runbook',
        delegationRuntime: frontierProjectionRuntime(rotatedIssuerDeriver),
      },
    );

    expect(result).toBe('stopped');
    expect(mockSessionService.releaseRunbook).toHaveBeenCalledWith(runbookId, {
      retainClaimsAsTerminal: true,
    });
  });

  // ---------------------------------------------------------------------------
  // F6 — one condition, one code, across both entry points.
  //
  // `rundown run` and `rundown collect` drive the SAME core re-entry frontier
  // seam. Before the consolidation the loop reported a consume failure with no
  // code at all while `collect` reported `COLLECT_OPERATION_FAILED`, and the
  // loop's missing-authority stop carried no `reason` while the machine-owned
  // issuance refusal for the same condition carries
  // `reason: 'actor_context_required'`. The collect side of each pairing is
  // pinned in `packages/core/__tests__/runbook/collection-service.test.ts`.
  // ---------------------------------------------------------------------------

  it('refuses a frontier consume failure with a coded, positioned stop', async () => {
    const delegateSteps = singleDelegateFrontierSteps();

    mockManager.load.mockResolvedValue(
      frontierLoopState([persistedFrontierEntry('1.1', 'child-a.runbook.md', 'rdtk_retry_a')]),
    );
    // Projection succeeds; the DELEGATE_FRONTIER_CONSUMED sync does not.
    mockActorService.sendAndSync.mockResolvedValue(null);

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(delegateSteps),
      '/tmp',
      asEmitter(mockEmitter),
      { delegationRuntime: frontierProjectionRuntime(() => 'rdtk_retry_a') },
    );

    expect(result).toBe('stopped');
    const consumeFailedMessage =
      'Failed to consume delegation frontier after re-entry; the frontier is still pending, retry the run';
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'ERROR_OCCURRED',
      payload: {
        message: consumeFailedMessage,
        code: actualCore.ErrorCodes.DELEGATION_FRONTIER_CONSUME_FAILED.code,
      },
    });
    // The corrective stop, positioned like every other refusal in this loop.
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'RUNBOOK_STOPPED',
      payload: {
        position: { current: '1', total: 1, substep: '1' },
        message: consumeFailedMessage,
      },
    });
    // The freshly derived bearers must NOT reach the stream: the frontier is
    // still persisted, so a later attempt re-projects and re-consumes it, and
    // tokens surfaced now would be orphaned by that retry.
    expect(mockEmitter.emit).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'STEP_ENTERED' }),
    );
    expect(mockSessionService.releaseRunbook).toHaveBeenCalledTimes(1);
    expect(mockSessionService.releaseRunbook).toHaveBeenCalledWith(runbookId);
  });

  it('rejects a structurally malformed persisted frontier rather than projecting it', async () => {
    // `RunbookState.snapshot` is typed `unknown`, so a frontier read out of it
    // cannot be trusted on type alone. Core's collect path validates every entry
    // and throws `InvalidRunbookStateError` on a malformed blob (no-migration
    // rule); the loop reaches the same persisted data and must not trust it.
    mockManager.load.mockResolvedValue(frontierLoopState(['not-an-entry']));

    await expect(
      runExecutionLoop(
        asManager(mockManager),
        runbookId,
        asSteps(singleDelegateFrontierSteps()),
        '/tmp',
        asEmitter(mockEmitter),
        { delegationRuntime: frontierProjectionRuntime(() => 'rdtk_retry_a') },
      ),
    ).rejects.toBeInstanceOf(actualCore.InvalidRunbookStateError);
  });

  it('rolls back existing inline child session activation when intent consumption fails', async () => {
    const childRunId = actualCore.assertRunId(`rd_${'2'.repeat(32)}`);
    const inlineLaunch = {
      parentRunId: runbookId,
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: '1|',
      parentEntry: 1,
      childRunId,
      childRunbookPath: 'child.runbook.md',
      childRunbookRef: { source: 'project', path: 'child.runbook.md' },
      contextSnapshot: {
        RunId: runbookId,
        ContextId: 'ctx-unit',
        WorkPath: '.rundown/work',
      },
    };
    const inlineSteps: LooseStep[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Parent step',
        substeps: [
          {
            id: '1',
            description: 'Inline child',
            runbooks: ['child.runbook.md'],
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
        ],
        transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
      },
    ];
    const parentLinkage = {
      kind: 'inline',
      parentRunId: runbookId,
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: '1|',
      parentEntry: 1,
    };
    const parentState = makeLoopState('1', {
      lifecycle: 'running',
      substep: '1',
      activeFrameKey: '1|',
      activeEntry: 1,
      substepStates: [
        {
          id: '1',
          frameKey: '1|',
          status: 'running',
          inline: {
            childRunbookPath: 'child.runbook.md',
            childRunbookRef: { source: 'project', path: 'child.runbook.md' },
            contextSnapshot: inlineLaunch.contextSnapshot,
            childRunId,
            createdAt: '2026-05-30T00:00:00.000Z',
            started: null,
          },
        },
      ],
      snapshot: { context: { inlineLaunchIntent: inlineLaunch } },
    });
    const existingChild = {
      ...makeLoopState('1', {
        id: childRunId,
        lifecycle: 'running',
        parentLinkage,
      }),
      runbookSrc: '## 1. Child\nDone',
    };
    mockManager.load
      .mockResolvedValueOnce(parentState)
      .mockResolvedValueOnce(parentState)
      .mockResolvedValueOnce(existingChild);
    mockActorService.enterExecutionUnit.mockResolvedValueOnce({
      kind: 'inline-launch',
      launch: inlineLaunch,
      effects: [
        {
          kind: 'execution_observation',
          event: {
            type: 'STEP_ENTERED',
            payload: {
              position: { current: '1.1', total: 1 },
              stepName: '1',
              description: 'Inline child',
              hasCommand: false,
              isSubstep: true,
              prompted: false,
              artifacts: {},
              inlineLaunch,
            },
          },
        },
      ],
    });
    mockActorService.sendAndSync
      .mockResolvedValueOnce({ state: parentState, snapshot: {} })
      .mockRejectedValueOnce(new Error('consume failed'));

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(inlineSteps),
      mockManager.cwd,
      asEmitter(mockEmitter),
      { output: { executionEvent: jest.fn() } as never },
    );

    expect(result).toBe('stopped');
    // Activated conditionally in the store. The positional `pushRunbook` behind
    // an unlocked `getActive` is the shape this replaced: its answer decided
    // whether the rollback below would fire, and a concurrent push between the
    // read and the write left that decision describing a stack it no longer
    // matched.
    expect(mockSessionService.pushRunbookIfNotActive).toHaveBeenCalledWith(childRunId);
    expect(mockSessionService.pushRunbook).not.toHaveBeenCalled();
    // The rollback names the child it pushed and lets the store decide whether
    // that child is still the top. A `getActive` pre-read followed by the
    // positional pop would remove whatever the top is by then, and the
    // release deletes the popped run's claims — so the absence of both calls is
    // the assertion, not an incidental refactor detail.
    expect(mockSessionService.popRunbookIfActive).toHaveBeenCalledWith(childRunId);
    // The launch span asks the session nothing: both of its writes carry their
    // own condition, so there is no read left whose answer could go stale.
    expect(mockSessionService.getActive).not.toHaveBeenCalled();
    // A consume that threw is a launch span that failed past the latch, so the
    // latch comes off. This is the arm that made the stand-down reachable
    // single-process: the intent survives the failure, so without the release
    // the next observer finds it latched by a live pid and waits on a launch
    // nobody is performing.
    //
    // Carrying the latch record this span wrote, which is what the machine
    // gates the release on — the same record the `INLINE_CHILD_STARTED` above
    // committed, so a release built from a re-probe would clear nothing.
    expect(mockActorService.sendAndSync).toHaveBeenCalledWith(runbookId, inlineSteps, {
      type: 'INLINE_LAUNCH_ABANDONED',
      started: expect.objectContaining({ ownerPid: process.pid }),
    });
    expect(mockSessionService.releaseRunbook).not.toHaveBeenCalledWith(childRunId);
    expect(mockManager.delete).not.toHaveBeenCalledWith(childRunId);
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'ERROR_OCCURRED',
      payload: expect.objectContaining({
        code: core.ErrorCodes.LAUNCH_FAILED.code,
        message: expect.stringContaining('consume failed'),
      }),
    });
    expect(mockActorService.sendAndSync).toHaveBeenNthCalledWith(
      1,
      runbookId,
      inlineSteps,
      expect.objectContaining({ type: 'INLINE_CHILD_STARTED' }),
    );
    expect(mockActorService.sendAndSync).toHaveBeenNthCalledWith(2, runbookId, inlineSteps, {
      type: 'INLINE_LAUNCH_CONSUMED',
    });
    expect(mockActorService.enterExecutionUnit).toHaveBeenCalledTimes(1);
  });

  // The rollback's refusal arms, which no test reached: a `switch` jumps
  // straight to its matching label, so the cases it skips were never executed
  // and mutating them reported as NoCoverage rather than a survivor. Not
  // decoration — the `default` arm `return`s `_exhaustive` OUT of
  // `launchInlineChildFromIntent`, so a refusal that fell through would answer
  // the loop with the session-result object in place of `'stopped'`. Both
  // refusals are reachable here for the same reason the conditional pop exists:
  // this rollback runs while another process may own the child.
  it.each([
    [
      'execution_in_progress',
      {
        kind: 'execution_in_progress' as const,
        runId: actualCore.assertRunId(`rd_${'2'.repeat(32)}`),
        message: 'Run has an execution in progress.',
      },
    ],
    [
      'recovery_required',
      {
        kind: 'recovery_required' as const,
        runId: actualCore.assertRunId(`rd_${'2'.repeat(32)}`),
        epoch: actualCore.assertExecutionEpoch(1),
        message: 'Run ended execution with an unknown outcome.',
      },
    ],
  ])(
    'keeps the consume failure as the outcome when the rollback pop refuses %s',
    async (_label, refusal) => {
      const childRunId = actualCore.assertRunId(`rd_${'2'.repeat(32)}`);
      const inlineLaunch = {
        parentRunId: runbookId,
        parentStepId: '1',
        parentStep: '1',
        parentFrameKey: '1|',
        parentEntry: 1,
        childRunId,
        childRunbookPath: 'child.runbook.md',
        childRunbookRef: { source: 'project', path: 'child.runbook.md' },
        contextSnapshot: { RunId: runbookId, ContextId: 'ctx-unit', WorkPath: '.rundown/work' },
      };
      const inlineSteps: LooseStep[] = [
        {
          kind: 'substeps',
          name: '1',
          description: 'Parent step',
          substeps: [
            {
              id: '1',
              description: 'Inline child',
              runbooks: ['child.runbook.md'],
              transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
            },
          ],
          transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
        },
      ];
      const parentState = makeLoopState('1', {
        lifecycle: 'running',
        substep: '1',
        activeFrameKey: '1|',
        activeEntry: 1,
        substepStates: [
          {
            id: '1',
            frameKey: '1|',
            status: 'running',
            inline: {
              childRunbookPath: 'child.runbook.md',
              childRunbookRef: { source: 'project', path: 'child.runbook.md' },
              contextSnapshot: inlineLaunch.contextSnapshot,
              childRunId,
              createdAt: '2026-05-30T00:00:00.000Z',
              started: null,
            },
          },
        ],
        snapshot: { context: { inlineLaunchIntent: inlineLaunch } },
      });
      const existingChild = {
        ...makeLoopState('1', {
          id: childRunId,
          lifecycle: 'running',
          parentLinkage: {
            kind: 'inline',
            parentRunId: runbookId,
            parentStepId: '1',
            parentStep: '1',
            parentFrameKey: '1|',
            parentEntry: 1,
          },
        }),
        runbookSrc: '## 1. Child\nDone',
      };
      mockManager.load
        .mockResolvedValueOnce(parentState)
        .mockResolvedValueOnce(parentState)
        .mockResolvedValueOnce(existingChild);
      mockActorService.enterExecutionUnit.mockResolvedValueOnce({
        kind: 'inline-launch',
        launch: inlineLaunch,
        effects: [
          {
            kind: 'execution_observation',
            event: {
              type: 'STEP_ENTERED',
              payload: {
                position: { current: '1.1', total: 1 },
                stepName: '1',
                description: 'Inline child',
                hasCommand: false,
                isSubstep: true,
                prompted: false,
                artifacts: {},
                inlineLaunch,
              },
            },
          },
        ],
      });
      mockActorService.sendAndSync
        .mockResolvedValueOnce({ state: parentState, snapshot: {} })
        .mockRejectedValueOnce(new Error('consume failed'));
      mockSessionService.popRunbookIfActive.mockResolvedValue(refusal);

      const result = await runExecutionLoop(
        asManager(mockManager),
        runbookId,
        asSteps(inlineSteps),
        mockManager.cwd,
        asEmitter(mockEmitter),
        { output: { executionEvent: jest.fn() } as never },
      );

      // The refused pop is absorbed: the consume failure stays the outcome, and
      // the loop is answered with a loop result rather than a session envelope.
      expect(result).toBe('stopped');
      expect(mockSessionService.popRunbookIfActive).toHaveBeenCalledWith(childRunId);
      expect(mockEmitter.emit).toHaveBeenCalledWith({
        type: 'ERROR_OCCURRED',
        payload: expect.objectContaining({
          code: core.ErrorCodes.LAUNCH_FAILED.code,
          message: expect.stringContaining('consume failed'),
        }),
      });
    },
  );

  // The other half of the rollback's condition: it undoes an activation this
  // span PERFORMED, not whatever the session happens to be targeting.
  //
  // The distinction only exists because the activation is conditional. When the
  // child already held the top, this span wrote nothing — something else
  // activated it, for a reason this span does not know — and popping it because
  // a consume failed here would remove a run on someone else's behalf, taking
  // every claim controlling it along with it. That is the same
  // unrecoverable-bearer-loss shape the conditional pop exists to prevent,
  // reached by treating "the child is active" as "I made it active".
  //
  // Pinned as its own case because the failure is invisible from the sibling
  // above: both end with the consume failure as the outcome and `stopped` as the
  // result, and they differ only in whether the session was written on the way
  // out.
  it('does not roll back an activation it did not perform when the consume fails', async () => {
    const childRunId = actualCore.assertRunId(`rd_${'2'.repeat(32)}`);
    const inlineLaunch = {
      parentRunId: runbookId,
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: '1|',
      parentEntry: 1,
      childRunId,
      childRunbookPath: 'child.runbook.md',
      childRunbookRef: { source: 'project', path: 'child.runbook.md' },
      contextSnapshot: { RunId: runbookId, ContextId: 'ctx-unit', WorkPath: '.rundown/work' },
    };
    const inlineSteps: LooseStep[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Parent step',
        substeps: [
          {
            id: '1',
            description: 'Inline child',
            runbooks: ['child.runbook.md'],
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
        ],
        transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
      },
    ];
    const parentState = makeLoopState('1', {
      lifecycle: 'running',
      substep: '1',
      activeFrameKey: '1|',
      activeEntry: 1,
      substepStates: [
        {
          id: '1',
          frameKey: '1|',
          status: 'running',
          inline: {
            childRunbookPath: 'child.runbook.md',
            childRunbookRef: { source: 'project', path: 'child.runbook.md' },
            contextSnapshot: inlineLaunch.contextSnapshot,
            childRunId,
            createdAt: '2026-05-30T00:00:00.000Z',
            started: null,
          },
        },
      ],
      snapshot: { context: { inlineLaunchIntent: inlineLaunch } },
    });
    const existingChild = {
      ...makeLoopState('1', {
        id: childRunId,
        lifecycle: 'running',
        parentLinkage: {
          kind: 'inline',
          parentRunId: runbookId,
          parentStepId: '1',
          parentStep: '1',
          parentFrameKey: '1|',
          parentEntry: 1,
        },
      }),
      runbookSrc: '## 1. Child\nDone',
    };

    mockManager.load
      .mockResolvedValueOnce(parentState)
      .mockResolvedValueOnce(parentState)
      .mockResolvedValueOnce(existingChild);
    // The child already holds the top, so the conditional activation writes
    // nothing and reports as much.
    mockSessionService.pushRunbookIfNotActive.mockResolvedValue({ status: 'already-active' });
    mockActorService.enterExecutionUnit.mockResolvedValueOnce({
      kind: 'inline-launch',
      launch: inlineLaunch,
      effects: [
        {
          kind: 'execution_observation',
          event: {
            type: 'STEP_ENTERED',
            payload: {
              position: { current: '1.1', total: 1 },
              stepName: '1',
              description: 'Inline child',
              hasCommand: false,
              isSubstep: true,
              prompted: false,
              artifacts: {},
              inlineLaunch,
            },
          },
        },
      ],
    });
    mockActorService.sendAndSync
      .mockResolvedValueOnce({ state: parentState, snapshot: {} })
      .mockRejectedValueOnce(new Error('consume failed'));

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(inlineSteps),
      mockManager.cwd,
      asEmitter(mockEmitter),
      { output: { executionEvent: jest.fn() } as never },
    );

    // The consume failure is still the outcome; only the session is spared.
    expect(result).toBe('stopped');
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'ERROR_OCCURRED',
      payload: expect.objectContaining({
        code: core.ErrorCodes.LAUNCH_FAILED.code,
        message: expect.stringContaining('consume failed'),
      }),
    });
    expect(mockSessionService.popRunbookIfActive).not.toHaveBeenCalled();
    expect(mockSessionService.releaseRunbook).not.toHaveBeenCalled();
  });

  it("repairs an existing inline child's missing latch, activates child, then consumes intent", async () => {
    const childRunId = actualCore.assertRunId(`rd_${'2'.repeat(32)}`);
    const inlineLaunch = {
      parentRunId: runbookId,
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: '1|',
      parentEntry: 1,
      childRunId,
      childRunbookPath: 'child.runbook.md',
      childRunbookRef: { source: 'project', path: 'child.runbook.md' },
      contextSnapshot: {
        RunId: runbookId,
        ContextId: 'ctx-unit',
        WorkPath: '.rundown/work',
      },
    };
    const inlineSteps: LooseStep[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Parent step',
        substeps: [
          {
            id: '1',
            description: 'Inline child',
            runbooks: ['child.runbook.md'],
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
        ],
        transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
      },
    ];
    const parentLinkage = {
      kind: 'inline',
      parentRunId: runbookId,
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: '1|',
      parentEntry: 1,
    };
    const parentState = makeLoopState('1', {
      lifecycle: 'running',
      substep: '1',
      activeFrameKey: '1|',
      activeEntry: 1,
      substepStates: [
        {
          id: '1',
          frameKey: '1|',
          status: 'running',
          inline: {
            childRunbookPath: 'child.runbook.md',
            childRunbookRef: { source: 'project', path: 'child.runbook.md' },
            contextSnapshot: inlineLaunch.contextSnapshot,
            childRunId,
            createdAt: '2026-05-30T00:00:00.000Z',
            started: null,
          },
        },
      ],
      snapshot: { context: { inlineLaunchIntent: inlineLaunch } },
    });
    const existingChild = {
      ...makeLoopState('1', {
        id: childRunId,
        lifecycle: 'running',
        parentLinkage,
      }),
      runbookSrc: '## 1. Child\nDone',
    };

    mockManager.load
      .mockResolvedValueOnce(parentState)
      .mockResolvedValueOnce(parentState)
      .mockResolvedValueOnce(existingChild)
      .mockResolvedValue(existingChild);
    mockActorService.enterExecutionUnit.mockResolvedValueOnce({
      kind: 'inline-launch',
      launch: inlineLaunch,
      effects: [
        {
          kind: 'execution_observation',
          event: {
            type: 'STEP_ENTERED',
            payload: {
              position: { current: '1.1', total: 1 },
              stepName: '1',
              description: 'Inline child',
              hasCommand: false,
              isSubstep: true,
              prompted: false,
              artifacts: {},
              inlineLaunch,
            },
          },
        },
      ],
    });
    mockActorService.sendAndSync
      .mockResolvedValueOnce({ state: parentState, snapshot: {} })
      .mockResolvedValueOnce({ state: parentState, snapshot: {} });

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(inlineSteps),
      mockManager.cwd,
      asEmitter(mockEmitter),
      { output: { executionEvent: jest.fn() } as never },
    );

    expect(result).toBe('waiting');
    expect(mockActorService.sendAndSync).toHaveBeenNthCalledWith(
      1,
      runbookId,
      inlineSteps,
      expect.objectContaining({
        type: 'INLINE_CHILD_STARTED',
        parentStepId: '1',
        parentFrameKey: '1|',
        childRunId,
      }),
    );
    // The repair ACTIVATES the child, and does so only here — core's
    // reactivation seam handed this loop the parent without touching the
    // session, precisely because at that point the launch might have belonged
    // to a live owner. Winning the latch above is what made it this process's
    // to activate.
    expect(mockSessionService.pushRunbookIfNotActive).toHaveBeenCalledWith(childRunId);
    expect(mockSessionService.pushRunbook).not.toHaveBeenCalled();
    expect(mockActorService.sendAndSync).toHaveBeenNthCalledWith(2, runbookId, inlineSteps, {
      type: 'INLINE_LAUNCH_CONSUMED',
    });
    // The consume released the latch as part of clearing the intent, so the
    // scope is disarmed rather than firing a second, redundant release for a
    // launch that is over. `keep()` is what makes that a decision rather than an
    // accident of ordering.
    //
    // Matched on the type alone. An exact-literal negative would also pass if a
    // release were sent carrying a different payload, which is the one way this
    // assertion could go quietly stale.
    expect(mockActorService.sendAndSync).not.toHaveBeenCalledWith(
      runbookId,
      inlineSteps,
      expect.objectContaining({ type: 'INLINE_LAUNCH_ABANDONED' }),
    );
    // Adoption was refused here, so no bearer is announced for the resumed child.
    expect(mockEmitter.emit).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'RUNBOOK_STARTED' }),
    );
  });

  // A second observer of ONE inline launch intent, re-entering SEQUENTIALLY
  // from inside the first observer's launch span. This is not a contention
  // test and must not be read as one: the second loop is driven by re-entry
  // from inside the `resolveRunbookRef` mock, the compare-and-swap seam beneath
  // it is a hand-written double with no SQLite, no `state_version` and no
  // retry, and a sequential implementation of the latch passes it. Real
  // contention — two observers holding the same version against a real store —
  // is pinned in `__tests__/services/inline-launch-latch.test.ts`.
  //
  // What it does pin is the launch span's ENTRY. The intent names a FIXED
  // `childRunId`, and `startRunbook` → `launchRunbook` opens with an
  // unconditional `manager.create` for it, whose `RunbookStateManager.save`
  // reads-then-inserts — so two observers inside the span race a bare
  // `INSERT INTO runs` and the loser gets an untyped SQLITE_CONSTRAINT throw.
  // `resolveRunbookRef` is the span's gate: nothing between it and
  // `manager.create` can refuse, so one entry is one create.
  //
  // The contender is injected AT that gate rather than at the old pre-read
  // precheck. A hook on the precheck would go vacuous the moment the decision
  // moves inside the compare-and-swap; this one stays on live control flow
  // either way. `injected` pins that the re-entry actually happened.
  it('stands a re-entrant second observer of the same intent down outside the launch span', async () => {
    const childRunId = actualCore.assertRunId(`rd_${'2'.repeat(32)}`);
    const inlineLaunch = {
      parentRunId: runbookId,
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: '1|',
      parentEntry: 1,
      childRunId,
      childRunbookPath: 'child.runbook.md',
      childRunbookRef: { source: 'project', path: 'child.runbook.md' },
      contextSnapshot: {
        RunId: runbookId,
        ContextId: 'ctx-unit',
        WorkPath: '.rundown/work',
      },
    };
    const inlineSteps: LooseStep[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Parent step',
        substeps: [
          {
            id: '1',
            description: 'Inline child',
            runbooks: ['child.runbook.md'],
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
        ],
        transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
      },
    ];
    const parentWith = (
      started: InlineLaunchStart | null,
      intent: unknown = inlineLaunch,
    ): Record<string, unknown> =>
      makeLoopState('1', {
        lifecycle: 'running',
        substep: '1',
        activeFrameKey: '1|',
        activeEntry: 1,
        substepStates: [
          {
            id: '1',
            frameKey: '1|',
            status: 'running',
            inline: {
              childRunbookPath: 'child.runbook.md',
              childRunbookRef: { source: 'project', path: 'child.runbook.md' },
              contextSnapshot: inlineLaunch.contextSnapshot,
              childRunId,
              createdAt: '2026-05-30T00:00:00.000Z',
              started,
            },
          },
        ],
        snapshot: { context: { inlineLaunchIntent: intent } },
      });

    // The one persisted parent row both observers read and write. Every seam
    // below reads it fresh, so a commit by one observer is visible to the other
    // — which is the whole point of the interleave.
    let parent = parentWith(null);
    let latched: InlineLaunchStart | null = null;
    mockManager.load.mockImplementation(async (id: string) => (id === runbookId ? parent : null));
    mockManager.mutateStateReturning = mockFn<MutateStateReturningSignature>().mockImplementation(
      async (_id, build) => {
        const { next, value } = await build(parent);
        if (next) parent = next;
        return { state: next ?? parent, value };
      },
    );
    // The machine events this path raises, applied to the shared row exactly as
    // the real `sendAndSync` / `prepareActorMutation` pair would.
    mockActorService.sendAndSync.mockImplementation(
      async (
        _id: string,
        _steps: unknown,
        event: { type: string; started?: InlineLaunchStart },
      ) => {
        if (event.type === 'INLINE_CHILD_STARTED') {
          // The contender must read back the winner's OWN latch record, owner
          // and all: both observers are this process here, so the liveness probe
          // the contender runs finds a live owner and it stands down. A canned
          // record would decide that question in the fixture instead.
          latched = event.started ?? null;
          parent = parentWith(latched);
        }
        if (event.type === 'INLINE_LAUNCH_CONSUMED') {
          parent = parentWith(latched, undefined);
        }
        return { state: parent, snapshot: {} };
      },
    );
    mockActorService.enterExecutionUnit.mockResolvedValue({
      kind: 'inline-launch',
      launch: inlineLaunch,
      effects: [
        {
          kind: 'execution_observation',
          event: {
            type: 'STEP_ENTERED',
            payload: {
              position: { current: '1.1', total: 1 },
              stepName: '1',
              description: 'Inline child',
              hasCommand: false,
              isSubstep: true,
              prompted: false,
              artifacts: {},
              inlineLaunch,
            },
          },
        },
      ],
    });

    const driveLoop = () =>
      runExecutionLoop(
        asManager(mockManager),
        runbookId,
        asSteps(inlineSteps),
        mockManager.cwd,
        asEmitter(mockEmitter),
        // `warning` is part of the double because the contender stands down
        // through the arm that names the process holding the launch.
        { output: { executionEvent: jest.fn(), warning: jest.fn() } as never },
      );

    let injected = false;
    let contender: 'done' | 'stopped' | 'waiting' | undefined;
    mockedResolveRunbookRef.mockImplementation(async () => {
      if (!injected) {
        injected = true;
        contender = await driveLoop();
      }
      return {
        ok: false,
        reason: 'file-missing',
        runbookRef: { source: 'project', path: 'child.runbook.md' },
      };
    });

    const first = await driveLoop();

    expect(injected).toBe(true);
    // One entry into the launch span across both observers, so one
    // `manager.create` for the fixed child run id.
    expect(mockedResolveRunbookRef).toHaveBeenCalledTimes(1);
    // The contender saw the latch already taken and stood down without
    // launching. It reports `waiting`, exactly as an observer of a superseded
    // intent does — the launch is someone else's, not this observer's failure.
    expect(contender).toBe('waiting');
    expect(first).toBe('stopped');
  });

  // The latch's own decisions now have a home of their own: every arm is
  // decided and asserted against a real store in
  // `__tests__/services/inline-launch-latch.test.ts`. What remains here is the
  // other half — the WIRING each arm reaches through: which error this loop
  // emits for a refusal, what it returns, and what it declines to do next.
  // Deleting these would leave the arms proven and their consequences unpinned.
  //
  // The `{ next, value }` assertions are kept alongside the loop-level ones
  // because they are what identifies the arm a run took: no observable
  // downstream of the latch distinguishes `superseded` from `already-latched`
  // when no child exists — both return `waiting`, while only the latter carries
  // the `existingChild` the adoption branch needs — and `next: null` is the
  // only place "refused without writing" separates from "refused after
  // writing".
  //
  // Read the scoped mutation report that opened #759 the way CLAUDE.md says to:
  // `if (existingChild) {}` surviving means "this module's own unit tests do not
  // kill it independently", NOT "nothing in the suite covers this". The linkage
  // refusal is in fact killed by `__tests__/integration/inline-child-launch.test.ts`
  // ('refuses to adopt an inline child launched at a superseded frame entry'),
  // which the Stryker sandbox excludes. The `inactive` arm had no such backstop.
  describe('inline-launch latch refusal arms', () => {
    const childRunId = actualCore.assertRunId(`rd_${'2'.repeat(32)}`);
    const contextSnapshot = {
      RunId: runbookId,
      ContextId: 'ctx-unit',
      WorkPath: '.rundown/work',
    };
    const inlineLaunch = {
      parentRunId: runbookId,
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: '1|',
      parentEntry: 1,
      childRunId,
      childRunbookPath: 'child.runbook.md',
      childRunbookRef: { source: 'project', path: 'child.runbook.md' },
      contextSnapshot,
    };
    const inlineSteps: LooseStep[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Parent step',
        substeps: [
          {
            id: '1',
            description: 'Inline child',
            runbooks: ['child.runbook.md'],
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
        ],
        transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
      },
    ];
    const parentWith = (
      started: InlineLaunchStart | null = null,
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> =>
      makeLoopState('1', {
        lifecycle: 'running',
        substep: '1',
        activeFrameKey: '1|',
        activeEntry: 1,
        substepStates: [
          {
            id: '1',
            frameKey: '1|',
            status: 'running',
            inline: {
              childRunbookPath: 'child.runbook.md',
              childRunbookRef: { source: 'project', path: 'child.runbook.md' },
              contextSnapshot,
              childRunId,
              createdAt: '2026-05-30T00:00:00.000Z',
              started,
            },
          },
        ],
        snapshot: { context: { inlineLaunchIntent: inlineLaunch } },
        ...overrides,
      });

    /**
     * A latch held by a process that is definitely running: this one.
     *
     * Built through the production recorder rather than by hand, so the recorded
     * start id is the one THIS host reads and the liveness probe cannot answer
     * "dead" on a mismatch the fixture invented.
     */
    const heldByThisProcess = (): InlineLaunchStart =>
      actualCore.recordInlineLaunchStart('2026-05-30T00:00:01.000Z');

    /**
     * A latch left behind by a process that is provably gone.
     *
     * `DEAD_PID` is above every platform's pid_max (Linux 4194304, macOS 99998),
     * so `kill(pid, 0)` is always ESRCH — unlike a spawned-and-reaped pid, which
     * is only dead until the OS recycles it.
     */
    const heldByDeadProcess = (): InlineLaunchStart => ({
      at: '2026-05-30T00:00:01.000Z',
      ownerPid: DEAD_PID,
      ownerStartId: null,
    });

    /**
     * Linkage a persisted inline child carries when it belongs to this launch.
     *
     * Each refusal case below diverges from it in exactly one coordinate, so the
     * classification under test is the only thing that differs between them.
     */
    const matchingChildLinkage: InlineLinkage = {
      kind: 'inline',
      parentRunId: runbookId,
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: '1|' as FrameKey,
      parentEntry: 1,
    };
    // Typed `ParentLinkage`, not `unknown`: an unrepresentable linkage would
    // refuse through the classifier's `kind !== 'inline'` arm and pass the test
    // while proving nothing about the shape it claims to model. The type is what
    // makes the delegated case below an actual delegation — `kind: 'delegation'`
    // carrying a `tokenHash` — rather than a string the classifier merely fails
    // to recognise.
    const childWithLinkage = (linkage: ParentLinkage | undefined): Record<string, unknown> =>
      makeLoopState('1', { id: childRunId, lifecycle: 'running', parentLinkage: linkage });

    /**
     * Every `{ next, value }` the latch's build callback produced, in order.
     *
     * The latch's outcome never reaches an observable of this LOOP verbatim, so
     * the callback's return is the only place the decision this loop then acts
     * on can be read as itself. It is unambiguous: `mutateStateReturning` has
     * exactly one caller reachable from the execution service.
     */
    const latchOutcomes: { next: Record<string, unknown> | null; value: unknown }[] = [];

    const stepEnteredWithInlineLaunch = () => ({
      kind: 'inline-launch' as const,
      launch: inlineLaunch,
      effects: [
        {
          kind: 'execution_observation' as const,
          event: {
            type: 'STEP_ENTERED' as const,
            payload: {
              position: { current: '1.1', total: 1 },
              stepName: '1',
              description: 'Inline child',
              hasCommand: false,
              isSubstep: true,
              prompted: false,
              artifacts: {},
              inlineLaunch,
            },
          },
        },
      ],
    });

    /**
     * The launch path's operator channel, which two arms below write to.
     *
     * A shared double rather than a per-call literal: the diagnostics are the
     * observable difference between "stood down because someone else owns this"
     * and "took over a launch whose owner died", and both otherwise leave the
     * same trace.
     */
    const mockOutput = {
      executionEvent: mockFn<(event: unknown) => void>(),
      warning: mockFn<(text: string) => void>(),
    };

    const driveLoop = () =>
      runExecutionLoop(
        asManager(mockManager),
        runbookId,
        asSteps(inlineSteps),
        mockManager.cwd,
        asEmitter(mockEmitter),
        { output: mockOutput as never },
      );

    /**
     * Install the compare-and-swap double, recording every decision it commits.
     *
     * `row` is the state the latch's own read returns. It defaults to whatever
     * `manager.load` serves — the ordinary case, where the loop and the latch
     * read the same row — and is passed explicitly only to model a row that
     * CHANGED between the two reads, which is the one thing the compare-and-swap
     * exists to catch.
     */
    const captureLatch = (row?: Record<string, unknown>) => {
      mockManager.mutateStateReturning.mockImplementation(async (id, build) => {
        const current = row ?? (await mockManager.load(id));
        if (!current) return { state: null, value: null };
        const outcome = await build(current);
        latchOutcomes.push(outcome);
        return { state: outcome.next ?? current, value: outcome.value };
      });
    };

    beforeEach(() => {
      latchOutcomes.length = 0;
      // Both halves of the shared double, so no assertion on either can depend
      // on which sibling test ran first.
      mockOutput.warning.mockClear();
      mockOutput.executionEvent.mockClear();
      captureLatch();
      mockActorService.enterExecutionUnit.mockResolvedValue(stepEnteredWithInlineLaunch());
      // Armed by default so that a refusal arm broken by a future edit fails on
      // its own assertion below. Left unarmed, `prepareActorMutation`'s double
      // throws `Actor synchronization failed` the moment a refusal wrongly falls
      // through to the latch write, which kills the mutant with an opaque
      // message instead of naming the arm that stopped refusing.
      mockActorService.sendAndSync.mockResolvedValue({ state: parentWith(), snapshot: {} });
    });

    // The one outcome the compare-and-swap does not decide: `mutateStateReturning`
    // never runs the callback for a run that does not exist. It reaches the loop
    // as its own arm rather than as a `null` beside the union, and lands on the
    // same refusal a terminal parent does — a run that vanished mid-launch is no
    // more launchable than one that ended, and both leave nothing to launch
    // under. Pinned here because the union's own tests cannot see which of the
    // two refusals the loop then emits.
    it('refuses the launch when the parent run has vanished before the latch', async () => {
      mockManager.load.mockImplementation(async (id: string) =>
        id === runbookId ? parentWith() : null,
      );
      // The shape `mutateStateReturning` returns for a missing run, verbatim.
      mockManager.mutateStateReturning.mockImplementation(async () => ({
        state: null,
        value: null,
      }));

      const result = await driveLoop();

      expect(result).toBe('stopped');
      // The callback never ran, so no arm was decided and nothing was written.
      expect(latchOutcomes).toEqual([]);
      expect(mockActorService.sendAndSync).not.toHaveBeenCalled();
      expect(mockedResolveRunbookRef).not.toHaveBeenCalled();
      expect(mockEmitter.emit).toHaveBeenCalledWith({
        type: 'ERROR_OCCURRED',
        payload: {
          message: `Inline parent run ${runbookId} is not active`,
          code: actualCore.ErrorCodes.LAUNCH_FAILED.code,
        },
      });
    });

    // A parent that is ALREADY terminal never reaches the latch — the loop
    // returns at its own opening read — so this arm exists for exactly one
    // situation: the parent went terminal between that read and the latch's own,
    // which is the gap the compare-and-swap exists to close. The latch is
    // therefore handed the terminal row directly, rather than the loop's `load`
    // being counted to guess which reader is second — a count that would silently
    // rebind to any parent read a later change adds ahead of the latch.
    it.each(['completed', 'stopped'] as const)(
      'refuses the launch as inactive when the parent turns %s between the loop read and the latch',
      async (lifecycle) => {
        mockManager.load.mockImplementation(async (id: string) =>
          id === runbookId ? parentWith() : null,
        );
        captureLatch(parentWith(null, { lifecycle }));

        const result = await driveLoop();

        expect(result).toBe('stopped');
        // Refused, and refused before the latch write: a spurious `started`
        // would make every later re-entry of this frame report a launch that
        // never happened.
        expect(latchOutcomes).toEqual([{ next: null, value: { kind: 'inactive' } }]);
        expect(mockActorService.sendAndSync).not.toHaveBeenCalled();
        // Never entered the launch span, so nothing created the child run.
        // `resolveRunbookRef` is the span's gate and therefore the whole proof:
        // an unreached `pushRunbook` would prove nothing here, because this
        // fixture persists no existing child for the adoption branch to push.
        expect(mockedResolveRunbookRef).not.toHaveBeenCalled();
        expect(mockEmitter.emit).toHaveBeenCalledWith({
          type: 'ERROR_OCCURRED',
          payload: {
            message: `Inline parent run ${runbookId} is not active`,
            code: actualCore.ErrorCodes.LAUNCH_FAILED.code,
          },
        });
      },
    );

    // The refusal CodeRabbit blocked #746 on. `classifyInlineChildLinkage` is
    // well covered as a pure function in `execution.test.ts` — every coordinate,
    // and the absent-linkage case — so what is pinned here is the WIRING: that
    // the latch consults it at all, and that a mismatch fails closed instead of
    // adopting a child the parent does not claim. One case per REFUSAL VARIANT
    // is what that needs, because the variants are what the latch and the
    // emitted refusal branch on; a second shape landing on the same variant
    // would re-test the classifier through a longer path.
    it.each<{
      readonly name: string;
      readonly linkage: ParentLinkage;
      readonly mismatch: Record<string, unknown>;
      readonly code: ErrorCodeKey;
      readonly message: string;
    }>([
      {
        name: 'a child launched at a superseded frame entry',
        linkage: { ...matchingChildLinkage, parentEntry: 2 },
        mismatch: { kind: 'superseded-entry', recordedEntry: 2, currentEntry: 1 },
        code: 'INLINE_CHILD_FRAME_SUPERSEDED',
        message:
          `Inline child ${childRunId} was launched at entry 2 of frame 1|, but the parent has ` +
          `re-entered that frame as entry 1. A re-entered frame never adopts the previous ` +
          `entry's child. Finish, stop, or prune run ${childRunId}, then re-enter.`,
      },
      {
        // A genuinely delegated child under the intent's run id: a real
        // `DelegationLinkage`, token hash and all, naming this same parent frame.
        // The type is doing work here — `kind: 'delegated'` would be refused by
        // the classifier's `kind !== 'inline'` arm exactly like an absent
        // linkage, so the test would pass while modelling a state that cannot
        // exist. Only a representable delegation proves the wiring refuses the
        // child a `rundown delegate` would have persisted under this id.
        name: 'a child linked by delegation rather than inline launch',
        linkage: {
          ...matchingChildLinkage,
          kind: 'delegation',
          tokenHash: 'sha256:deadbeef' as DelegationTokenHash,
        },
        mismatch: { kind: 'conflicting-parent' },
        code: 'INLINE_CHILD_LINKAGE_MISMATCH',
        message: `Inline child ${childRunId} has conflicting parent linkage`,
      },
    ])(
      'refuses $name rather than latching over it',
      async ({ linkage, mismatch, code, message }) => {
        const parent = parentWith();
        const existingChild = childWithLinkage(linkage);
        mockManager.load.mockImplementation(async (id: string) => {
          if (id === runbookId) return parent;
          return id === childRunId ? existingChild : null;
        });

        const result = await driveLoop();

        expect(result).toBe('stopped');
        // The parent's `started` is null, so an absent linkage check would have
        // reached `won` and written the latch. `next: null` is what proves the
        // refusal is decided ahead of the write, and the untouched `sendAndSync`
        // is what proves the parent was not advanced.
        expect(latchOutcomes).toEqual([
          { next: null, value: { kind: 'linkage-refused', mismatch } },
        ]);
        expect(mockActorService.sendAndSync).not.toHaveBeenCalled();
        // `pushRunbook` is the proof that matters HERE, and it is the mirror of
        // the `inactive` case above: with a child persisted, an emptied linkage
        // check lands on `won`/`already-latched` CARRYING that child, which
        // routes into the adoption branch and activates it — the very "running
        // child the parent does not claim" this refusal exists to prevent.
        // `getActive` resolves null, so nothing else suppresses the push.
        expect(mockSessionService.pushRunbook).not.toHaveBeenCalled();
        // The symbolic name, not the `RD-830` / `RD-831` the registry assigns
        // these two, is deliberate and specified: `docs/spec/cli-output.md`
        // registers both codes for their title, remediation and doc slug — which
        // is why the emitting switch is typed against `ErrorCodeKey` — while
        // stating that "the emitted `code` value remains the symbolic name,
        // which is what consumers match on". Asserted as such so a later
        // "consistency" edit toward `RD-830` reads as the contract break it is.
        expect(mockEmitter.emit).toHaveBeenCalledWith({
          type: 'ERROR_OCCURRED',
          payload: { message, code },
        });
      },
    );

    // The winning arm's own discriminant. `existingChild` travels on it because
    // both surviving arms carry the child the callback read, and the launch span
    // branches on it — a `won` that dropped it would re-launch a child that
    // already exists.
    it('records a won latch carrying the read-back child when the intent is unclaimed', async () => {
      const parent = parentWith();
      mockManager.load.mockImplementation(async (id: string) => (id === runbookId ? parent : null));
      // Stamps the state from the EVENT rather than returning a canned row, so
      // the committed state below carries the `started` record the latch actually
      // sent. A fixed row would make the identity assertion hold for any record
      // whatsoever, including one unrelated to the event — pass-through proved,
      // content unchecked.
      mockActorService.sendAndSync.mockImplementation(
        async (_id: string, _steps: unknown, event: { started?: InlineLaunchStart }) => ({
          state: parentWith(event.started ?? null),
          snapshot: {},
        }),
      );

      const before = Date.now();
      const result = await driveLoop();
      const after = Date.now();

      expect(latchOutcomes).toHaveLength(1);
      // `reclaimedFrom: null` is the assertion that this launch took a FREE
      // latch. The same arm carries a pid when it took one over from a dead
      // owner, and the two must not be confused: only the second reports a
      // reclamation to the operator.
      expect(latchOutcomes[0]?.value).toEqual({
        kind: 'won',
        existingChild: null,
        reclaimedFrom: null,
        // The scope the span releases through, built by the arm that TOOK the
        // latch. Carried on `won` alone and constructed there rather than by the
        // caller, so a `won` that could be received without a scope — and
        // therefore forgotten — is unrepresentable.
        held: { keep: expect.any(Function), [Symbol.asyncDispose]: expect.any(Function) },
      });
      expect(mockActorService.sendAndSync).toHaveBeenCalledWith(
        runbookId,
        inlineSteps,
        expect.objectContaining({
          type: 'INLINE_CHILD_STARTED',
          parentStepId: '1',
          parentFrameKey: '1|',
          childRunId,
        }),
      );
      // The durable record itself, and the one field of this event whose VALUE
      // nothing else constrains: the type requires a `string`, and the
      // classification only asks whether the record is present, so an empty,
      // malformed or stale stamp persists into `substepStates[].inline.started`
      // with exactly-once still intact. Pinned as a full ISO instant AND as a
      // reading of this run's clock — a shape check alone accepts `new Date(0)`.
      const sent = mockActorService.sendAndSync.mock.calls[0]?.[2] as {
        started: InlineLaunchStart;
      };
      expect(sent.started.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(Date.parse(sent.started.at)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(sent.started.at)).toBeLessThanOrEqual(after);
      // The launcher records ITSELF as the owner. That is what makes the record
      // reclaimable later: a record naming any other process would either stall
      // this launch forever or hand it to a second observer while it runs.
      expect(sent.started).toEqual({
        at: sent.started.at,
        ownerPid: process.pid,
        ownerStartId: actualCore.recordInlineLaunchStart(sent.started.at).ownerStartId,
      });
      // The one arm that writes, and it commits the derived state verbatim, so
      // the record the machine folded in is the record that reaches the store.
      const committed = latchOutcomes[0]?.next as {
        substepStates: { inline: { started: InlineLaunchStart } }[];
      } | null;
      expect(committed?.substepStates[0]?.inline.started).toEqual(sent.started);
      // Entered the launch span exactly once; the ref resolution then fails, so
      // this stops without creating a child.
      expect(mockedResolveRunbookRef).toHaveBeenCalledTimes(1);
      expect(result).toBe('stopped');
    });

    // The two stand-down arms, which differ only in what they carry. Swapping
    // them IS caught where a child exists — `already-latched` carries the
    // `existingChild` the adoption branch reads, so the two resumed-launch tests
    // below fail if it is dropped. It is NOT caught in the no-child case: both
    // arms then answer `waiting` with a null child through two different returns
    // in `launchInlineChildFromIntent`, and the discriminant is the only place
    // the difference survives. That is the case pinned here.
    it('stands down as superseded when the persisted intent no longer names this launch', async () => {
      // Intent consumed by whoever won the launch, exactly as
      // `INLINE_LAUNCH_CONSUMED` leaves it — the observation this loop is
      // acting on is now stale.
      const parent = parentWith(null, { snapshot: { context: {} } });
      mockManager.load.mockImplementation(async (id: string) => (id === runbookId ? parent : null));

      const result = await driveLoop();

      expect(latchOutcomes).toEqual([{ next: null, value: { kind: 'superseded' } }]);
      expect(mockActorService.sendAndSync).not.toHaveBeenCalled();
      expect(mockedResolveRunbookRef).not.toHaveBeenCalled();
      expect(result).toBe('waiting');
    });

    it('stands down as already-latched when a LIVE owner holds the latch and the child is not there yet', async () => {
      // Another observer is inside the launch span right now: it wrote the latch
      // and has not yet reached `manager.create`. Absence of the child run is
      // therefore NOT evidence its owner died — the two states are identical on
      // disk — which is why the owner's liveness, and nothing else, decides this.
      const parent = parentWith(heldByThisProcess());
      mockManager.load.mockImplementation(async (id: string) => (id === runbookId ? parent : null));

      const result = await driveLoop();

      expect(latchOutcomes).toEqual([
        { next: null, value: { kind: 'already-latched', ownerPid: process.pid } },
      ]);
      // Stood down without re-writing the latch it found, and without entering
      // the span the other observer owns — one `manager.create` for this intent.
      expect(mockActorService.sendAndSync).not.toHaveBeenCalled();
      expect(mockedResolveRunbookRef).not.toHaveBeenCalled();
      expect(result).toBe('waiting');
      // The wait is named rather than opaque: the operator is told which process
      // holds the launch, so a launch that never finishes is diagnosable.
      expect(mockOutput.warning).toHaveBeenCalledWith(
        `Inline child ${childRunId} is already being launched by process ${String(process.pid)}. Re-run this command once that launch finishes.`,
      );
    });

    // The same live owner, one moment later: it has reached `manager.create`, so
    // the child now exists. That must not change the answer. Finishing another
    // process's launch is not this observer's to do — activating the child would
    // push a run its owner is about to execute onto THIS session, consume the
    // one-shot intent out from under it, and rotate the bearer it still holds.
    // The dead-owner case is what the adoption branch is for, and it arrives
    // through `won` after reclamation, not through this arm.
    it('stands down without adopting the child a LIVE owner has already created', async () => {
      const parent = parentWith(heldByThisProcess());
      const existingChild = makeLoopState('1', {
        id: childRunId,
        lifecycle: 'running',
        parentLinkage: matchingChildLinkage,
      });
      mockManager.load.mockImplementation(async (id: string) => {
        if (id === runbookId) return parent;
        return id === childRunId ? existingChild : null;
      });

      const result = await driveLoop();

      // The arm carries no child at all, which is what makes the adoption
      // unreachable rather than merely unreached.
      expect(latchOutcomes).toEqual([
        { next: null, value: { kind: 'already-latched', ownerPid: process.pid } },
      ]);
      expect(result).toBe('waiting');
      // The three things adoption would have done to a run this observer does
      // not own, none of which are undone by standing down afterwards.
      expect(mockSessionService.pushRunbook).not.toHaveBeenCalled();
      expect(mockSessionService.adoptRunControlClaim).not.toHaveBeenCalled();
      expect(mockActorService.sendAndSync).not.toHaveBeenCalled();
    });

    // Every stand-down arm, asserted to write NOTHING to the session.
    //
    // This replaces a pair of tests that asserted the opposite for one arm —
    // that `already-latched` undid an activation with a conditional pop. The
    // undo is gone because the activation it undid is gone: core's reactivation
    // seam no longer pushes the child ahead of the latch, so the launch span
    // activates only once it has WON, and a stand-down has nothing of its own to
    // take back.
    //
    // Driven over every arm rather than the one that used to undo, because the
    // property is now uniform and its whole value is that it stays that way.
    // Four of these arms leaked the old speculative activation and were fixed by
    // deleting the push rather than by adding four undo calls; the guarantee
    // worth pinning is the one only deletion buys — that an arm added later
    // inherits it without doing anything. Per-arm undo calls would have produced
    // the same green suite and none of that.
    //
    // `getActive` resolves the CHILD deliberately. Every one of these arms left
    // it resolving `null` before, which is why the undo this suite claimed to
    // cover was barely exercised: the fixture modelled a session that was not
    // targeting the child at all. Pointing it at the child models the state a
    // stand-down must leave untouched, and makes the absent `getActive` call an
    // assertion about the check-then-act shape rather than a coincidence of the
    // fixture.
    //
    // Each row also names the latch arm it must land on. Four of the six answer
    // `stopped`, so the loop result alone cannot tell "this fixture reached the
    // arm in its name" from "this fixture reached SOME refusal" — a staged
    // precondition that stopped modelling its arm would keep passing under its
    // old name, which is the way a table like this rots. `arm` is `null` for the
    // one outcome the compare-and-swap never decides: a run that does not exist
    // never runs the callback, so nothing is recorded.
    it.each<{
      readonly name: string;
      readonly expected: 'stopped' | 'waiting';
      readonly arm: string | null;
      readonly stage: () => void;
    }>([
      {
        name: 'missing (the parent run vanished before the latch)',
        expected: 'stopped',
        arm: null,
        stage: () => {
          mockManager.load.mockImplementation(async (id: string) =>
            id === runbookId ? parentWith() : null,
          );
          mockManager.mutateStateReturning.mockImplementation(async () => ({
            state: null,
            value: null,
          }));
        },
      },
      {
        name: 'inactive (the parent turned terminal between the two reads)',
        expected: 'stopped',
        arm: 'inactive',
        stage: () => {
          mockManager.load.mockImplementation(async (id: string) =>
            id === runbookId ? parentWith() : null,
          );
          captureLatch(parentWith(null, { lifecycle: 'completed' }));
        },
      },
      {
        name: 'superseded (the persisted intent no longer names this launch)',
        expected: 'waiting',
        arm: 'superseded',
        stage: () => {
          const parent = parentWith(null, { snapshot: { context: {} } });
          mockManager.load.mockImplementation(async (id: string) =>
            id === runbookId ? parent : null,
          );
        },
      },
      {
        name: 'linkage-refused (a persisted child the parent does not claim)',
        expected: 'stopped',
        arm: 'linkage-refused',
        stage: () => {
          const parent = parentWith();
          const existingChild = childWithLinkage({ ...matchingChildLinkage, parentEntry: 2 });
          mockManager.load.mockImplementation(async (id: string) => {
            if (id === runbookId) return parent;
            return id === childRunId ? existingChild : null;
          });
        },
      },
      {
        name: 'unrecorded (the substep row records no launch to latch)',
        expected: 'stopped',
        arm: 'unrecorded',
        stage: () => {
          const parent = parentWith(null, {
            substepStates: [{ id: '1', frameKey: '1|', status: 'running' }],
          });
          mockManager.load.mockImplementation(async (id: string) =>
            id === runbookId ? parent : null,
          );
        },
      },
      {
        // The arm that used to undo, and the only one whose precondition
        // GUARANTEES a concurrent stack writer rather than merely allowing one:
        // another live process is inside the launch span right now. A session
        // write from here would land beside that process's writes.
        name: 'already-latched (a live process owns the launch)',
        expected: 'waiting',
        arm: 'already-latched',
        stage: () => {
          const parent = parentWith(heldByThisProcess());
          const existingChild = makeLoopState('1', {
            id: childRunId,
            lifecycle: 'running',
            parentLinkage: matchingChildLinkage,
          });
          mockManager.load.mockImplementation(async (id: string) => {
            if (id === runbookId) return parent;
            return id === childRunId ? existingChild : null;
          });
        },
      },
    ])(
      'leaves the session untouched when the launch stands down as $name',
      async ({ expected, arm, stage }) => {
        // The session already targets the child, so every write below would have
        // something real to reach.
        mockSessionService.getActive.mockResolvedValue({ id: childRunId });
        stage();

        expect(await driveLoop()).toBe(expected);

        // The arm this row is named for, before the property it is here to
        // assert: the session assertions below are only about a stand-down if
        // the stand-down was this one.
        expect(
          latchOutcomes.map((outcome) => (outcome.value as { readonly kind: string } | null)?.kind),
        ).toEqual(arm === null ? [] : [arm]);

        // Named individually rather than counted, so a failure says which write
        // came back. `pushRunbookIfNotActive` is the activation this arm must not
        // perform; the three pops are the undo calls it must no longer need, and
        // `getActive` is the pre-read that would mean a check-then-act shape had
        // returned by another route.
        expect(mockSessionService.pushRunbookIfNotActive).not.toHaveBeenCalled();
        expect(mockSessionService.pushRunbook).not.toHaveBeenCalled();
        expect(mockSessionService.popRunbookIfActive).not.toHaveBeenCalled();
        expect(mockSessionService.releaseRunbook).not.toHaveBeenCalled();
        expect(mockSessionService.getActive).not.toHaveBeenCalled();
      },
    );

    // The two arms that end the turn without an error event, so a line on the
    // operator channel is the only trace they leave. Asserted together because
    // the requirement is one requirement — a `waiting` that writes nothing must
    // say why — and because the two remedies are genuinely different: one waits
    // for a named process, the other re-runs against a parent that moved on.
    it.each<{ readonly name: string; readonly stage: () => void; readonly message: string }>([
      {
        name: 'already-latched names the process to wait for',
        stage: () => {
          const parent = parentWith(heldByThisProcess());
          mockManager.load.mockImplementation(async (id: string) =>
            id === runbookId ? parent : null,
          );
        },
        message:
          `Inline child ${childRunId} is already being launched by process ` +
          `${String(process.pid)}. Re-run this command once that launch finishes.`,
      },
      {
        name: 'superseded names the run that moved on',
        stage: () => {
          const parent = parentWith(null, { snapshot: { context: {} } });
          mockManager.load.mockImplementation(async (id: string) =>
            id === runbookId ? parent : null,
          );
        },
        message:
          `Inline launch of ${childRunId} was superseded: run ${runbookId} no longer carries ` +
          `that launch. Re-run this command to observe its current state.`,
      },
    ])('reports the wait when $name', async ({ stage, message }) => {
      stage();

      expect(await driveLoop()).toBe('waiting');

      expect(mockOutput.warning).toHaveBeenCalledWith(message);
    });

    // The property the compare-and-latch dropped when it replaced the file lock,
    // which reclaimed a crashed holder through exactly this check. Without it
    // the state staged here — latched, no child, owner gone — answers `waiting`
    // on every later observation, forever, with no diagnostic naming why.
    it('reclaims a latch whose owner is gone and enters the launch span', async () => {
      const parent = parentWith(heldByDeadProcess());
      mockManager.load.mockImplementation(async (id: string) => (id === runbookId ? parent : null));
      mockActorService.sendAndSync.mockImplementation(
        async (_id: string, _steps: unknown, event: { started?: InlineLaunchStart }) => ({
          state: parentWith(event.started ?? null),
          snapshot: {},
        }),
      );

      const result = await driveLoop();

      // Reclaimed, and the arm SAYS so: `won` alone would not distinguish taking
      // a free latch from taking one over, and only the second is worth telling
      // the operator about.
      expect(latchOutcomes).toHaveLength(1);
      expect(latchOutcomes[0]?.value).toEqual({
        kind: 'won',
        existingChild: null,
        reclaimedFrom: DEAD_PID,
        held: { keep: expect.any(Function), [Symbol.asyncDispose]: expect.any(Function) },
      });
      // The reclaiming observer records ITSELF as the new owner. Leaving the dead
      // owner in place would let a third observer reclaim the launch this one is
      // now performing — the duplicate `manager.create` the latch exists to
      // prevent, reintroduced by the recovery.
      const sent = mockActorService.sendAndSync.mock.calls[0]?.[2] as {
        readonly type: string;
        readonly started: InlineLaunchStart;
      };
      expect(sent.type).toBe('INLINE_CHILD_STARTED');
      expect(sent.started.ownerPid).toBe(process.pid);
      // Entered the launch span, which is the whole point: the stranded launch
      // is performed rather than waited on. The default ref resolution then
      // fails, so this stops without creating a child.
      expect(mockedResolveRunbookRef).toHaveBeenCalledTimes(1);
      expect(result).toBe('stopped');
      // And the latch this span took is released on the way out. Without it the
      // record would name THIS process — alive, and with no self-pid exemption
      // in the ownership classifier — so the next observation, in this process
      // or any other, would stand down against it forever.
      //
      // The release names the record the reclaim above committed, byte for byte.
      // That identity is what the machine gates on, so a release carrying a
      // freshly-probed record — same process, later instant — would name a latch
      // nobody wrote and clear nothing.
      expect(mockActorService.sendAndSync).toHaveBeenCalledWith(runbookId, inlineSteps, {
        type: 'INLINE_LAUNCH_ABANDONED',
        started: sent.started,
      });
      expect(mockOutput.warning).toHaveBeenCalledWith(
        `Reclaimed the inline launch of ${childRunId} from process ${String(DEAD_PID)}, which is no longer running.`,
      );
    });

    // The other half of the crash window: the dead process got as far as
    // creating the child, then died. The reclaimed launch must be FINISHED —
    // the child activated, not launched a second time — which is what carrying
    // `existingChild` on the `won` arm is for. This is the state that separates
    // reclamation from a fresh launch, and the only arm that reaches the
    // adoption branch now that a live owner's child is left alone.
    it('reclaims a dead owner and finishes the child that launch already created', async () => {
      const parent = parentWith(heldByDeadProcess());
      const existingChild = {
        ...makeLoopState('1', {
          id: childRunId,
          lifecycle: 'running',
          parentLinkage: matchingChildLinkage,
        }),
        // The adoption branch runs the child's own loop, which compiles it from
        // its persisted source.
        runbookSrc: '## 1. Child\nDone',
      };
      mockManager.load.mockImplementation(async (id: string) => {
        if (id === runbookId) return parent;
        return id === childRunId ? existingChild : null;
      });
      // The launch is finished up to the point this test is about, then cut
      // short at the intent consumption. Running the adopted child's own loop
      // would re-enter this block's inline-launch observation forever, and the
      // child's execution is not what the reclamation decides.
      mockActorService.sendAndSync.mockImplementation(
        async (_id: string, _steps: unknown, event: { type: string }) => {
          if (event.type === 'INLINE_LAUNCH_CONSUMED') throw new Error('consume failed');
          return { state: parent, snapshot: {} };
        },
      );

      const result = await driveLoop();

      expect(latchOutcomes).toEqual([
        expect.objectContaining({
          value: expect.objectContaining({
            kind: 'won',
            existingChild,
            reclaimedFrom: DEAD_PID,
          }),
        }),
      ]);
      // Finished rather than relaunched: the child the dead process created is
      // activated, and the launch span is never entered — a second
      // `manager.create` for this intent is exactly what the latch prevents, and
      // recovering the latch must not reintroduce it.
      //
      // Also the case that decides the activation's transaction posture. The
      // child here was abandoned mid-execution by a process that is gone, so it
      // can still hold an execution lease naming a dead pid — and the session
      // ownership preflight refuses on `exec_token IS NOT NULL` alone, with the
      // dead-owner probe living only on the lease-acquisition path. A guarded
      // push would therefore refuse `execution_in_progress` on exactly this
      // recovery, which is why `pushRunbookIfNotActive` uses the unguarded
      // `mutate` that `pushRunbook` does.
      expect(mockSessionService.pushRunbookIfNotActive).toHaveBeenCalledWith(childRunId);
      expect(mockSessionService.pushRunbook).not.toHaveBeenCalled();
      expect(mockedResolveRunbookRef).not.toHaveBeenCalled();
      expect(result).toBe('stopped');
      expect(mockOutput.warning).toHaveBeenCalledWith(
        `Reclaimed the inline launch of ${childRunId} from process ${String(DEAD_PID)}, which is no longer running.`,
      );
    });

    // The two states where the parent's substep row does not record THIS launch.
    // Reading them as `unlatched` is unsound rather than merely imprecise: the
    // latch is written onto that row, so `updateInlineStarted` is a silent
    // no-op for the first and throws an untyped `Inline child run mismatch` out
    // of the compare-and-swap callback for the second. An observer that reported
    // `won` from either would enter the launch span with nothing latched — and
    // so would the next one, racing the bare `INSERT INTO runs`.
    //
    // The second case names a LIVE owner deliberately: a classifier that
    // consulted the wrong row's record anyway would answer `held` and stand
    // down, which is a different wrong answer and must not look like this one.
    it.each<{
      readonly name: string;
      readonly reason: string;
      readonly message: string;
      readonly substepStates: readonly unknown[];
    }>([
      {
        name: 'the substep carries no inline metadata',
        reason: 'no-inline-metadata',
        message: 'carries no inline child metadata',
        substepStates: [{ id: '1', frameKey: '1|', status: 'running' }],
      },
      {
        name: 'the recorded inline metadata names a different child run',
        reason: 'other-child',
        message: 'records a different inline child',
        substepStates: [
          {
            id: '1',
            frameKey: '1|',
            status: 'running',
            inline: {
              childRunbookPath: 'child.runbook.md',
              childRunbookRef: { source: 'project', path: 'child.runbook.md' },
              contextSnapshot,
              childRunId: actualCore.assertRunId(`rd_${'9'.repeat(32)}`),
              createdAt: '2026-05-30T00:00:00.000Z',
              started: heldByThisProcess(),
            },
          },
        ],
      },
    ])(
      'refuses the launch as unrecorded when $name',
      async ({ reason, message, substepStates }) => {
        const parent = parentWith(null, { substepStates });
        mockManager.load.mockImplementation(async (id: string) =>
          id === runbookId ? parent : null,
        );

        const result = await driveLoop();

        expect(latchOutcomes).toEqual([{ next: null, value: { kind: 'unrecorded', reason } }]);
        // Fails closed: nothing written, and the launch span — the only place a
        // second `manager.create` could happen — is never entered.
        expect(mockActorService.sendAndSync).not.toHaveBeenCalled();
        expect(mockedResolveRunbookRef).not.toHaveBeenCalled();
        expect(result).toBe('stopped');
        // Named as inconsistent state with a remedy, not reported as a wait that
        // would never end.
        expect(mockEmitter.emit).toHaveBeenCalledWith({
          type: 'ERROR_OCCURRED',
          payload: {
            message: expect.stringContaining(message),
            code: actualCore.ErrorCodes.LAUNCH_FAILED.code,
          },
        });
      },
    );

    // A parent with no substep rows at all, which is not the same as a parent
    // whose row carries no inline: there is nothing to read the latch off, and
    // the read itself must survive it.
    it('refuses the launch as unrecorded when the parent carries no substep rows', async () => {
      const parent = parentWith(null, { substepStates: undefined });
      mockManager.load.mockImplementation(async (id: string) => (id === runbookId ? parent : null));

      const result = await driveLoop();

      expect(latchOutcomes).toEqual([
        { next: null, value: { kind: 'unrecorded', reason: 'no-inline-metadata' } },
      ]);
      expect(mockActorService.sendAndSync).not.toHaveBeenCalled();
      expect(result).toBe('stopped');
    });

    // The latch is read from the intent's OWN substep and frame. Every other
    // fixture here persists exactly one row, so any lookup that finds a row at
    // all passes them — this one persists three, and puts the two decoys first.
    // Both decoys are latched by a live process, so a lookup that matches on the
    // wrong half of the coordinate reads someone else's launch and stands this
    // one down.
    it('reads the latch from the intent coordinate, not from a neighbouring row', async () => {
      const inlineRow = (id: string, frameKey: string, started: InlineLaunchStart | null) => ({
        id,
        frameKey,
        status: 'running',
        inline: {
          childRunbookPath: 'child.runbook.md',
          childRunbookRef: { source: 'project', path: 'child.runbook.md' },
          contextSnapshot,
          childRunId,
          createdAt: '2026-05-30T00:00:00.000Z',
          started,
        },
      });
      const parent = parentWith(null, {
        substepStates: [
          // Same frame, different substep.
          inlineRow('9', '1|', heldByThisProcess()),
          // Same substep, different frame.
          inlineRow('1', '9|', heldByThisProcess()),
          // The intent's own coordinate, unlatched.
          inlineRow('1', '1|', null),
        ],
      });
      mockManager.load.mockImplementation(async (id: string) => (id === runbookId ? parent : null));

      await driveLoop();

      expect(latchOutcomes).toEqual([
        expect.objectContaining({
          value: expect.objectContaining({
            kind: 'won',
            existingChild: null,
            reclaimedFrom: null,
          }),
        }),
      ]);
      expect(mockOutput.warning).not.toHaveBeenCalled();
    });
  });

  it('announces the adopted bearer when a resumed inline child re-establishes authority', async () => {
    // The adopted bearer supersedes the one the dead process held, so the run
    // can no longer be addressed unless it is announced. `runbook_started.claim_id`
    // is the only sanctioned channel for a run-control bearer, so the resumed
    // child is re-announced through it before its loop runs.
    const childRunId = actualCore.assertRunId(`rd_${'2'.repeat(32)}`);
    const inlineLaunch = {
      parentRunId: runbookId,
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: '1|',
      parentEntry: 1,
      childRunId,
      childRunbookPath: 'child.runbook.md',
      childRunbookRef: { source: 'project', path: 'child.runbook.md' },
      contextSnapshot: { RunId: runbookId, ContextId: 'ctx-unit', WorkPath: '.rundown/work' },
    };
    const inlineSteps: LooseStep[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Parent step',
        substeps: [
          {
            id: '1',
            description: 'Inline child',
            runbooks: ['child.runbook.md'],
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
        ],
        transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
      },
    ];
    const parentLinkage = {
      kind: 'inline',
      parentRunId: runbookId,
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: '1|',
      parentEntry: 1,
    };
    const parentState = makeLoopState('1', {
      id: runbookId,
      substepStates: [
        {
          id: '1',
          frameKey: '1|',
          status: 'running',
          inline: {
            childRunbookPath: 'child.runbook.md',
            childRunbookRef: { source: 'project', path: 'child.runbook.md' },
            contextSnapshot: inlineLaunch.contextSnapshot,
            childRunId,
            createdAt: '2026-05-30T00:00:00.000Z',
            started: null,
          },
        },
      ],
      snapshot: { context: { inlineLaunchIntent: inlineLaunch } },
    });
    const existingChild = {
      ...makeLoopState('1', {
        id: childRunId,
        lifecycle: 'running',
        parentLinkage,
        title: 'Child',
        description: 'Resumed child',
      }),
      runbookSrc: '## 1. Child\nDone',
    };

    mockManager.load
      .mockResolvedValueOnce(parentState)
      .mockResolvedValueOnce(parentState)
      .mockResolvedValueOnce(existingChild)
      .mockResolvedValue(existingChild);
    mockSessionService.getActive.mockResolvedValueOnce({ id: runbookId });
    mockSessionService.pushRunbook.mockResolvedValueOnce(undefined);
    mockSessionService.adoptRunControlClaim.mockResolvedValueOnce({
      kind: 'adopted',
      runtime: {
        claimId: 'rdclm_adopted',
        claim: { claimKey: 'ck_adopted' },
        // `PreparedRunControlClaim` carries ONE branded pair; the `as never`
        // below would happily keep accepting the old two-field spelling, so the
        // shape is kept honest by hand.
        delegationRuntime: delegationRuntimeDouble({
          issueDelegationCredential: unusedDelegationCredentialIssuer(),
          deriveDelegationToken: unusedDelegationTokenDeriver(),
        }),
      },
    } as never);
    mockActorService.enterExecutionUnit.mockResolvedValueOnce({
      kind: 'inline-launch',
      launch: inlineLaunch,
      effects: [
        {
          kind: 'execution_observation',
          event: {
            type: 'STEP_ENTERED',
            payload: {
              position: { current: '1.1', total: 1 },
              stepName: '1',
              description: 'Inline child',
              hasCommand: false,
              isSubstep: true,
              prompted: false,
              artifacts: {},
              inlineLaunch,
            },
          },
        },
      ],
    });
    mockActorService.sendAndSync
      .mockResolvedValueOnce({ state: parentState, snapshot: {} })
      .mockResolvedValueOnce({ state: parentState, snapshot: {} });

    // The resumed child is announced on its OWN bridged emitter, so the
    // observation point is the shared output sink both emitters feed.
    const executionEvent = jest.fn();

    await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(inlineSteps),
      mockManager.cwd,
      asEmitter(mockEmitter),
      { output: { executionEvent } as never },
    );

    expect(mockSessionService.adoptRunControlClaim).toHaveBeenCalledWith(existingChild);
    expect(executionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'RUNBOOK_STARTED',
        runbookId: childRunId,
        payload: expect.objectContaining({
          title: 'Child',
          description: 'Resumed child',
          // Carried from the child's own persisted mode, not the composing loop's.
          prompted: false,
          claimId: 'rdclm_adopted',
        }),
      }),
    );
  });

  it('propagates blocked inline child terminal instead of treating child completion as success', async () => {
    const childRunId = actualCore.assertRunId(`rd_${'2'.repeat(32)}`);
    const inlineLaunch = {
      parentRunId: runbookId,
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: '1|',
      parentEntry: 1,
      childRunId,
      childRunbookPath: 'child.runbook.md',
      childRunbookRef: { source: 'project', path: 'child.runbook.md' },
      contextSnapshot: {
        RunId: runbookId,
        ContextId: 'ctx-unit',
        WorkPath: '.rundown/work',
      },
    };
    const inlineSteps: LooseStep[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Parent step',
        substeps: [
          {
            id: '1',
            description: 'Inline child',
            runbooks: ['child.runbook.md'],
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
        ],
        transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
      },
    ];
    const parentLinkage = {
      kind: 'inline',
      parentRunId: runbookId,
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: '1|',
      parentEntry: 1,
    };
    const parentState = makeLoopState('1', {
      lifecycle: 'running',
      substep: '1',
      activeFrameKey: '1|',
      activeEntry: 1,
      substepStates: [
        {
          id: '1',
          frameKey: '1|',
          status: 'running',
          inline: {
            childRunbookPath: 'child.runbook.md',
            childRunbookRef: { source: 'project', path: 'child.runbook.md' },
            contextSnapshot: inlineLaunch.contextSnapshot,
            childRunId,
            createdAt: '2026-05-30T00:00:00.000Z',
            // The interrupted launch that got as far as creating the child and
            // never recorded its latch — the state the adoption branch below
            // exists for. Held unlatched rather than dead-owned so this test
            // stays about what it is about; reclaiming a dead owner into the
            // same branch has its own test above.
            started: null,
          },
        },
      ],
      snapshot: { context: { inlineLaunchIntent: inlineLaunch } },
    });
    const existingChild = {
      ...makeLoopState('1', {
        id: childRunId,
        lifecycle: 'completed',
        parentLinkage,
      }),
      runbookSrc: '## 1. Child\nDone',
    };

    mockManager.load
      .mockResolvedValueOnce(parentState)
      .mockResolvedValueOnce(parentState)
      .mockResolvedValueOnce(existingChild)
      .mockResolvedValue(existingChild);
    mockSessionService.getActive.mockResolvedValueOnce({ id: runbookId });
    mockActorService.enterExecutionUnit.mockResolvedValueOnce({
      kind: 'inline-launch',
      launch: inlineLaunch,
      effects: [
        {
          kind: 'execution_observation',
          event: {
            type: 'STEP_ENTERED',
            payload: {
              position: { current: '1.1', total: 1 },
              stepName: '1',
              description: 'Inline child',
              hasCommand: false,
              isSubstep: true,
              prompted: false,
              artifacts: {},
              inlineLaunch,
            },
          },
        },
      ],
    });
    // Twice: the latch write this observer now performs (it took an unlatched
    // launch), then the intent consumption after the child is activated.
    mockActorService.sendAndSync.mockResolvedValue({ state: parentState, snapshot: {} });
    mockCompletionService.recordChildCompletion.mockResolvedValueOnce('blocked');
    const output = {
      executionEvent: jest.fn(),
      flush: jest.fn(),
    };

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(inlineSteps),
      mockManager.cwd,
      asEmitter(mockEmitter),
      { output: output as never },
    );

    expect(result).toBe('stopped');
    expect(mockCompletionService.recordChildCompletion).toHaveBeenCalledWith({
      childState: existingChild,
      result: 'pass',
    });
    expect(output.flush).toHaveBeenCalled();
  });

  it('does not consume existing inline child intent when session activation fails', async () => {
    const childRunId = actualCore.assertRunId(`rd_${'3'.repeat(32)}`);
    const inlineLaunch = {
      parentRunId: runbookId,
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: '1|',
      parentEntry: 1,
      childRunId,
      childRunbookPath: 'child.runbook.md',
      childRunbookRef: { source: 'project', path: 'child.runbook.md' },
      contextSnapshot: {
        RunId: runbookId,
        ContextId: 'ctx-unit',
        WorkPath: '.rundown/work',
      },
    };
    const inlineSteps: LooseStep[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Parent step',
        substeps: [
          {
            id: '1',
            description: 'Inline child',
            runbooks: ['child.runbook.md'],
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
        ],
        transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
      },
    ];
    const parentLinkage = {
      kind: 'inline',
      parentRunId: runbookId,
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: '1|',
      parentEntry: 1,
    };
    const parentState = makeLoopState('1', {
      lifecycle: 'running',
      substep: '1',
      activeFrameKey: '1|',
      activeEntry: 1,
      substepStates: [
        {
          id: '1',
          frameKey: '1|',
          status: 'running',
          inline: {
            childRunbookPath: 'child.runbook.md',
            childRunbookRef: { source: 'project', path: 'child.runbook.md' },
            contextSnapshot: inlineLaunch.contextSnapshot,
            childRunId,
            createdAt: '2026-05-30T00:00:00.000Z',
            // The interrupted launch that got as far as creating the child and
            // never recorded its latch — the state the adoption branch below
            // exists for. Held unlatched rather than dead-owned so this test
            // stays about what it is about; reclaiming a dead owner into the
            // same branch has its own test above.
            started: null,
          },
        },
      ],
      snapshot: { context: { inlineLaunchIntent: inlineLaunch } },
    });
    const existingChild = {
      ...makeLoopState('1', {
        id: childRunId,
        lifecycle: 'running',
        parentLinkage,
      }),
      runbookSrc: '## 1. Child\nDone',
    };

    mockManager.load
      .mockResolvedValueOnce(parentState)
      .mockResolvedValueOnce(parentState)
      .mockResolvedValueOnce(existingChild);
    mockSessionService.pushRunbookIfNotActive.mockRejectedValueOnce(
      new Error('session push failed'),
    );
    // The latch write, which precedes the activation this test fails.
    mockActorService.sendAndSync.mockResolvedValue({ state: parentState, snapshot: {} });
    mockActorService.enterExecutionUnit.mockResolvedValueOnce({
      kind: 'inline-launch',
      launch: inlineLaunch,
      effects: [
        {
          kind: 'execution_observation',
          event: {
            type: 'STEP_ENTERED',
            payload: {
              position: { current: '1.1', total: 1 },
              stepName: '1',
              description: 'Inline child',
              hasCommand: false,
              isSubstep: true,
              prompted: false,
              artifacts: {},
              inlineLaunch,
            },
          },
        },
      ],
    });

    await expect(
      runExecutionLoop(
        asManager(mockManager),
        runbookId,
        asSteps(inlineSteps),
        mockManager.cwd,
        asEmitter(mockEmitter),
        { output: {} as never },
      ),
    ).rejects.toThrow('session push failed');

    expect(mockActorService.sendAndSync).not.toHaveBeenCalledWith(runbookId, inlineSteps, {
      type: 'INLINE_LAUNCH_CONSUMED',
    });
  });

  it('skips stale existing inline child intents that were already consumed', async () => {
    const childRunId = actualCore.assertRunId(`rd_${'2'.repeat(32)}`);
    const inlineLaunch = {
      parentRunId: runbookId,
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: '1|',
      parentEntry: 1,
      childRunId,
      childRunbookPath: 'child.runbook.md',
      childRunbookRef: { source: 'project', path: 'child.runbook.md' },
      contextSnapshot: {
        RunId: runbookId,
        ContextId: 'ctx-unit',
        WorkPath: '.rundown/work',
      },
    };
    const inlineSteps: LooseStep[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Parent step',
        substeps: [
          {
            id: '1',
            description: 'Inline child',
            runbooks: ['child.runbook.md'],
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
        ],
        transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
      },
    ];
    const parentState = makeLoopState('1', {
      lifecycle: 'running',
      substep: '1',
      activeFrameKey: '1|',
      activeEntry: 1,
      snapshot: { context: { inlineLaunchIntent: undefined } },
    });
    mockManager.load.mockResolvedValue(parentState);
    mockActorService.enterExecutionUnit.mockResolvedValueOnce({
      kind: 'inline-launch',
      launch: inlineLaunch,
      effects: [
        {
          kind: 'execution_observation',
          event: {
            type: 'STEP_ENTERED',
            payload: {
              position: { current: '1.1', total: 1 },
              stepName: '1',
              description: 'Inline child',
              hasCommand: false,
              isSubstep: true,
              prompted: false,
              artifacts: {},
              inlineLaunch,
            },
          },
        },
      ],
    });

    // The superseded arm writes to the operator channel now, so the double has
    // to carry one: a stand-down that returns `waiting` and touches nothing else
    // is otherwise indistinguishable from the turn doing nothing at all.
    const warning = mockFn<(text: string) => void>();

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(inlineSteps),
      mockManager.cwd,
      asEmitter(mockEmitter),
      { output: { warning } as never },
    );

    expect(result).toBe('waiting');
    expect(mockActorService.sendAndSync).not.toHaveBeenCalledWith(runbookId, inlineSteps, {
      type: 'INLINE_LAUNCH_CONSUMED',
    });
    expect(warning).toHaveBeenCalledWith(
      `Inline launch of ${childRunId} was superseded: run ${runbookId} no longer carries that ` +
        `launch. Re-run this command to observe its current state.`,
    );
    expect(mockSessionService.pushRunbookIfNotActive).not.toHaveBeenCalled();
    expect(mockSessionService.pushRunbook).not.toHaveBeenCalled();
  });

  // The consume now commits BEFORE the STEP_ENTERED carrying the tokens is
  // emitted (it was emit-then-consume before the seam was shared). Both orders
  // keep the tokens from being re-emitted on a later pass — that is what this
  // test pins — but committing first also means a failed consume discloses
  // nothing, which is the behaviour `rundown collect` already had.
  it('consumes delegateFrontier before emitting STEP_ENTERED so tokens are not re-emitted', async () => {
    const delegateSteps: any[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Parallel work',
        substeps: [
          {
            id: '1',
            description: 'First task',
            delegate: true,
            runbooks: ['child-a.runbook.md'],
            transitions: { pass: { next: '2' }, fail: { next: 'STOP' } },
          },
          {
            id: '2',
            description: 'Follow-up',
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
        ],
        transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
      },
    ];

    mockManager.load.mockResolvedValue(
      frontierLoopState([persistedFrontierEntry('1.1', 'child-a.runbook.md', 'rdtk_retry_a')], {
        prompted: true,
      }),
    );
    mockActorService.sendAndSync.mockResolvedValue({
      state: frontierConsumedState({ prompted: true }),
      snapshot: {},
    });

    await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(delegateSteps),
      '/tmp',
      asEmitter(mockEmitter),
      { delegationRuntime: frontierProjectionRuntime(() => 'rdtk_retry_a') },
    );

    const stepEnteredCall = mockEmitter.emit.mock.calls.find(
      (call) => call[0].type === 'STEP_ENTERED',
    );
    expect(stepEnteredCall).toBeDefined();
    const payload = stepEnteredCall![0].payload as { delegateFrontier?: unknown };
    expect(payload.delegateFrontier).toEqual([
      { id: '1.1', runbook: 'child-a.runbook.md', token: 'rdtk_retry_a' },
    ]);

    expect(mockActorService.sendAndSync).toHaveBeenCalledWith(runbookId, delegateSteps, {
      type: 'DELEGATE_FRONTIER_CONSUMED',
    });
  });

  it('does not act on an inline-launch intent reached through a projected frontier', async () => {
    // The one-shot intent is consumed by the launch it drives, and the frontier
    // seam's own consume has ALREADY committed by the time the classified entry
    // comes back. Launching here would start a child the re-entry never armed —
    // so the guard is on `reentry.status`, not on the classification alone.
    const delegateSteps: any[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Parallel work',
        substeps: [
          {
            id: '1',
            description: 'First task',
            delegate: true,
            runbooks: ['child-a.runbook.md'],
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
        ],
        transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
      },
    ];

    mockManager.load.mockResolvedValue(
      frontierLoopState([persistedFrontierEntry('1.1', 'child-a.runbook.md', 'rdtk_retry_a')]),
    );
    mockActorService.sendAndSync.mockResolvedValue({
      state: { id: runbookId, step: '1', substep: '1', status: 'running' },
      snapshot: {},
    });
    // The seam enters through the SAME double, so this is what its `projected`
    // arm carries back to the loop.
    mockActorService.enterExecutionUnit.mockResolvedValue({
      kind: 'inline-launch',
      launch: {
        parentRunId: runbookId,
        parentStepId: '1',
        parentStep: '1',
        parentFrameKey: '1|',
        parentEntry: 1,
        childRunId: `rd_${'3'.repeat(32)}`,
        childRunbookPath: 'child-a.runbook.md',
        childRunbookRef: { source: 'project', path: 'child-a.runbook.md' },
        contextSnapshot: { vars: {}, ancestors: [], step: '1', substep: '1', at: '1.1' },
      },
      effects: [],
    });

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(delegateSteps),
      '/tmp',
      asEmitter(mockEmitter),
      { delegationRuntime: frontierProjectionRuntime(() => 'rdtk_retry_a') },
    );

    // No launch was attempted: the latch is the launch span's first write, and
    // it was never reached.
    expect(mockManager.mutateStateReturning).not.toHaveBeenCalled();
    expect(mockedResolveRunbookRef).not.toHaveBeenCalled();
    // The frontier still consumed — the re-entry itself is unaffected.
    expect(mockActorService.sendAndSync).toHaveBeenCalledWith(runbookId, delegateSteps, {
      type: 'DELEGATE_FRONTIER_CONSUMED',
    });
    expect(result).toBe('waiting');
  });

  it('STEP_ENTERED does not issue delegations when delegateFrontier is absent', async () => {
    const delegateSteps: any[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Parallel work',
        substeps: [
          {
            id: '1',
            description: 'First task',
            delegate: true,
            runbooks: ['child-a.runbook.md'],
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
        ],
        transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
      },
    ];

    mockManager.load.mockResolvedValue(makeLoopState('1', { substep: '1', substepStates: [] }));

    mockActorService.getContextSnapshot.mockResolvedValue({});

    await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(delegateSteps),
      '/tmp',
      asEmitter(mockEmitter),
    );

    const stepEnteredCall = mockEmitter.emit.mock.calls.find(
      (call) => call[0].type === 'STEP_ENTERED',
    );
    expect(stepEnteredCall).toBeDefined();
    const payload = stepEnteredCall![0].payload as { delegateFrontier?: unknown };
    expect(payload.delegateFrontier).toBeUndefined();
    expect(core.createDelegation).not.toHaveBeenCalled();
  });

  it('emits machine-produced nested_delegation_forbidden stop reason', async () => {
    const delegateSteps: any[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Parallel work',
        substeps: [
          {
            id: '1',
            description: 'First task',
            delegate: true,
            runbooks: ['child-a.runbook.md'],
            transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
          },
        ],
        transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
      },
    ];

    mockManager.load.mockResolvedValue({
      id: runbookId,
      step: '1',
      substep: '1',
      lifecycle: 'stopped',
      retryCount: 0,
      snapshot: {
        status: 'done',
        value: 'STOPPED',
        context: {
          lastAction: {
            type: 'DELEGATION_ISSUANCE_FAILED',
            origin: 'direct',
            reason: 'nested_delegation_forbidden',
            message: 'Nested delegation forbidden',
          },
        },
      },
    });

    const result = await runExecutionLoop(
      asManager(mockManager),
      runbookId,
      asSteps(delegateSteps),
      '/tmp',
      asEmitter(mockEmitter),
    );

    expect(result).toBe('stopped');

    // RUNBOOK_STOPPED carries the discriminated reason — not the generic
    // 'delegation_resolution_failed' fallback.
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'ERROR_OCCURRED',
      payload: expect.objectContaining({
        message: 'Nested delegation forbidden',
      }),
    });
    expect(mockEmitter.emit).toHaveBeenCalledWith({
      type: 'RUNBOOK_STOPPED',
      payload: expect.objectContaining({
        reason: 'nested_delegation_forbidden',
      }),
    });
  });
});

describe('executeCommandWithPolicyCheck', () => {
  const command = 'echo test';
  const cwd = '/tmp';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('calls executeCommand directly if policy is not enforced', async () => {
    jest.mocked(policyContext.isPolicyEnforced).mockReturnValue(false);
    jest
      .mocked(core.executeCommand)
      .mockResolvedValue({ success: true } as unknown as Awaited<
        ReturnType<typeof core.executeCommand>
      >);

    await executeCommandWithPolicyCheck(command, cwd);

    expect(core.executeCommand).toHaveBeenCalledWith(command, cwd, undefined, {});
    expect(core.executeCommandWithEnv).not.toHaveBeenCalled();
    expect(core.executeCommandWithPolicy).not.toHaveBeenCalled();
  });

  it('calls executeCommandWithPolicy if policy is enforced', async () => {
    jest.mocked(policyContext.isPolicyEnforced).mockReturnValue(true);
    // PolicyEvaluator has many methods; the production CLI only invokes
    // setRunbookPath here so we cast through unknown to keep the partial.
    const mockEvaluator = { setRunbookPath: jest.fn() };
    jest
      .mocked(policyContext.getPolicyEvaluator)
      .mockReturnValue(
        mockEvaluator as unknown as ReturnType<typeof policyContext.getPolicyEvaluator>,
      );
    // PolicyPrompter is a structural object; the test only stores a sentinel
    // string and asserts identity through the call chain.
    jest
      .mocked(policyContext.getPolicyPrompter)
      .mockReturnValue('prompter' as unknown as ReturnType<typeof policyContext.getPolicyPrompter>);
    jest.mocked(policyContext.getSandboxOptions).mockReturnValue({
      sandbox: true,
      sandboxStrict: true,
    });
    jest
      .mocked(core.executeCommandWithPolicy)
      .mockResolvedValue({ success: true } as unknown as Awaited<
        ReturnType<typeof core.executeCommandWithPolicy>
      >);

    await executeCommandWithPolicyCheck(command, cwd, 'test.md');

    expect(mockEvaluator.setRunbookPath).toHaveBeenCalledWith('test.md');
    expect(core.executeCommandWithPolicy).toHaveBeenCalledWith(
      command,
      cwd,
      expect.objectContaining({
        evaluator: mockEvaluator,
        prompter: 'prompter',
        sandbox: true,
        sandboxStrict: true,
      }),
    );
  });

  it('calls executeCommandWithEnv when policy is not enforced but rdInjected is non-empty', async () => {
    mockedPolicyContext.isPolicyEnforced.mockReturnValue(false);
    const rdInjected = { RD_OUTPUTS_Foo: '/tmp/foo' };
    (core.executeCommandWithEnv as any).mockResolvedValue({ success: true, exitCode: 0 });

    await executeCommandWithPolicyCheck(command, cwd, undefined, rdInjected);

    expect(core.executeCommandWithEnv).toHaveBeenCalledWith(
      command,
      cwd,
      expect.objectContaining({ RD_OUTPUTS_Foo: '/tmp/foo' }),
      {},
    );
    expect(core.executeCommand).not.toHaveBeenCalled();
    expect(core.executeCommandWithPolicy).not.toHaveBeenCalled();
  });
});
