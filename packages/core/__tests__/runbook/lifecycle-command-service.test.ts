import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  ResolvedStep,
  ResolvedStepWithFor,
  ResolvedStepWithPromptedFor,
  ResolvedStepWithSubsteps,
  Substep,
  Transitions,
} from '@rundown-org/parser';
import type { RunbookRef } from '../../src/runbook/runbook-ref.js';
import {
  DelegationScanService,
  ExecutionLifecycleService,
  InvalidRunbookStateError,
  RunbookActorService,
  RunbookCompletionService,
  RunbookLifecycleCommandService,
  RunbookStateManager,
  SessionService,
  activeFrame,
  assertClaimId,
  assertRunId,
  brandCurrentCursorResolvedCompletionForTest,
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
  createEffectfulActorMutationRunner,
  inactiveFrame,
  type CallerEvidence,
  type ClaimId,
  type EffectfulActorMutationRunner,
  type EffectfulActorMutationSetRunnerInput,
  type InlineLinkage,
  type LifecycleTerminalReleasePolicy,
  type ResolveChildRunbook,
  type RunbookLifecycleCommandServiceDependencies,
  type RunbookState,
  type RunId,
  type StepDelegation,
  type SubstepState,
} from '../../src/runbook/index.js';
import type { RunbookStateUpdate } from '../../src/runbook/state.js';
import { replace } from '../../src/runbook/state-update-ops.js';
import type { TokenScanResult } from '../../src/runbook/delegation-scan.js';
import { buildContextSnapshot } from '../../src/runbook/delegation-context.js';
import {
  assertDelegationTokenHash,
  DELEGATION_CLAIM_MARKER,
  TOKEN_PREFIX,
  type DelegationTokenHash,
} from '../../src/runbook/delegation-token.js';
import { claimKeyFromBearer } from '../../src/runbook/claim-id.js';
import { Errors } from '../../src/errors/factory.js';
import type {
  DelegationAbortOutcome,
  LifecycleTerminalOutcome,
} from '../../src/runbook/lifecycle-command-service.js';
import type { TransitionObservationEvent } from '../../src/events/transition-observation.js';
import { findSubstepState } from '../../src/runbook/targeting.js';
import type { DelegationCredentialIssuer } from '../../src/runbook/delegation-credential.js';
import { getRunbookStore } from '../../src/runbook/storage/store-registry.js';
import { RunbookStore } from '../../src/runbook/storage/runbook-store.js';
import { SqliteExecutionLeaseService } from '../../src/runbook/storage/execution-lease.js';
import {
  brandInitialTemplateVarsForTest,
  brandStoredOutputsForTest,
} from '../../src/testing/effective-vars.js';
import {
  assertClaimed,
  linkageFor,
  claimLiveDelegation,
  raceChildClaimDuringActorPrepare,
  retireDuringCapture,
  seedLiveDelegation,
} from './claim-test-helpers.js';
import { patchPersistedClaim, unwrapSessionMutation } from '../../src/testing/session-fixtures.js';

// Lifecycle command seam contract coverage. Maps the Task 3 contract
// (docs/superpowers/notes/2026-06-28-lifecycle-command-seam-contract.md):
//   - delegate issuance precheck (gate-only, no persistence)
//   - pass/fail target refusals (none, actor_context_required,
//     delegation_collection_pending)
//   - top-level PASS/FAIL drive (continue + done) with observation events
//   - manual substep completion drive (record + drain)
// Resolver-owned refusals (open_delegated_children, terminal claim
// confirm/conflict, stale_claim) are forwarded verbatim by #asRefusal from
// resolveTransitionTarget and are pinned in command-target-resolver.test.ts;
// their end-to-end CLI rendering is pinned in the CLI pass/fail integration and
// scenario suites.

// ACCEPTED MUTATION SURVIVORS in the force-terminal result mapping (#672).
//
// The seam-scoped run
//   STRYKER_SCOPED=true STRYKER_CONCURRENCY=1 pnpm --filter @rundown-org/core \
//     exec stryker run --force \
//     --mutate 'src/runbook/lifecycle-command-service.ts:3021-3029,src/runbook/lifecycle-command-service.ts:3317-3327' \
//     --testFiles __tests__/runbook/lifecycle-command-service.test.ts
// leaves the `'fail'` literal of `input.command === 'complete' ? 'pass' : 'fail'`
// alive on BOTH force-terminal drives (`#driveTerminalClaim` and
// `#driveTerminalBare`, 1 mutant each). Both are equivalent, and no annotation
// is added at the source line because `Stryker disable next-line StringLiteral`
// is line-granular: it would also suppress the `'complete'` and `'pass'`
// literals on those same lines, which the projection tests below DO kill.
//
// Why equivalent: that value has exactly two consumers, and both compare it
// only against `'pass'` — `actionResult = … : input.result === 'pass'` in
// deriveTransitionObservation, and `result === 'pass' ? … : …` in
// deriveTransitionMessage. `'fail'` and `''` therefore take the same branch in
// both. A test that "killed" this would have to observe a distinction the
// projection cannot express.
//
// NOT in this list, and recorded here only because two earlier passes put it
// there: the claim path's opportunistic parent target
// (`...(parentRunId === undefined ? [] : [{ runId: parentRunId, optional: true }])`).
// Its 2 mutants — the `false ?` conditional and the empty-array arm — were
// accepted as UNREACHABLE (#726), then corrected to untested (#738). They are
// now KILLED by the defensive malformed-resolution fixture below. Production
// minting and resolution reject all shared-coordinate drift before this arm;
// the fixture injects the pre-fix state directly so the terminal service still
// fails closed if its collaborator violates that contract. Do not re-accept
// them: the arm has a fixture.
//
// Five further survivors are accepted as EQUIVALENT (#727) — each by a proof in
// the code, not by inspection, so the verdict can be rechecked rather than
// trusted:
//
//   :2973 `if (input.callerEvidence.kind === 'claim_bearer')` -> `if (true)`.
//     `#driveTerminalClaim` is dispatched only for a claim-shaped selector, and
//     `reconcileClaimTarget` in the same file refuses `claim_bearer_mismatch`
//     unless the evidence is a bearer carrying that exact claim id. Non-bearer
//     evidence never reaches the line.
//
//   :2978 `state.parentLinkage?.parentRunId` -> `state.parentLinkage.parentRunId`.
//     Evaluated only when `shouldReport` holds, and
//     `claimCanReportDelegationResult` (claim-id.ts) returns false outright for
//     `linkage?.kind !== 'delegation'`. The optional chain is dead in the only
//     branch that evaluates it.
//
//   :3234 `member.id === controlledRunId && claimKey !== undefined` -> `&& true`.
//     Both operands derive from the same presented bearer, so `claimKey` is
//     undefined only when `controlledRunId` is, and a `RunId` never equals
//     `undefined` — the first conjunct is already false wherever the second
//     would have mattered.
//
//   The guard spread `...(guard === undefined ? {} : { guard })` keeps its
//   `false ?` mutant on BOTH fenced drives (`#driveSubstepFenced` and
//   `#driveTopLevel`, 1 each). It turns `{}` into `{ guard: undefined }`, and
//   `EffectfulActorMutationRunner.run` forwards `input.guard` BY VALUE into
//   `RunbookStoreActorCommitter` — key presence is never tested. Same argument
//   as the `delegationRuntime` annotation in the source. The spread's other
//   three arms all drop the guard from the GUARDED call, and are killed by the
//   racing child-claim witness on each drive.

const RELEASE_POLICY: LifecycleTerminalReleasePolicy = {
  onComplete: { releaseRunbook: true },
  onStopped: { releaseRunbook: true },
};

const DIRECT_CLI: CallerEvidence = { kind: 'direct_cli' };

function tx(pass: 'CONTINUE' | 'COMPLETE' | 'STOP', fail: 'CONTINUE' | 'COMPLETE' | 'STOP') {
  return {
    pass: { kind: 'pass', retry: 0, action: { type: pass } },
    fail: { kind: 'fail', retry: 0, action: { type: fail } },
  } as const;
}

const SUBSTEP_TRANSITIONS: Transitions = {
  pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
  fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } },
};

/** Build an authored DELEGATE substep with the given runbook reference. */
function delegateSubstep(id: string, runbook: string): Substep {
  return {
    id,
    description: `Substep ${id}`,
    delegate: true,
    runbooks: [runbook],
    transitions: SUBSTEP_TRANSITIONS,
  };
}

/** Build a step that owns one or more authored DELEGATE substeps. */
function delegateStep(name: string, substeps: readonly Substep[]): ResolvedStepWithSubsteps {
  return {
    kind: 'substeps',
    name,
    description: `Step ${name}`,
    transitions: SUBSTEP_TRANSITIONS,
    substeps,
  };
}

/** Build a FOR step that owns one or more authored DELEGATE substeps. */
function delegateForStep(name: string, substeps: readonly Substep[]): ResolvedStepWithFor {
  return {
    kind: 'for',
    name,
    description: `FOR step ${name}`,
    transitions: SUBSTEP_TRANSITIONS,
    forClause: { variable: 'i', start: 1, end: 10 },
    substeps,
  };
}

/**
 * Build a prompted-FOR step that owns authored DELEGATE substeps.
 *
 * A FOR step whose bounds did not resolve: no `forClause`, so no iteration
 * machinery, but `--index` still names a legitimate frame on it.
 */
function delegatePromptedForStep(
  name: string,
  substeps: readonly Substep[],
): ResolvedStepWithPromptedFor {
  return {
    kind: 'prompted-for',
    name,
    description: `Prompted FOR step ${name}`,
    transitions: SUBSTEP_TRANSITIONS,
    substeps,
  };
}

/**
 * Decorate a mutation runner so `onFenceEntered` fires as the aggregate fence is
 * entered — after every pre-fence resolution the seam performs (anchor,
 * authority, positional runbook, claim-seen recording) and before the fence's
 * own `beforeEffect` re-read.
 *
 * This is the concurrent-writer seam the `DelegationLock` used to provide: a
 * document mutation landing here is invisible to any load hoisted out of
 * `beforeEffect`, so a decision that observes it must have been made from the
 * in-fence re-read.
 *
 * @param inner - The real runner to delegate to.
 * @param onFenceEntered - Concurrent mutation to commit at fence entry.
 * @returns A runner that fires the hook once per aggregate invocation.
 */
function runnerWithFenceEntryHook(
  inner: EffectfulActorMutationRunner,
  onFenceEntered: () => void,
): EffectfulActorMutationRunner {
  return {
    run: (input) => inner.run(input),
    runAll<TResult>(input: EffectfulActorMutationSetRunnerInput<TResult>) {
      onFenceEntered();
      return inner.runAll(input);
    },
  };
}

/**
 * Async sibling of {@link runnerWithFenceEntryHook} for a concurrent mutation
 * that must be DURABLE before the fence captures state.
 *
 * The synchronous hook is enough to swap an in-memory dependency, but a
 * persisted write has to be awaited or the capture races it — and a race that
 * usually loses would make the test assert the very thing it is trying to
 * disprove.
 *
 * @param inner - The real runner to delegate to.
 * @param onFenceEntered - Concurrent mutation to commit at fence entry.
 * @returns A runner that awaits the hook once per aggregate invocation.
 */
function runnerWithAsyncFenceEntryHook(
  inner: EffectfulActorMutationRunner,
  onFenceEntered: () => Promise<void>,
): EffectfulActorMutationRunner {
  return {
    run: (input) => inner.run(input),
    async runAll<TResult>(input: EffectfulActorMutationSetRunnerInput<TResult>) {
      await onFenceEntered();
      return inner.runAll(input);
    },
  };
}

describe('RunbookLifecycleCommandService', () => {
  let tmp: string;
  let manager: RunbookStateManager;
  let actorService: RunbookActorService;
  let lifecycleService: ExecutionLifecycleService;
  let completionService: RunbookCompletionService;
  let actorMutationRunner: ReturnType<typeof createEffectfulActorMutationRunner>;
  let sessionService: SessionService;
  let seam: RunbookLifecycleCommandService;
  // Test-controlled `loadSteps`: each drive test sets `loadStepsImpl` to the steps
  // for the run it resolves; `loadStepsArgs` records the states it was called with
  // so single-resolution can be asserted (it is the observable proxy for "resolve
  // once" — `resolveTransitionTarget` is a free function and cannot be spied).
  let loadStepsImpl: (state: RunbookState) => readonly ResolvedStep[];
  let loadStepsArgs: RunbookState[];
  let issuedRunControlClaims: Map<RunbookState['id'], ClaimId>;

  const runId = assertRunId('rd_11111111111111111111111111111111');

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'lifecycle-command-'));
    manager = new RunbookStateManager(tmp);
    actorService = new RunbookActorService(manager);
    lifecycleService = new ExecutionLifecycleService(manager);
    completionService = new RunbookCompletionService(manager, lifecycleService, actorService);
    actorMutationRunner = createEffectfulActorMutationRunner(tmp);
    sessionService = new SessionService(manager);
    loadStepsImpl = () => [];
    loadStepsArgs = [];
    issuedRunControlClaims = new Map();
    seam = new RunbookLifecycleCommandService({
      sessionService,
      actorService,
      completionService,
      actorMutationRunner,
      loadRun: async (id) => (await manager.load(id)) ?? undefined,
      loadSteps: (state) => {
        loadStepsArgs.push(state);
        return loadStepsImpl(state);
      },
      // Stubs: the pass/fail + precheck suites never call issueDelegation. The
      // issueDelegation suites build their own seam via startSeamOnDelegateStep.
      resolveChildRunbook: async () => undefined,
      findDelegationsByTokenHash: async () => ({ current: undefined, superseding: [] }),
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(tmp, { recursive: true, force: true });
  });

  function baseState(overrides: Partial<RunbookState> = {}): RunbookState {
    return {
      id: runId,
      runbook: { source: 'project', path: 'lifecycle-test.md' },
      runbookPath: 'lifecycle-test.md',
      step: '1',
      stepName: 'Step one',
      substep: undefined,
      retryCount: 0,
      variables: brandStoredOutputsForTest({}),
      templateVars: brandInitialTemplateVarsForTest({}),
      steps: [],
      resolvedCompletions: {},
      frameEntryCounts: { [buildFrameKey('1')]: 1 },
      activeFrameKey: buildFrameKey('1'),
      activeEntry: 1,
      startedAt: '2026-06-28T00:00:00.000Z',
      updatedAt: '2026-06-28T00:00:00.000Z',
      lifecycle: 'running',
      schemaVersion: 1,
      frontmatterOutputs: [],
      ...overrides,
    };
  }

  async function activate(state: RunbookState): Promise<void> {
    await manager.save(state);
    await sessionService.pushRunbook(state.id);
    if (!issuedRunControlClaims.has(state.id)) {
      await issueRunControlClaimFor(state.id);
    }
  }

  async function issueRunControlClaimFor(id: RunbookState['id']): Promise<void> {
    const { claimId } = unwrapSessionMutation(await sessionService.issueRunControlClaim(id));
    issuedRunControlClaims.set(id, claimId);
  }

  function runControlEvidence(id: RunbookState['id'] = runId): CallerEvidence {
    const claimId = issuedRunControlClaims.get(id);
    if (claimId === undefined) {
      throw new Error(`expected run-control claim for ${id}`);
    }
    return { kind: 'claim_bearer', claimId };
  }

  /**
   * The deps a test may swap mid-run: the intersection re-declares them WITHOUT
   * `readonly`, so assignments through the returned `deps` object typecheck
   * while the seam-facing interface stays readonly.
   */
  type MutableIssuanceSeamDeps = {
    resolveChildRunbook: ResolveChildRunbook;
    loadRun: RunbookLifecycleCommandServiceDependencies['loadRun'];
    loadSteps: RunbookLifecycleCommandServiceDependencies['loadSteps'];
    actorMutationRunner: RunbookLifecycleCommandServiceDependencies['actorMutationRunner'];
    findDelegationsByTokenHash: RunbookLifecycleCommandServiceDependencies['findDelegationsByTokenHash'];
  };

  /**
   * Build a seam wired to issuance deps for an already-activated `state`, with
   * `loadSteps` returning the supplied parsed steps. Returns the mutable `deps`
   * object so a test can swap a dependency mid-run (the seam holds it in private
   * `#deps`).
   */
  function buildIssuanceSeam(
    state: RunbookState,
    steps: readonly ResolvedStep[],
  ): {
    seam: RunbookLifecycleCommandService;
    deps: RunbookLifecycleCommandServiceDependencies & MutableIssuanceSeamDeps;
    manager: RunbookStateManager;
    state: RunbookState;
  } {
    const deps: RunbookLifecycleCommandServiceDependencies & MutableIssuanceSeamDeps = {
      sessionService,
      actorService,
      completionService,
      actorMutationRunner: createEffectfulActorMutationRunner(tmp),
      loadRun: async (id) => (await manager.load(id)) ?? undefined,
      loadSteps: () => steps,
      // Resolve by name so a positional naming a *different* runbook produces a
      // distinct ref (drives the RD-822 mismatch path).
      resolveChildRunbook: async (
        name,
      ): Promise<{ path: string; ref: RunbookRef } | undefined> => ({
        path: name,
        ref: { source: 'project', path: name },
      }),
      findDelegationsByTokenHash: (tokenHash) =>
        new DelegationScanService(manager).scanByTokenHash(tokenHash),
    };
    return { seam: new RunbookLifecycleCommandService(deps), deps, manager, state };
  }

  /**
   * Stand up a real active runbook whose current step `1` has one authored
   * DELEGATE substep `1.1` targeting `child.md`, then build a fresh seam wired
   * to issuance deps.
   */
  /**
   * Give a run active execution ownership, as another process holding it would.
   *
   * Written straight to the columns because acquiring a real lease needs the
   * driver; the ownership guards key on `runs.exec_token IS NOT NULL` alone.
   *
   * @param cwd - Project root whose store holds the run.
   * @param ownedRunId - Run to mark as owned.
   */
  async function ownRunForTest(cwd: string, ownedRunId: RunId): Promise<void> {
    const store = await getRunbookStore(cwd);
    await store.transaction((txn) => {
      txn.tx
        .prepare(
          `INSERT INTO execution_attempts
             (run_id, exec_epoch, exec_token, phase, owner_pid, started_at)
           VALUES (:runId, 1, 'sha256:owned', 'claimed', :pid, :now)`,
        )
        .run({ runId: ownedRunId, pid: process.pid, now: new Date().toISOString() });
      txn.tx
        .prepare(
          `UPDATE runs SET exec_epoch = 1, exec_pid = :pid, exec_token = 'sha256:owned'
            WHERE id = :runId`,
        )
        .run({ runId: ownedRunId, pid: process.pid });
    });
  }

  async function startSeamOnDelegateStep(): Promise<ReturnType<typeof buildIssuanceSeam>> {
    const steps: readonly ResolvedStep[] = [delegateStep('1', [delegateSubstep('1', 'child.md')])];
    const state = baseState();
    await activate(state);
    return buildIssuanceSeam(state, steps);
  }

  /**
   * Stand up an active runbook whose step `1` owns TWO authored DELEGATE
   * substeps, `1.1` and `1.2`, in the same frame.
   *
   * The retry-idempotency suites need a SECOND genuine, issuer-derivable
   * credential in the same frame: the displaced-row fixtures have to move a real
   * delegation off its own coordinate while leaving a different real delegation
   * behind, and a hand-built descriptor would refuse at `verifyDerivedBearer`
   * before the identity check under test is ever reached.
   */
  async function startSeamOnTwoDelegateSubsteps(): Promise<ReturnType<typeof buildIssuanceSeam>> {
    const steps: readonly ResolvedStep[] = [
      delegateStep('1', [delegateSubstep('1', 'child.md'), delegateSubstep('2', 'child.md')]),
    ];
    const state = baseState();
    await activate(state);
    return buildIssuanceSeam(state, steps);
  }

  /**
   * Stand up an active runbook with a reported-but-uncollected delegation
   * outcome on step `1`, so the delegation-issuance policy gate refuses with
   * `delegation_collection_pending` (mirrors the precheck collection-pending
   * fixture). Used to pin refusal-without-mutation.
   */
  async function startSeamWithCollectionPending(): Promise<ReturnType<typeof buildIssuanceSeam>> {
    const steps: readonly ResolvedStep[] = [delegateStep('1', [delegateSubstep('1', 'child.md')])];
    const completionKey = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
    const state = baseState({
      resolvedCompletions: {
        [completionKey]: buildResolvedCompletion({
          agentId: 'delegation',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: activeFrame(buildFrameKey('1'), 1),
          completedAt: '2026-06-28T00:00:00.000Z',
        }),
      },
    });
    await activate(state);
    return buildIssuanceSeam(state, steps);
  }

  /**
   * Stand up a runbook positioned ON the DELEGATE substep `1.1` (so
   * `state.substep` is set), used by the inferred `{ kind: 'active' }` retry.
   */
  async function startSeamOnActiveDelegateSubstep(): Promise<ReturnType<typeof buildIssuanceSeam>> {
    const steps: readonly ResolvedStep[] = [delegateStep('1', [delegateSubstep('1', 'child.md')])];
    const state = baseState({ substep: '1' });
    await activate(state);
    return buildIssuanceSeam(state, steps);
  }

  /**
   * Stand up a runbook positioned ON the DELEGATE substep `1.1` within an active
   * FOR iteration (iteration 2). Used to pin that the inferred
   * `{ kind: 'active' }` retry surfaces the iteration-qualified label (`1.2.1`).
   */
  async function startSeamOnActiveForIterationSubstep(): Promise<
    ReturnType<typeof buildIssuanceSeam>
  > {
    const steps: readonly ResolvedStep[] = [
      delegateForStep('1', [delegateSubstep('1', 'child.md')]),
    ];
    const iterationFrameKey = buildFrameKey('1', 2);
    const state = baseState({
      substep: '1',
      activeFrameKey: iterationFrameKey,
      frameEntryCounts: { [iterationFrameKey]: 1 },
      forStack: [
        { stepId: '1', iteration: 2, start: 1, end: 2, implicit: false, source: { kind: 'range' } },
      ],
    });
    await activate(state);
    return buildIssuanceSeam(state, steps);
  }

  /**
   * Stand up an active runbook positioned on step `2`, which owns two authored
   * DELEGATE substeps `2.1` and `2.2`. Exercises explicit `--step` targeting.
   */
  async function startSeamOnMultiStepRunbook(): Promise<ReturnType<typeof buildIssuanceSeam>> {
    const steps: readonly ResolvedStep[] = [
      delegateStep('1', [delegateSubstep('1', 'a.md')]),
      delegateStep('2', [delegateSubstep('1', 'b.md'), delegateSubstep('2', 'c.md')]),
    ];
    const state = baseState({
      step: '2',
      stepName: 'Step two',
      frameEntryCounts: { [buildFrameKey('2')]: 1 },
      activeFrameKey: buildFrameKey('2'),
    });
    await activate(state);
    return buildIssuanceSeam(state, steps);
  }

  describe('issueDelegation (fresh)', () => {
    it('refuses metadata-only plugin evidence without a presented bearer claim', async () => {
      const { seam: localSeam } = await startSeamOnDelegateStep();
      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: { kind: 'plugin', agentId: 'a' },
      });
      expect(outcome.kind).toBe('refused');
      if (outcome.kind !== 'refused') throw new Error('expected refused');
      expect(outcome.policy.kind).toBe('actor_context_required');
    });

    it('authorizes before exposing fresh indexed-target details', async () => {
      const { seam: localSeam } = await startSeamOnDelegateStep();

      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: { kind: 'plugin', agentId: 'a' },
        explicitTarget: { stepId: '1.1', iteration: 2 },
      });

      expect(outcome.kind).toBe('refused');
      if (outcome.kind !== 'refused') throw new Error('expected refused');
      expect(outcome.policy.kind).toBe('actor_context_required');
    });

    it('does not record when the presented bearer lacks the delegation grant', async () => {
      const { seam: localSeam, manager: mgr } = await startSeamOnDelegateStep();
      const evidence = runControlEvidence(runId);
      if (evidence.kind !== 'claim_bearer') throw new Error('expected bearer evidence');
      const claimKey = claimKeyFromBearer(evidence.claimId);
      const session = await mgr.loadSession();
      await patchPersistedClaim(mgr.cwd, claimKey, {
        grants: session.claims[claimKey].grants.filter(
          (grant) => grant.action !== 'delegate-from-run',
        ),
        lastSeenAt: '2020-01-01T00:00:00.000Z',
      });

      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: evidence,
      });

      expect(outcome.kind).toBe('refused');
      if (outcome.kind !== 'refused') throw new Error('expected refused');
      expect(outcome.policy.kind).toBe('claim_grant_required');
      expect((await mgr.loadSession()).claims[claimKey].lastSeenAt).toBe(
        '2020-01-01T00:00:00.000Z',
      );
    });

    it('issues a bare delegation and persists the new substep state', async () => {
      const { seam: localSeam, manager: mgr, state } = await startSeamOnDelegateStep();

      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });

      expect(outcome.kind).toBe('delegated');
      if (outcome.kind !== 'delegated') throw new Error('expected delegated');
      expect(outcome.token).toMatch(/^rdtk_/); // DELEGATION_TOKEN_PREFIX === 'rdtk_'
      expect(outcome.parentRunId).toBe(state.id);

      const persisted = await mgr.load(state.id);
      const issued = persisted?.substepStates?.find(
        (s) => s.delegation?.tokenHash === outcome.tokenHash,
      );
      expect(issued).toBeDefined();
    });

    // Fresh issuance authority is `delegate-from-run`; retry authority is
    // `retry-delegation`. `createRunControlGrants` mints both, so every fixture
    // built on a full run-control bearer authorizes either request and cannot
    // tell the two apart — the in-lock policy could ask for the wrong one and
    // still be allowed. Narrowing the bearer to fresh-issuance authority alone
    // makes the distinction observable.
    it('issues under a bearer holding delegate-from-run but not retry-delegation', async () => {
      const { seam: localSeam, manager: mgr } = await startSeamOnDelegateStep();
      const evidence = runControlEvidence(runId);
      if (evidence.kind !== 'claim_bearer') throw new Error('expected bearer evidence');
      const claimKey = claimKeyFromBearer(evidence.claimId);
      const session = await mgr.loadSession();
      await patchPersistedClaim(mgr.cwd, claimKey, {
        grants: session.claims[claimKey].grants.filter(
          (grant) => grant.action !== 'retry-delegation',
        ),
      });

      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: evidence,
      });

      expect(outcome.kind).toBe('delegated');
      if (outcome.kind !== 'delegated') throw new Error('expected delegated');
      expect(outcome.token).toMatch(/^rdtk_/);
    });

    // The converse: retry authority alone does not authorize a fresh mint.
    it('refuses a bearer holding retry-delegation but not delegate-from-run', async () => {
      const { seam: localSeam, manager: mgr } = await startSeamOnDelegateStep();
      const evidence = runControlEvidence(runId);
      if (evidence.kind !== 'claim_bearer') throw new Error('expected bearer evidence');
      const claimKey = claimKeyFromBearer(evidence.claimId);
      const session = await mgr.loadSession();
      await patchPersistedClaim(mgr.cwd, claimKey, {
        grants: session.claims[claimKey].grants.filter(
          (grant) => grant.action !== 'delegate-from-run',
        ),
      });

      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: evidence,
      });

      expect(outcome.kind).toBe('refused');
      if (outcome.kind !== 'refused') throw new Error('expected refused');
      expect(outcome.policy.kind).toBe('claim_grant_required');
    });

    it("anchors fresh issuance on the claim's controlled run, not the active default (#586)", async () => {
      // Run `runId` is activated with an authored DELEGATE substep and its own
      // run-control claim.
      const { seam: localSeam } = await startSeamOnDelegateStep();

      // A DIFFERENT run is then activated, so `runId` is controlled-but-not-active:
      // getActive() now returns this run, not `runId`.
      const otherRunId = assertRunId('rd_22222222222222222222222222222222');
      const activeDefault = baseState({ id: otherRunId, runbookPath: 'other.md' });
      await activate(activeDefault);

      // Delegating with `runId`'s run-control claim (NO --run) must anchor on
      // `runId` — the run the claim controls — not on the active default.
      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });

      expect(outcome.kind).toBe('delegated');
      if (outcome.kind !== 'delegated') throw new Error('expected delegated');
      // The load-bearing assertion: issuance anchored on the CONTROLLED run
      // (`runId`), not the active default (`otherRunId`). Before the fix the seam
      // anchors `otherRunId`, whose run the claim lacks a grant for, and the
      // outcome is `refused` (claim_grant_required) — so this expectation fails.
      expect(outcome.parentRunId).toBe(runId);
    });

    it('refuses a terminal claim rather than anchoring the active default (#586)', async () => {
      // The run `runId` is activated with a DELEGATE step and its run-control
      // claim, then driven terminal — so the claim resolves to `terminal_claim`,
      // NOT `claim`. A different run is the active default.
      const { seam: localSeam } = await startSeamOnDelegateStep();
      await manager.updateWithState(runId, () => ({ lifecycle: 'completed' as const }));
      const otherRunId = assertRunId('rd_33333333333333333333333333333333');
      await activate(baseState({ id: otherRunId, runbookPath: 'other.md' }));

      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });

      // The seam propagates the anchor's terminal refusal instead of anchoring
      // the active default (`otherRunId`) and refusing about a run the caller
      // never named. A mutant forcing the anchor's `claim` case true would
      // anchor the terminal `runId` and issue, so this assertion kills it.
      expect(outcome.kind).toBe('terminal_claim');
      if (outcome.kind !== 'terminal_claim') throw new Error('expected terminal_claim');
      expect(outcome.lifecycle).toBe('completed');
    });

    it('refuses a stale (nonexistent) claim rather than anchoring the active default (#586)', async () => {
      const { seam: localSeam } = await startSeamOnDelegateStep();
      const unknownClaimId = assertClaimId(
        'rdclm_99999999999999999999999999999999_abcdefghijklmnopqrstuvwxyzABCDE1234567890-_',
      );

      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: { kind: 'claim_bearer', claimId: unknownClaimId },
      });

      expect(outcome.kind).toBe('stale_claim');
      if (outcome.kind !== 'stale_claim') throw new Error('expected stale_claim');
      expect(outcome.message).toContain('does not exist');
    });

    it('returns the canonical persisted child ref (not the authored alias) and matches the echo', async () => {
      // The authored substep targets "child.md"; resolve it to a DIFFERENT
      // canonical path so returning the authored alias is observably wrong.
      const { seam: localSeam, deps } = await startSeamOnDelegateStep();
      deps.resolveChildRunbook = async (): Promise<{ path: string; ref: RunbookRef }> => ({
        path: 'runbooks/child.md',
        ref: { source: 'project', path: 'runbooks/child.md' },
      });

      const fresh = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      expect(fresh.kind).toBe('delegated');
      if (fresh.kind !== 'delegated') throw new Error('expected delegated');
      // Canonical ref, not the authored "child.md" alias.
      expect(fresh.runbookRef).toBe('runbooks/child.md');

      // Echo of the same delegation must surface the identical ref.
      const echo = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      expect(echo.kind).toBe('already-delegated');
      if (echo.kind !== 'already-delegated') throw new Error('expected echo');
      expect(echo.runbookRef).toBe(fresh.runbookRef);
    });

    it('echoes an existing in-flight delegation without re-resolving the child', async () => {
      // `deps` is the SAME mutable object passed to the seam constructor, so
      // reassigning a field here changes what the seam calls. The seam's own
      // field is private (`#deps`), so the test mutates the shared object.
      const { seam: localSeam, deps } = await startSeamOnDelegateStep();
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (first.kind !== 'delegated') throw new Error('expected first delegated');

      // Make the child unresolvable for the second call; echo must still succeed.
      deps.resolveChildRunbook = async () => undefined;

      const second = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      expect(second.kind).toBe('already-delegated');
      if (second.kind !== 'already-delegated') throw new Error('expected echo');
      expect(second.token).toBe(first.token);
    });

    it('refuses a fresh issuance whose authored child runbook does not resolve (RD-805)', async () => {
      // The echo path deliberately never resolves the authored child, so the
      // unresolvable-child branch is reachable only on a genuinely issuable
      // target. Nothing may be persisted: the refusal lands inside the fence's
      // `beforeEffect`, before any credential is minted.
      const { seam: localSeam, deps, manager: mgr, state } = await startSeamOnDelegateStep();
      deps.resolveChildRunbook = async () => undefined;

      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });

      expect(outcome.kind).toBe('error');
      if (outcome.kind !== 'error') throw new Error('expected error');
      expect(outcome.error.code).toBe('RD-805');
      expect((await mgr.load(state.id))?.substepStates ?? []).toHaveLength(0);
    });

    it('issues into the persisted active frame, not the frame derived from the FOR stack', async () => {
      // A bare issue reads `activeFrameKey` first and only derives a frame when
      // the state carries none. On a prompted-FOR step the two disagree: there
      // is no `forClause`, so no FOR context exists to derive an iteration from,
      // yet an earlier `--index` operation left the run parked on frame `1|2`.
      // Deriving instead of reading would mint the delegation against `1|`, an
      // iteration the operator is not on.
      const steps: readonly ResolvedStep[] = [
        delegatePromptedForStep('1', [delegateSubstep('1', 'child.md')]),
      ];
      const iterationFrameKey = buildFrameKey('1', 2);
      const state = baseState({
        activeFrameKey: iterationFrameKey,
        frameEntryCounts: { [iterationFrameKey]: 1 },
      });
      await activate(state);
      const { seam: localSeam, manager: mgr } = buildIssuanceSeam(state, steps);

      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });

      expect(outcome.kind).toBe('delegated');
      if (outcome.kind !== 'delegated') throw new Error('expected delegated');
      const persisted = await mgr.load(state.id);
      expect(
        findSubstepState(persisted?.substepStates ?? [], '1', iterationFrameKey)?.delegation
          ?.tokenHash,
      ).toBe(outcome.tokenHash);
      expect(
        findSubstepState(persisted?.substepStates ?? [], '1', buildFrameKey('1')),
      ).toBeUndefined();
    });

    it('rejects a positional arg that names a different child than the authored target (RD-822)', async () => {
      const { seam: localSeam } = await startSeamOnDelegateStep(); // authored child is "child.md"
      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
        requestedRunbook: 'different.md',
      });
      expect(outcome.kind).toBe('error');
      if (outcome.kind !== 'error') throw new Error('expected error');
      expect(outcome.error.code).toBe('RD-822');
    });

    it('rejects a positional arg that resolves to nothing at all (RD-822)', async () => {
      // The other half of the mismatch guard: a positional that does not resolve
      // AT ALL is a distinct state from one that resolves to a different ref,
      // and it must refuse rather than fall through to the authored target — a
      // typo would otherwise silently delegate the authored child instead.
      const { seam: localSeam, deps, manager: mgr, state } = await startSeamOnDelegateStep();
      const resolveAuthored = deps.resolveChildRunbook;
      deps.resolveChildRunbook = async (name) =>
        name === 'typo.md' ? undefined : resolveAuthored(name);

      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
        requestedRunbook: 'typo.md',
      });

      expect(outcome.kind).toBe('error');
      if (outcome.kind !== 'error') throw new Error('expected error');
      expect(outcome.error.code).toBe('RD-822');
      expect((await mgr.load(state.id))?.substepStates ?? []).toHaveLength(0);
    });

    // The machine is the second, independent gate on an issuance the delegation
    // resolver already called issuable. Its refusals are mapped by status, and
    // an unmodelled status is a programming error the seam must not swallow —
    // both are unreachable from the resolver's own agreement with the machine,
    // so the mapping is pinned by driving the preparation directly.
    describe('machine preparation refusals', () => {
      it.each([['error'], ['child_in_flight']] as const)(
        'maps a %s preparation status to the machine error verbatim',
        async (status) => {
          const { seam: localSeam, manager: mgr, state } = await startSeamOnDelegateStep();
          const refusal = Errors.delegationInFlight('1.1', 'rd_cccccccccccccccccccccccccccccccc');
          jest
            .spyOn(RunbookActorService.prototype, 'prepareManualDelegationMutation')
            .mockResolvedValue(
              status === 'error'
                ? { status: 'error', error: refusal }
                : {
                    status: 'child_in_flight',
                    childRunId: assertRunId('rd_cccccccccccccccccccccccccccccccc'),
                    error: refusal,
                  },
            );

          const outcome = await localSeam.issueDelegation({
            mode: 'fresh',
            callerEvidence: runControlEvidence(runId),
          });

          expect(outcome.kind).toBe('error');
          if (outcome.kind !== 'error') throw new Error('expected error');
          expect(outcome.error).toBe(refusal);
          expect((await mgr.load(state.id))?.substepStates ?? []).toHaveLength(0);
        },
      );

      it('throws rather than committing when preparation returns an unmodelled status', async () => {
        const { seam: localSeam, manager: mgr, state } = await startSeamOnDelegateStep();
        jest
          .spyOn(RunbookActorService.prototype, 'prepareManualDelegationMutation')
          .mockResolvedValue({ status: 'already_cancelled' });

        await expect(
          localSeam.issueDelegation({
            mode: 'fresh',
            callerEvidence: runControlEvidence(runId),
          }),
        ).rejects.toThrow('Issue preparation returned already_cancelled');
        expect((await mgr.load(state.id))?.substepStates ?? []).toHaveLength(0);
      });
    });

    it('refuses a bare issue when the run has pending uncollected outcomes', async () => {
      const { seam: localSeam, manager: mgr, state } = await startSeamWithCollectionPending();
      const before = await mgr.load(state.id);
      const evidence = runControlEvidence(runId);
      if (evidence.kind !== 'claim_bearer') throw new Error('expected bearer evidence');
      const claimKey = claimKeyFromBearer(evidence.claimId);
      await patchPersistedClaim(mgr.cwd, claimKey, {
        lastSeenAt: '2020-01-01T00:00:00.000Z',
      });

      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: evidence,
      });

      expect(outcome.kind).toBe('refused');
      if (outcome.kind !== 'refused') throw new Error('expected refused');
      expect(outcome.policy.kind).toBe('delegation_collection_pending');

      const after = await mgr.load(state.id);
      expect(after?.substepStates).toEqual(before?.substepStates); // no mutation
      expect(Date.parse((await mgr.loadSession()).claims[claimKey].lastSeenAt)).toBeGreaterThan(
        Date.parse('2020-01-01T00:00:00.000Z'),
      );
    });

    it('refuses a positional confirmation (requestedRunbook, no --step) when collection is pending', async () => {
      // A positional `rd delegate <child>` names the authored child as a
      // confirmation of the already-pending delegate substep; it is NOT a
      // step-target, so it stays `targeted: false` and remains subject to the
      // collection-pending gate (regression guard: a stray `|| requestedRunbook`
      // in the seam's `targeted` computation bypassed this).
      const { seam: localSeam, manager: mgr, state } = await startSeamWithCollectionPending();
      const before = await mgr.load(state.id);

      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
        requestedRunbook: 'child.md', // matches the authored child (no RD-822)
      });

      expect(outcome.kind).toBe('refused');
      if (outcome.kind !== 'refused') throw new Error('expected refused');
      expect(outcome.policy.kind).toBe('delegation_collection_pending');

      const after = await mgr.load(state.id);
      expect(after?.substepStates).toEqual(before?.substepStates); // no mutation
    });

    it('issues for an explicit --step target', async () => {
      const { seam: localSeam } = await startSeamOnMultiStepRunbook();
      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
        explicitTarget: { stepId: '2.2' },
      });
      expect(outcome.kind).toBe('delegated');
      if (outcome.kind !== 'delegated') throw new Error('expected delegated');
      expect(outcome.stepId).toBe('2.2');
    });

    it('keeps a sibling substep state when a second delegation is issued on the same step', async () => {
      // The issuance persist rewrites `substepStates` through
      // `replaceSubstepStateEntry(state.substepStates ?? [], issued)`. Replacing
      // that base array with an empty one (the `?? []` fallback taken
      // unconditionally) still returns a well-formed array carrying the entry
      // just issued — so a single-delegation run cannot tell the difference.
      // Only a run holding a SECOND, untouched substep entry observes that the
      // base array is the live one and not a fresh empty list.
      const { seam: localSeam, manager: mgr, state } = await startSeamOnMultiStepRunbook();

      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
        explicitTarget: { stepId: '2.1' },
      });
      if (first.kind !== 'delegated') throw new Error('expected first delegated');
      const second = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
        explicitTarget: { stepId: '2.2' },
      });
      if (second.kind !== 'delegated') throw new Error('expected second delegated');

      const persisted = await mgr.load(state.id);
      const frameKey = buildFrameKey('2');
      expect(
        findSubstepState(persisted?.substepStates ?? [], '1', frameKey)?.delegation?.tokenHash,
      ).toBe(first.tokenHash);
      expect(
        findSubstepState(persisted?.substepStates ?? [], '2', frameKey)?.delegation?.tokenHash,
      ).toBe(second.tokenHash);
    });

    it('forwards resolved extraVars into the persisted delegation and its context snapshot', async () => {
      // Resolving the thunk is not the contract — carrying its value into the
      // machine's ISSUE event is. Dropping the `extraVars` field entirely (or
      // spreading it only when it is absent) still mints a valid token, so the
      // resolved value has to be observed where the child will read it.
      const { seam: localSeam, manager: mgr, state } = await startSeamOnDelegateStep();

      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
        resolveExtraVars: async () => ({ environment: 'staging' }) as const,
      });

      expect(outcome.kind).toBe('delegated');
      const delegation = findSubstepState(
        (await mgr.load(state.id))?.substepStates ?? [],
        '1',
        buildFrameKey('1'),
      )?.delegation;
      expect(delegation?.extraVars).toEqual({ environment: 'staging' });
      expect(delegation?.contextSnapshot.vars).toEqual(
        expect.objectContaining({ environment: 'staging' }),
      );
    });

    it('resolves extraVars exactly once on the issuable path', async () => {
      const { seam: localSeam } = await startSeamOnDelegateStep();
      const resolveExtraVars = jest.fn(async () => ({ environment: 'staging' }) as const);

      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
        resolveExtraVars,
      });

      expect(outcome.kind).toBe('delegated');
      expect(resolveExtraVars).toHaveBeenCalledTimes(1);
    });

    it('never resolves extraVars on the echo path', async () => {
      const { seam: localSeam } = await startSeamOnDelegateStep();
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (first.kind !== 'delegated') throw new Error('expected first delegated');

      const resolveExtraVars = jest.fn(async () => undefined);
      const second = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
        resolveExtraVars,
      });

      expect(second.kind).toBe('already-delegated');
      expect(resolveExtraVars).not.toHaveBeenCalled();
    });

    it('records the explicit --index iteration in the delegation context snapshot (not the live FOR iteration)', async () => {
      // A fresh `--step 1.1 --index 2` against a FOR step whose LIVE iteration is
      // 1 must capture iteration 2 in the persisted context snapshot. The frame
      // key already scopes the substep entry to `1|2`; the snapshot's `index`/`at`
      // must agree, or the claimed child inherits the wrong `Index`. (Regression:
      // the seam passed a step id WITHOUT the iteration segment to
      // createDelegation, so the snapshot iteration fell back to the live one.)
      const steps: readonly ResolvedStep[] = [
        delegateForStep('1', [delegateSubstep('1', 'child.md')]),
      ];
      const activeFrameKey = buildFrameKey('1', 1);
      const state = baseState({
        activeFrameKey,
        frameEntryCounts: { [activeFrameKey]: 1 },
        forStack: [
          {
            stepId: '1',
            iteration: 1,
            start: 1,
            end: 2,
            implicit: false,
            source: { kind: 'range' },
          },
        ],
      });
      await activate(state);
      const { seam: localSeam, manager: mgr } = buildIssuanceSeam(state, steps);

      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
        explicitTarget: { stepId: '1.1', iteration: 2 },
      });
      expect(outcome.kind).toBe('delegated');

      const persisted = await mgr.load(state.id);
      const entry = persisted?.substepStates?.find((s) => s.frameKey === buildFrameKey('1', 2));
      expect(entry).toBeDefined();
      expect(entry?.delegation?.contextSnapshot.index).toBe(2);
      expect(entry?.delegation?.contextSnapshot.at).toBe('1.2.1');
    });

    it('positional no-step over an auto-issued frontier echoes the existing token (was RD-813)', async () => {
      // #496: `rd delegate child.md` (positional, no --step) after the frontier
      // was already issued must echo the in-flight token — parity with the bare
      // form — instead of exhausting the frontier scan into a thrown RD-813.
      const { seam: localSeam } = await startSeamOnDelegateStep();
      const fresh = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (fresh.kind !== 'delegated') throw new Error('expected delegated');

      const echo = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
        requestedRunbook: 'child.md',
      });
      expect(echo.kind).toBe('already-delegated');
      if (echo.kind !== 'already-delegated') throw new Error('expected echo');
      expect(echo.token).toBe(fresh.token);
      expect(echo.stepId).toBe(fresh.stepId);
    });

    it('positional no-step naming a different runbook than the in-flight one errors RD-804', async () => {
      const { seam: localSeam } = await startSeamOnDelegateStep();
      const fresh = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (fresh.kind !== 'delegated') throw new Error('expected delegated');

      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
        requestedRunbook: 'other.md',
      });
      expect(outcome.kind).toBe('error');
      if (outcome.kind !== 'error') throw new Error('expected error');
      expect(outcome.error.code).toBe('RD-804'); // DELEGATION_ALREADY_EXISTS
    });

    it('refuses an explicit --step re-issue over a claimed delegation (RD-811) without re-minting', async () => {
      const { seam: localSeam, manager: mgr, state } = await startSeamOnDelegateStep();
      const fresh = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (fresh.kind !== 'delegated') throw new Error('expected delegated');

      // A child claimed the token: persist the linkage on the delegation.
      const childRunId = assertRunId('rd_22222222222222222222222222222222');
      await mgr.updateWithState(state.id, (current) => ({
        substepStates: (current.substepStates ?? []).map((entry) =>
          entry.delegation?.tokenHash === fresh.tokenHash
            ? { ...entry, delegation: { ...entry.delegation, childRunId } }
            : entry,
        ),
      }));

      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
        explicitTarget: { stepId: '1.1' },
      });
      expect(outcome.kind).toBe('error');
      if (outcome.kind !== 'error') throw new Error('expected error');
      expect(outcome.error.code).toBe('RD-811'); // DELEGATION_ALREADY_CLAIMED

      // The persisted delegation is untouched: same tokenHash, same claim.
      const persisted = await mgr.load(state.id);
      const entry = persisted?.substepStates?.find((s) => s.id === '1');
      expect(entry?.delegation?.tokenHash).toBe(fresh.tokenHash);
      expect(entry?.delegation?.childRunId).toBe(childRunId);
    });

    it('preserves a concurrent substep write landing between the active-state read and the issuance persist', async () => {
      // Last-write-wins guard: the seam reads the active state, computes the new
      // substep array, then persists. A concurrent writer that commits an
      // unrelated substep entry in that gap must NOT be clobbered — the persist
      // merges only the affected entry under a locked read-modify-write.
      const steps: readonly ResolvedStep[] = [
        delegateStep('1', [delegateSubstep('1', 'child.md')]),
      ];
      const state = baseState();
      await activate(state);
      const { seam: localSeam, deps, manager: mgr } = buildIssuanceSeam(state, steps);

      // The concurrent write is injected via resolveChildRunbook, which the seam
      // invokes on the issuable path AFTER its active-state read and BEFORE the
      // issuance persist.
      const concurrentEntry: SubstepState = {
        id: '2',
        frameKey: buildFrameKey('1'),
        status: 'running',
      };
      let injected = false;
      deps.resolveChildRunbook = async (name): Promise<{ path: string; ref: RunbookRef }> => {
        if (!injected) {
          injected = true;
          await mgr.updateWithState(state.id, (fresh) => ({
            substepStates: [...(fresh.substepStates ?? []), concurrentEntry],
          }));
        }
        return { path: name, ref: { source: 'project', path: name } };
      };

      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      expect(outcome.kind).toBe('concurrent_modification');

      const persisted = await mgr.load(state.id);
      // The concurrent substep survives the issuance persist...
      expect(persisted?.substepStates?.find((s) => s.id === '2')).toEqual(concurrentEntry);
      // The fenced issuance refuses instead of overwriting that newer state.
      expect(persisted?.substepStates?.find((s) => s.id === '1')?.delegation).toBeUndefined();
    });

    it('persists no credential when ownership is lost before the effect boundary', async () => {
      const { seam: localSeam, manager: mgr, state } = await startSeamOnDelegateStep();
      jest.spyOn(SqliteExecutionLeaseService.prototype, 'markEffectStartedAll').mockResolvedValue({
        kind: 'execution_in_progress',
        runId: state.id,
        message: 'ownership lost before the effect boundary',
      });

      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });

      expect(outcome.kind).toBe('execution_in_progress');
      const persisted = await mgr.load(state.id);
      expect(
        persisted?.substepStates?.find((entry) => entry.id === '1')?.delegation,
      ).toBeUndefined();
    });

    it('recovers without exposing or persisting a credential after effect start but before commit', async () => {
      const { seam: localSeam, manager: mgr, state } = await startSeamOnDelegateStep();
      jest.spyOn(actorService, 'createRecoveryActor').mockImplementation(() => {
        throw new InvalidRunbookStateError('simulated process death before commit');
      });
      jest
        .spyOn(RunbookStore.prototype, 'commitOwnedRunSet')
        .mockRejectedValue(new Error('crash before durable commit'));

      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });

      expect(outcome.kind).toBe('aggregate_recovery_required');
      expect(JSON.stringify(outcome)).not.toContain('rdtk_');
      const persisted = await mgr.load(state.id);
      expect(
        persisted?.substepStates?.find((entry) => entry.id === '1')?.delegation,
      ).toBeUndefined();
    });

    it('rehydrates the interrupted issuance member from its own captured steps', async () => {
      // The counterpart to the test above: recovery is not merely attempted, it
      // SUCCEEDS, and success is what leaves the run usable. The seam's
      // `makeRecoveryActor` is the only thing that can rehydrate the runbook
      // graph for the interrupted member — the aggregate runner swallows a
      // failing factory (by design, so one member cannot mask the typed
      // outcome), so a broken factory is invisible in the first call's result
      // and shows up only here, as a run stuck `recovery_pending` that refuses
      // every later command.
      const steps: readonly ResolvedStep[] = [
        delegateStep('1', [delegateSubstep('1', 'child.md')]),
      ];
      const state = baseState();
      await activate(state);
      const { seam: localSeam } = buildIssuanceSeam(state, steps);
      jest
        .spyOn(RunbookStore.prototype, 'commitOwnedRunSet')
        .mockRejectedValue(new Error('crash before durable commit'));
      const recoverySpy = jest.spyOn(actorService, 'createRecoveryActor').mockImplementation(() => {
        throw new InvalidRunbookStateError('recovery actor unavailable');
      });

      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      expect(outcome.kind).toBe('aggregate_recovery_required');

      // Called once, for the interrupted parent, with the steps `beforeEffect`
      // recorded for that exact run — not a stale set, and not skipped.
      expect(recoverySpy).toHaveBeenCalledTimes(1);
      expect(recoverySpy.mock.calls[0]?.[0].id).toBe(state.id);
      expect(recoverySpy.mock.calls[0]?.[1]).toEqual(steps);
    });

    it('reconciles committed-but-unobserved issuance and reconstructs the exact token', async () => {
      const { seam: localSeam } = await startSeamOnDelegateStep();
      // Captured deliberately so the prototype spy can delegate with its runtime instance.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const commit = RunbookStore.prototype.commitOwnedRunSet;
      let first = true;
      jest.spyOn(RunbookStore.prototype, 'commitOwnedRunSet').mockImplementation(async function (
        this: RunbookStore,
        input,
      ) {
        const result = await commit.call(this, input);
        if (first) {
          first = false;
          throw new Error('crash after durable commit');
        }
        return result;
      });

      const issued = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      expect(issued.kind).toBe('delegated');
      if (issued.kind !== 'delegated') throw new Error('expected reconciled delegation');

      const echo = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      expect(echo.kind).toBe('already-delegated');
      if (echo.kind !== 'already-delegated') throw new Error('expected delegation echo');
      expect(echo.token).toBe(issued.token);
    });

    // An echo is a credential disclosure, so it is gated on the same invariant
    // `projectDelegateFrontier` enforces at the observation boundary: the token
    // reconstructed from the persisted descriptor must hash to the verifier the
    // parent recorded. Both failure modes must refuse as typed data and must
    // never put a bearer on the wire.
    it('refuses to echo a delegation whose persisted verifier does not match the derived token', async () => {
      const { seam: localSeam, manager: mgr, state } = await startSeamOnDelegateStep();
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (first.kind !== 'delegated') throw new Error('expected delegated');

      // Tamper only the verifier: the descriptor still derives under the issuing
      // claim, but the reconstructed token no longer matches what was recorded.
      await mgr.updateWithState(state.id, (current) => ({
        substepStates: (current.substepStates ?? []).map((entry) =>
          entry.delegation?.tokenHash === first.tokenHash
            ? {
                ...entry,
                delegation: {
                  ...entry.delegation,
                  tokenHash: assertDelegationTokenHash(`sha256:${'b'.repeat(64)}`),
                },
              }
            : entry,
        ),
      }));

      const echo = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });

      expect(echo.kind).toBe('error');
      if (echo.kind !== 'error') throw new Error('expected a typed refusal');
      expect(echo.error.code).toBe('RD-821');
      // The two RD-821 arms are distinguishable only by their message: a
      // verifier mismatch is a tampered/corrupted record, which is a different
      // operator action from a rotated issuing claim below.
      expect(echo.error.context.reason).toBe(
        'reconstructed delegation credential for 1.1 does not match its persisted verifier',
      );
      expect(echo).not.toHaveProperty('token');
      const serialized = JSON.stringify(echo);
      expect(serialized).not.toContain(first.token);
      expect(serialized).not.toContain(TOKEN_PREFIX);
      expect(serialized).not.toContain(DELEGATION_CLAIM_MARKER);
    });

    it('refuses to echo a delegation the presenting claim cannot re-derive after issuer rotation', async () => {
      const { seam: localSeam } = await startSeamOnDelegateStep();
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (first.kind !== 'delegated') throw new Error('expected delegated');

      // Rotate the run-control claim. The new bearer is authorized for the run
      // but did not issue the in-flight credential, so derivation cannot
      // succeed — and must surface as data, not as an escaping throw.
      await issueRunControlClaimFor(runId);

      const echo = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });

      expect(echo.kind).toBe('error');
      if (echo.kind !== 'error') throw new Error('expected a typed refusal');
      expect(echo.error.code).toBe('RD-821');
      // Distinct from the verifier-mismatch arm above: derivation itself failed,
      // so the message must say the presented claim cannot reconstruct the
      // credential rather than implying the persisted record is corrupt.
      expect(echo.error.context.reason).toBe(
        'the presented claim cannot reconstruct the in-flight delegation credential for 1.1',
      );
      expect(echo).not.toHaveProperty('token');
      const serialized = JSON.stringify(echo);
      expect(serialized).not.toContain(first.token);
      expect(serialized).not.toContain(TOKEN_PREFIX);
      expect(serialized).not.toContain(DELEGATION_CLAIM_MARKER);
    });

    it('validates a fresh explicit iteration against the in-fence step reread', async () => {
      // The `--index` legality check is state-dependent, so it must read the
      // document the fence protects, not a snapshot taken before it. The parsed
      // document flips from FOR to substeps exactly as the fence is entered:
      // only a decision made from `beforeEffect`'s own reread can observe it.
      // And the refusal must precede every effect — no extraVars resolution, no
      // machine preparation, nothing persisted.
      const forSteps: readonly ResolvedStep[] = [
        delegateForStep('1', [delegateSubstep('1', 'child.md')]),
      ];
      const state = baseState();
      await activate(state);
      const { seam: localSeam, deps, manager: mgr } = buildIssuanceSeam(state, forSteps);
      const prepareSpy = jest.spyOn(
        RunbookActorService.prototype,
        'prepareManualDelegationMutation',
      );
      const resolveExtraVars = jest.fn(async () => undefined);
      deps.actorMutationRunner = runnerWithFenceEntryHook(deps.actorMutationRunner, () => {
        deps.loadSteps = () => [delegateStep('1', [delegateSubstep('1', 'child.md')])];
      });

      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
        explicitTarget: { stepId: '1.1', iteration: 2 },
        resolveExtraVars,
      });

      expect(outcome.kind).toBe('invalid_index');
      if (outcome.kind !== 'invalid_index') throw new Error('expected invalid_index');
      expect(outcome.message).toBe(
        '--index requires step "1" to be a FOR step, but it is "substeps"',
      );
      expect(resolveExtraVars).not.toHaveBeenCalled();
      expect(prepareSpy).not.toHaveBeenCalled();
      expect((await mgr.load(state.id))?.substepStates ?? []).toHaveLength(0);
    });

    it('validates the named step rather than the first parsed step', async () => {
      // Deliberately mis-ordered: the FOR step is FIRST and the named target is
      // SECOND, so a positional lookup (`steps[0]`) reads a FOR step and lets
      // the illegal `--index` through. Only a name-keyed lookup refuses. Do not
      // reorder these — the ordering IS the assertion.
      const steps: readonly ResolvedStep[] = [
        delegateForStep('2', [delegateSubstep('1', 'other.md')]),
        delegateStep('1', [delegateSubstep('1', 'child.md')]),
      ];
      const state = baseState();
      await activate(state);
      const { seam: localSeam } = buildIssuanceSeam(state, steps);

      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
        explicitTarget: { stepId: '1.1', iteration: 2 },
      });

      expect(outcome.kind).toBe('invalid_index');
      if (outcome.kind !== 'invalid_index') throw new Error('expected invalid_index');
      expect(outcome.message).toBe(
        '--index requires step "1" to be a FOR step, but it is "substeps"',
      );
    });

    it('accepts explicit iterations on prompted-FOR targets', async () => {
      // A prompted-FOR step is a FOR step whose bounds did not resolve. It has
      // no `forClause` and no iteration machinery, but `--index` still names a
      // legitimate frame on it, so the legality check must admit it alongside
      // `for` rather than refusing it as a non-FOR kind.
      const steps: readonly ResolvedStep[] = [
        delegatePromptedForStep('1', [delegateSubstep('1', 'child.md')]),
      ];
      const state = baseState();
      await activate(state);
      const { seam: localSeam } = buildIssuanceSeam(state, steps);

      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
        explicitTarget: { stepId: '1.1', iteration: 2 },
      });

      expect(outcome.kind).toBe('delegated');
      // Admitting the target is only half the contract — the issuance must also
      // LAND on the frame `--index` named. Asserting the outcome kind alone
      // would pass just as well if the iteration were dropped and the
      // delegation written to the un-indexed frame `1|`.
      const persisted = await manager.load(runId);
      const iterationFrameKey = buildFrameKey('1', 2);
      expect(
        findSubstepState(persisted?.substepStates ?? [], '1', iterationFrameKey)?.delegation,
      ).toBeDefined();
      expect(
        findSubstepState(persisted?.substepStates ?? [], '1', buildFrameKey('1'))?.delegation,
      ).toBeUndefined();
    });

    it('defers an unparsable indexed target to the delegation error contract', async () => {
      // `--index` legality is only decidable for a target that parses. An
      // unparsable one must fall THROUGH the check untouched so the delegation
      // resolver keeps ownership of "step not found" — the guard exists to
      // return early, not to let the lookup dereference a null parse. Without
      // it the seam raises a TypeError that escapes as an unhandled rejection
      // instead of a typed outcome.
      const state = baseState();
      await activate(state);
      const { seam: localSeam } = buildIssuanceSeam(state, [
        delegateForStep('1', [delegateSubstep('1', 'child.md')]),
      ]);

      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
        explicitTarget: { stepId: 'not-a-step', iteration: 2 },
      });

      expect(outcome.kind).toBe('error');
      if (outcome.kind !== 'error') throw new Error('expected error');
      expect(outcome.error.code).toBe('RD-814');
    });
  });

  describe('issueDelegation (retry)', () => {
    it('retries a delegation by step locator and mints a fresh token', async () => {
      const { seam: localSeam } = await startSeamOnDelegateStep();
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (first.kind !== 'delegated') throw new Error('expected delegated');

      const retried = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(runId),
        locator: { kind: 'step', step: first.stepId },
      });
      expect(retried.kind).toBe('retried');
      if (retried.kind !== 'retried') throw new Error('expected retried');
      expect(retried.token).not.toBe(first.token);
    });

    it("anchors retry-step issuance on the claim's controlled run, not the active default (#586)", async () => {
      // Fresh issuance while `runId` is still the active default: mints the token
      // the retry below locates by step.
      const { seam: localSeam, manager: localManager, state } = await startSeamOnDelegateStep();
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (first.kind !== 'delegated') throw new Error('expected delegated');

      // A DIFFERENT run is then activated, so `runId` is controlled-but-not-active:
      // getActive() now returns this run, not `runId`.
      const otherRunId = assertRunId('rd_44444444444444444444444444444444');
      await activate(baseState({ id: otherRunId, runbookPath: 'other.md' }));

      const outcome = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(runId),
        locator: { kind: 'step', step: first.stepId },
      });

      expect(outcome.kind).toBe('retried');
      if (outcome.kind !== 'retried') throw new Error('expected retried');
      // Anchored on the controlled run (`runId`), not the active default. Before
      // the Step 4 fix the retry-step locator anchors the active default, whose run
      // the claim lacks a grant for, so the outcome is `refused`.
      expect(outcome.parentRunId).toBe(runId);

      const persisted = await localManager.load(state.id);
      const delegation = findSubstepState(
        persisted?.substepStates ?? [],
        '1',
        buildFrameKey('1'),
      )?.delegation;
      expect(delegation?.tokenHash).toBe(outcome.tokenHash);
      expect(delegation?.tokenHash).not.toBe(first.tokenHash);
    });

    it('authorizes before exposing retry indexed-target details', async () => {
      const { seam: localSeam } = await startSeamOnDelegateStep();
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (first.kind !== 'delegated') throw new Error('expected delegated');

      const outcome = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: { kind: 'plugin', agentId: 'a' },
        locator: { kind: 'step', step: first.stepId, iteration: 2 },
      });

      expect(outcome.kind).toBe('refused');
      if (outcome.kind !== 'refused') throw new Error('expected refused');
      expect(outcome.policy.kind).toBe('actor_context_required');
    });

    it('retries the active substep via { kind: "active" }', async () => {
      const { seam: localSeam } = await startSeamOnActiveDelegateSubstep();
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (first.kind !== 'delegated') throw new Error('expected delegated');
      const retried = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(runId),
        locator: { kind: 'active' },
      });
      expect(retried.kind).toBe('retried');
    });

    it("anchors retry-active issuance on the claim's controlled run, not the active default (#586)", async () => {
      // Pins the THIRD anchor call site (the inferred-`active` retry locator).
      // Without this, reverting only that site to `getActive()` leaves the whole
      // core suite green — the defect would be caught solely by a slow CLI
      // integration test.
      const { seam: localSeam } = await startSeamOnActiveDelegateSubstep();
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (first.kind !== 'delegated') throw new Error('expected delegated');

      // A DIFFERENT run becomes the active default, so `runId` is
      // controlled-but-not-active. The second run sits on no substep, so an
      // active-default anchor cannot resolve a substep cursor at all.
      const otherRunId = assertRunId('rd_66666666666666666666666666666666');
      await activate(baseState({ id: otherRunId, runbookPath: 'other.md' }));

      const outcome = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(runId),
        locator: { kind: 'active' },
      });

      expect(outcome.kind).toBe('retried');
      if (outcome.kind !== 'retried') throw new Error('expected retried');
      expect(outcome.parentRunId).toBe(runId);
    });

    it('retries a linked terminal child without allowing the stale child to re-report', async () => {
      const { seam: localSeam, deps, manager: mgr, state } = await startSeamOnDelegateStep();
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (first.kind !== 'delegated') throw new Error('expected delegated');

      const keyForSubstep = (substepId: string) =>
        buildCompletionKey(activeFrame(buildFrameKey('1'), 1), substepId);
      const childRunId = assertRunId('rd_33333333333333333333333333333333');
      await mgr.updateWithState(state.id, (current) => ({
        substepStates: (current.substepStates ?? []).map((entry) =>
          entry.delegation?.tokenHash === first.tokenHash
            ? {
                ...entry,
                status: 'done',
                result: 'fail',
                delegation: { ...entry.delegation, childRunId },
              }
            : entry,
        ),
      }));
      await mgr.save(
        baseState({
          id: childRunId,
          lifecycle: 'completed',
          parentLinkage: {
            kind: 'delegation',
            parentRunId: state.id,
            parentStepId: '1',
            parentStep: '1',
            parentFrameKey: buildFrameKey('1'),
            parentEntry: 1,
            tokenHash: assertDelegationTokenHash(first.tokenHash),
          },
        }),
      );
      await issueRunControlClaimFor(childRunId);
      const parentWithLinkedChild = await mgr.load(state.id);
      if (!parentWithLinkedChild) throw new Error('expected persisted parent');
      await mgr.save({
        ...parentWithLinkedChild,
        resolvedCompletions: {
          [keyForSubstep('1')]: buildResolvedCompletion({
            agentId: 'delegation',
            result: 'fail',
            targetStep: '1',
            targetSubstep: '1',
            targetFrame: activeFrame(buildFrameKey('1'), 1),
            completedAt: '2026-07-05T00:00:00.000Z',
          }),
          [keyForSubstep('2')]: buildResolvedCompletion({
            agentId: 'delegation',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '2',
            targetFrame: activeFrame(buildFrameKey('1'), 1),
            completedAt: '2026-07-05T00:00:00.000Z',
          }),
        },
      });
      const releaseSpy = jest.spyOn(deps.sessionService, 'releaseRunbook');

      const retried = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(runId),
        locator: { kind: 'step', step: first.stepId },
      });

      expect(retried.kind).toBe('retried');
      expect(releaseSpy).not.toHaveBeenCalled();
      // The release is folded into the aggregate commit rather than issued as a
      // follow-on session write, and it DISCARDS the stale child's claim rather
      // than retaining it as a terminal tombstone: a retained tombstone would
      // still confirm/conflict for a `--claim-id` the retry has superseded.
      const retiredChildClaim = issuedRunControlClaims.get(childRunId);
      if (retiredChildClaim === undefined) throw new Error('expected child claim');
      expect(
        (await mgr.loadSession()).claims[claimKeyFromBearer(retiredChildClaim)],
      ).toBeUndefined();
      const persisted = await mgr.load(state.id);
      const entry = persisted?.substepStates?.find((s) => s.id === '1');
      expect(entry?.delegation?.childRunId).toBeNull();
      expect(entry?.delegation?.tokenHash).not.toBe(first.tokenHash);
      await expect(
        lifecycleService.getResolvedCompletion(state.id, keyForSubstep('1')),
      ).resolves.toBeNull();
      await expect(
        lifecycleService.getResolvedCompletion(state.id, keyForSubstep('2')),
      ).resolves.not.toBeNull();

      const terminalChild = await mgr.load(childRunId);
      if (!terminalChild) throw new Error('expected terminal child to remain for diagnostics');
      await expect(
        deps.completionService.recordChildCompletion({ childState: terminalChild }),
      ).resolves.toBe('not-applicable');
      await expect(
        lifecycleService.getResolvedCompletion(state.id, keyForSubstep('1')),
      ).resolves.toBeNull();
    });

    it('rolls back parent retry, child release, and completion supersession when session projection fails', async () => {
      const { seam: localSeam, manager: mgr, state } = await startSeamOnDelegateStep();
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (first.kind !== 'delegated') throw new Error('expected delegated');

      const childRunId = assertRunId('rd_33333333333333333333333333333333');
      const completionKey = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
      await mgr.updateWithState(state.id, (current) => ({
        substepStates: (current.substepStates ?? []).map((entry) =>
          entry.delegation?.tokenHash === first.tokenHash
            ? {
                ...entry,
                status: 'done',
                result: 'fail',
                delegation: { ...entry.delegation, childRunId },
              }
            : entry,
        ),
      }));
      const linkedParent = await mgr.load(state.id);
      if (linkedParent === null) throw new Error('expected linked parent');
      await mgr.save({
        ...linkedParent,
        resolvedCompletions: {
          [completionKey]: buildResolvedCompletion({
            agentId: 'delegation',
            result: 'fail',
            targetStep: '1',
            targetSubstep: '1',
            targetFrame: activeFrame(buildFrameKey('1'), 1),
            completedAt: '2026-07-05T00:00:00.000Z',
          }),
        },
      });
      await mgr.save(
        baseState({
          id: childRunId,
          lifecycle: 'completed',
          parentLinkage: {
            kind: 'delegation',
            parentRunId: state.id,
            parentStepId: '1',
            parentStep: '1',
            parentFrameKey: buildFrameKey('1'),
            parentEntry: 1,
            tokenHash: assertDelegationTokenHash(first.tokenHash),
          },
        }),
      );
      await issueRunControlClaimFor(childRunId);
      const childClaimId = issuedRunControlClaims.get(childRunId);
      if (childClaimId === undefined) throw new Error('expected child claim');
      const childClaimKey = claimKeyFromBearer(childClaimId);

      // Captured deliberately so the prototype spy can delegate with its runtime instance.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const commit = RunbookStore.prototype.commitOwnedRunSet;
      jest.spyOn(RunbookStore.prototype, 'commitOwnedRunSet').mockImplementation(function (
        this: RunbookStore,
        input,
      ) {
        return commit.call(this, {
          ...input,
          updateSession: (session) => {
            input.updateSession?.(session);
            throw new Error('session projection fault');
          },
        });
      });
      jest.spyOn(actorService, 'createRecoveryActor').mockImplementation(() => {
        throw new InvalidRunbookStateError('simulated process death during retry commit');
      });

      const outcome = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(runId),
        locator: { kind: 'step', step: first.stepId },
      });

      expect(outcome.kind).toBe('aggregate_recovery_required');
      const parent = await mgr.load(state.id);
      expect(parent?.substepStates?.find((entry) => entry.id === '1')?.delegation?.tokenHash).toBe(
        first.tokenHash,
      );
      await expect(
        lifecycleService.getResolvedCompletion(state.id, completionKey),
      ).resolves.not.toBeNull();
      expect((await mgr.loadSession()).claims[childClaimKey]).toBeDefined();
      expect((await mgr.load(childRunId))?.lifecycle).toBe('completed');
    });

    it('releases nothing when the retried substep has no linked child', async () => {
      // The release is guarded on there being a terminal linked child to let go
      // of. A fresh delegation has no child yet, so retrying it must not call
      // releaseRunbook at all — releasing on every retry would hand back a run
      // the seam never linked.
      const { seam: localSeam, deps } = await startSeamOnDelegateStep();
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (first.kind !== 'delegated') throw new Error('expected delegated');
      const releaseSpy = jest.spyOn(deps.sessionService, 'releaseRunbook');

      const outcome = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(runId),
        locator: { kind: 'step', step: first.stepId },
      });

      expect(outcome.kind).toBe('retried');
      expect(releaseSpy).not.toHaveBeenCalled();
    });

    it('leaves the pending outcome intact when the linked-child release is refused', async () => {
      // The retry writes twice: it supersedes the pending outcome, then issues
      // the replacement substep. A refused release between them must not leave
      // the first write committed and the second skipped — the caller is told
      // the retry did not happen, so the outcome it would re-report must still
      // be there. Ordering the guarded release ahead of the supersede is what
      // makes the refusal a no-op rather than a partial mutation.
      const { seam: localSeam, manager: mgr, state } = await startSeamOnDelegateStep();
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (first.kind !== 'delegated') throw new Error('expected delegated');

      const keyForSubstep = (substepId: string) =>
        buildCompletionKey(activeFrame(buildFrameKey('1'), 1), substepId);
      const childRunId = assertRunId('rd_33333333333333333333333333333333');
      await mgr.updateWithState(state.id, (current) => ({
        substepStates: (current.substepStates ?? []).map((entry) =>
          entry.delegation?.tokenHash === first.tokenHash
            ? {
                ...entry,
                status: 'done',
                result: 'fail',
                delegation: { ...entry.delegation, childRunId },
              }
            : entry,
        ),
      }));
      await mgr.save(
        baseState({
          id: childRunId,
          lifecycle: 'completed',
          parentLinkage: {
            kind: 'delegation',
            parentRunId: state.id,
            parentStepId: '1',
            parentStep: '1',
            parentFrameKey: buildFrameKey('1'),
            parentEntry: 1,
            tokenHash: assertDelegationTokenHash(first.tokenHash),
          },
        }),
      );
      await issueRunControlClaimFor(childRunId);
      const parentWithLinkedChild = await mgr.load(state.id);
      if (!parentWithLinkedChild) throw new Error('expected persisted parent');
      await mgr.save({
        ...parentWithLinkedChild,
        resolvedCompletions: {
          [keyForSubstep('1')]: buildResolvedCompletion({
            agentId: 'delegation',
            result: 'fail',
            targetStep: '1',
            targetSubstep: '1',
            targetFrame: activeFrame(buildFrameKey('1'), 1),
            completedAt: '2026-07-05T00:00:00.000Z',
          }),
        },
      });
      await ownRunForTest(tmp, childRunId);

      const outcome = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(runId),
        locator: { kind: 'step', step: first.stepId },
      });

      expect(outcome).toEqual({
        kind: 'execution_in_progress',
        runId: childRunId,
        message: `Run ${childRunId} has an execution in progress.`,
      });
      // The supersede is the write that must not have happened.
      await expect(
        lifecycleService.getResolvedCompletion(state.id, keyForSubstep('1')),
      ).resolves.not.toBeNull();
    });

    it('continues to refuse retry over a running linked child', async () => {
      const { seam: localSeam, manager: mgr, state } = await startSeamOnDelegateStep();
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (first.kind !== 'delegated') throw new Error('expected delegated');

      const childRunId = assertRunId('rd_44444444444444444444444444444444');
      await mgr.updateWithState(state.id, (current) => ({
        substepStates: (current.substepStates ?? []).map((entry) =>
          entry.delegation?.tokenHash === first.tokenHash
            ? { ...entry, delegation: { ...entry.delegation, childRunId } }
            : entry,
        ),
      }));
      await mgr.save(baseState({ id: childRunId, lifecycle: 'running' }));

      const outcome = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(runId),
        locator: { kind: 'step', step: first.stepId },
      });

      expect(outcome.kind).toBe('error');
      if (outcome.kind !== 'error') throw new Error('expected error');
      expect(outcome.error.code).toBe('RD-823');
    });

    it('continues to refuse retry when the linked child state is missing', async () => {
      const { seam: localSeam, deps, manager: mgr, state } = await startSeamOnDelegateStep();
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (first.kind !== 'delegated') throw new Error('expected delegated');

      const childRunId = assertRunId('rd_55555555555555555555555555555555');
      const releaseSpy = jest.spyOn(deps.sessionService, 'releaseRunbook');
      await mgr.updateWithState(state.id, (current) => ({
        substepStates: (current.substepStates ?? []).map((entry) =>
          entry.delegation?.tokenHash === first.tokenHash
            ? { ...entry, delegation: { ...entry.delegation, childRunId } }
            : entry,
        ),
      }));

      const outcome = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(runId),
        locator: { kind: 'step', step: first.stepId },
      });

      expect(outcome.kind).toBe('error');
      if (outcome.kind !== 'error') throw new Error('expected error');
      expect(outcome.error.code).toBe('RD-823');
      const persisted = await mgr.load(state.id);
      const entry = persisted?.substepStates?.find((substep) => substep.id === '1');
      expect(entry?.delegation?.childRunId).toBe(childRunId);
      expect(entry?.delegation?.tokenHash).toBe(first.tokenHash);
      expect(releaseSpy).not.toHaveBeenCalledWith(childRunId);
    });

    it('preserves the FOR iteration in the active retry label', async () => {
      const { seam: localSeam } = await startSeamOnActiveForIterationSubstep();
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (first.kind !== 'delegated') throw new Error('expected delegated');

      const retried = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(runId),
        locator: { kind: 'active' },
      });
      expect(retried.kind).toBe('retried');
      if (retried.kind !== 'retried') throw new Error('expected retried');
      // Iteration-qualified label, not a bare "1.1".
      expect(retried.stepLabel).toBe('1.2.1');
    });

    it('canonicalizes the step-form retry label to include the FOR iteration', async () => {
      // A `--retry --step 1.1 --index 2` must surface the iteration-qualified
      // label `1.2.1`, matching the token/active retry forms — not the bare
      // `1.1` (which drops the resolved frame's iteration).
      const steps: readonly ResolvedStep[] = [
        delegateForStep('1', [delegateSubstep('1', 'child.md')]),
      ];
      const activeFrameKey = buildFrameKey('1', 1);
      const state = baseState({
        activeFrameKey,
        frameEntryCounts: { [activeFrameKey]: 1 },
        forStack: [
          {
            stepId: '1',
            iteration: 1,
            start: 1,
            end: 2,
            implicit: false,
            source: { kind: 'range' },
          },
        ],
      });
      await activate(state);
      const { seam: localSeam } = buildIssuanceSeam(state, steps);

      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
        explicitTarget: { stepId: '1.1', iteration: 2 },
      });
      if (first.kind !== 'delegated') throw new Error('expected delegated');

      const retried = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(runId),
        locator: { kind: 'step', step: '1.1', iteration: 2 },
      });
      expect(retried.kind).toBe('retried');
      if (retried.kind !== 'retried') throw new Error('expected retried');
      expect(retried.stepLabel).toBe('1.2.1');
    });

    it('retries by token across runs', async () => {
      const { seam: localSeam } = await startSeamOnDelegateStep();
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (first.kind !== 'delegated') throw new Error('expected delegated');
      const retried = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(runId),
        locator: { kind: 'token', token: first.token },
      });
      expect(retried.kind).toBe('retried');
    });

    it('accepts a token retry whose --run matches the token-owning run', async () => {
      const { seam: localSeam } = await startSeamOnDelegateStep();
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (first.kind !== 'delegated') throw new Error('expected delegated');

      const retried = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(runId),
        targetRunId: first.parentRunId,
        locator: { kind: 'token', token: first.token },
      });
      expect(retried.kind).toBe('retried');
    });

    it('refuses a token retry whose --run names a different run than the token owner (fail-closed)', async () => {
      // An explicit `--run` is named authority over a specific run; a token
      // owned by a DIFFERENT run must refuse rather than silently discard the
      // named target — and the refusal must not echo the actual owning run id
      // (accident barrier).
      const { seam: localSeam } = await startSeamOnDelegateStep();
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (first.kind !== 'delegated') throw new Error('expected delegated');
      const otherRunId = assertRunId('rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
      await activate(baseState({ id: otherRunId }));

      const outcome = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(otherRunId),
        targetRunId: otherRunId,
        locator: { kind: 'token', token: first.token },
      });

      expect(outcome.kind).toBe('run_target_mismatch');
      if (outcome.kind !== 'run_target_mismatch') throw new Error('expected mismatch');
      expect(outcome.runId).toBe(otherRunId);
      // The message never leaks the token's actual owning run id.
      expect(outcome.message).not.toContain(first.parentRunId);
      // No re-mint happened: the persisted delegation still carries the
      // original token hash.
      const persisted = await manager.load(first.parentRunId);
      const entry = findSubstepState(persisted?.substepStates ?? [], '1', buildFrameKey('1'));
      expect(entry?.delegation?.tokenHash).toBe(first.tokenHash);
    });

    it('rejects a token retry whose snapshot is missing `at` (fail closed, no legacy reconstruction)', async () => {
      // A persisted context snapshot ALWAYS records `at` (buildContextSnapshot
      // derives it unconditionally via deriveExecutionAt). A snapshot missing
      // `at` is an incompatible/older persisted shape; per the no-migration rule
      // the retry must fail closed (RD-817) rather than reconstruct a `1.x`
      // label from `substep`/`stepId`.
      const { seam: localSeam, deps } = await startSeamOnDelegateStep();
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (first.kind !== 'delegated') throw new Error('expected delegated');

      // Resolve the real scan, then strip `at` to emulate an incompatible
      // snapshot. `findDelegationsByTokenHash` is a readonly dep, so swap it by
      // constructing a fresh seam over the same deps rather than mutating.
      const realScan = await new DelegationScanService(manager).findByToken(first.token);
      if (!realScan) throw new Error('expected scan');
      const { at: _at, ...snapshotWithoutAt } = realScan.delegation.contextSnapshot;
      const localSeamStale = new RunbookLifecycleCommandService({
        ...deps,
        findDelegationsByTokenHash: async () => ({
          current: {
            ...realScan,
            delegation: { ...realScan.delegation, contextSnapshot: snapshotWithoutAt },
          },
          superseding: [],
        }),
      });

      const outcome = await localSeamStale.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(runId),
        locator: { kind: 'token', token: first.token },
      });

      expect(outcome.kind).toBe('error');
      if (outcome.kind !== 'error') throw new Error('expected error');
      expect(outcome.error.code).toBe('RD-817');
    });

    it('surfaces the canonical snapshot `at` as the token-retry label (FOR iteration)', async () => {
      // A token retry whose snapshot records `at` = "1.2.1" (a FOR iteration)
      // must surface that canonical label, not the bare step.
      const steps: readonly ResolvedStep[] = [
        delegateForStep('1', [delegateSubstep('1', 'child.md')]),
      ];
      const activeFrameKey = buildFrameKey('1', 1);
      const state = baseState({
        activeFrameKey,
        frameEntryCounts: { [activeFrameKey]: 1 },
        forStack: [
          {
            stepId: '1',
            iteration: 1,
            start: 1,
            end: 2,
            implicit: false,
            source: { kind: 'range' },
          },
        ],
      });
      await activate(state);
      const { seam: localSeam } = buildIssuanceSeam(state, steps);

      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
        explicitTarget: { stepId: '1.1', iteration: 2 },
      });
      if (first.kind !== 'delegated') throw new Error('expected delegated');

      const retried = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(runId),
        locator: { kind: 'token', token: first.token },
      });
      expect(retried.kind).toBe('retried');
      if (retried.kind !== 'retried') throw new Error('expected retried');
      expect(retried.stepLabel).toBe('1.2.1');
    });

    it('returns token-not-found for an unknown token', async () => {
      const { seam: localSeam } = await startSeamOnDelegateStep();
      const outcome = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(runId),
        locator: { kind: 'token', token: 'rdtk_unknown00000000000000000000000000' },
      });
      expect(outcome.kind).toBe('token-not-found');
    });

    it('token retry targets the scan-resolved parent run, not the (different) active run', async () => {
      // Issue a delegation, then activate a SECOND run on top so `getActive()`
      // resolves to the new run. A token retry must resolve its target from the
      // scan result's parent (the issuing run) — exercising the `scan.parentState`
      // branch rather than `getActive()`.
      const { seam: localSeam, state: issuingRun } = await startSeamOnDelegateStep();
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (first.kind !== 'delegated') throw new Error('expected delegated');

      // Activate an unrelated second run so it shadows the issuing run as active.
      const secondRunId = assertRunId('rd_55555555555555555555555555555555');
      await manager.save(
        baseState({
          id: secondRunId,
          runbook: { source: 'project', path: 'other.md' },
          runbookPath: 'other.md',
        }),
      );
      await sessionService.pushRunbook(secondRunId);
      expect((await sessionService.getActive())?.id).toBe(secondRunId);

      const retried = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(runId),
        locator: { kind: 'token', token: first.token },
      });

      expect(retried.kind).toBe('retried');
      if (retried.kind !== 'retried') throw new Error('expected retried');
      // The retry committed against the issuing run, not the active second run.
      expect(retried.parentRunId).toBe(issuingRun.id);
      expect(retried.parentRunId).not.toBe(secondRunId);
      expect(retried.token).not.toBe(first.token);
    });

    it('consumes the pending delegation outcome row for the retried substep', async () => {
      const { seam: localSeam, manager: mgr, state } = await startSeamOnActiveDelegateSubstep();
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (first.kind !== 'delegated') throw new Error('expected delegated');

      // Simulate a reported+aborted attempt: a pending delegation outcome row for
      // the active substep, with the substep mirrored done/fail (as abort --force
      // records).
      const frameKey = buildFrameKey('1');
      const key = buildCompletionKey(activeFrame(frameKey, 1), '1');
      const persisted = await mgr.load(state.id);
      if (!persisted) throw new Error('expected persisted state');
      await mgr.save({
        ...persisted,
        substepStates: (persisted.substepStates ?? []).map((ss) =>
          ss.id === '1' && ss.frameKey === frameKey
            ? { ...ss, status: 'done' as const, result: 'fail' as const }
            : ss,
        ),
        resolvedCompletions: {
          ...(persisted.resolvedCompletions ?? {}),
          [key]: buildResolvedCompletion({
            agentId: 'delegation',
            result: 'fail',
            targetStep: '1',
            targetSubstep: '1',
            targetFrame: activeFrame(frameKey, 1),
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
      });

      const retried = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(runId),
        locator: { kind: 'active' },
      });
      expect(retried.kind).toBe('retried');

      const after = await mgr.load(state.id);
      expect(after?.resolvedCompletions?.[key]).toBeUndefined();
      expect(Object.keys(after?.resolvedCompletions ?? {})).toHaveLength(0);
    });

    it('supersedes only the delegation outcome authored for the retried substep on its own frame', async () => {
      // The supersession filter is a three-way conjunction of "same frame",
      // "same substep" and "authored by delegation". A run carrying exactly one
      // outcome cannot distinguish it from a filter that drops every row, so the
      // two boundary rows below are the observation: a delegation outcome for
      // the SAME substep on a DIFFERENT frame (a sibling FOR iteration), and a
      // MANUAL outcome on the same frame and substep. Neither is the retried
      // delegation's evidence, and consuming either would silently discard a
      // resolved result the operator still owes a collect for.
      const { seam: localSeam, manager: mgr, state } = await startSeamOnActiveDelegateSubstep();
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (first.kind !== 'delegated') throw new Error('expected delegated');

      const retriedFrame = buildFrameKey('1');
      const siblingFrame = buildFrameKey('1', 2);
      const retriedKey = buildCompletionKey(activeFrame(retriedFrame, 1), '1');
      const siblingFrameKey = buildCompletionKey(activeFrame(siblingFrame, 1), '1');
      const manualKey = buildCompletionKey(inactiveFrame(retriedFrame), '1');
      const persisted = await mgr.load(state.id);
      if (!persisted) throw new Error('expected persisted state');
      await mgr.save({
        ...persisted,
        resolvedCompletions: {
          [retriedKey]: buildResolvedCompletion({
            agentId: 'delegation',
            result: 'fail',
            targetStep: '1',
            targetSubstep: '1',
            targetFrame: activeFrame(retriedFrame, 1),
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
          [siblingFrameKey]: buildResolvedCompletion({
            agentId: 'delegation',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '1',
            targetFrame: activeFrame(siblingFrame, 1),
            completedAt: '2026-01-02T00:00:00.000Z',
          }),
          [manualKey]: buildResolvedCompletion({
            agentId: 'manual',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '1',
            targetFrame: inactiveFrame(retriedFrame),
            completedAt: '2026-01-03T00:00:00.000Z',
          }),
        },
      });

      const retried = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(runId),
        locator: { kind: 'active' },
      });
      expect(retried.kind).toBe('retried');

      const after = await mgr.load(state.id);
      // Consumed: the retried substep's own delegation evidence on its own frame.
      expect(after?.resolvedCompletions?.[retriedKey]).toBeUndefined();
      // Retained: a different FOR iteration's delegation outcome for the same substep.
      expect(after?.resolvedCompletions?.[siblingFrameKey]).toEqual(
        expect.objectContaining({ agentId: 'delegation', result: 'pass' }),
      );
      // Retained: a manual completion on the same frame and substep — the retry
      // re-issues a delegation, it does not erase an operator's own result.
      expect(after?.resolvedCompletions?.[manualKey]).toEqual(
        expect.objectContaining({ agentId: 'manual', result: 'pass' }),
      );
    });

    it('validates a retry iteration against the in-fence step reread', async () => {
      // Retry's own `--index` legality check carries the same obligation as the
      // fresh path: the parsed document flips from FOR to substeps as the fence
      // is entered, so only a decision made from `beforeEffect`'s reread of the
      // captured parent can observe it — and the refusal must land before any
      // overrides resolution, machine preparation, or re-mint.
      const forSteps: readonly ResolvedStep[] = [
        delegateForStep('1', [delegateSubstep('1', 'child.md')]),
      ];
      const state = baseState();
      await activate(state);
      const { seam: localSeam, deps, manager: mgr } = buildIssuanceSeam(state, forSteps);
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
        explicitTarget: { stepId: '1.1', iteration: 2 },
      });
      if (first.kind !== 'delegated') throw new Error('expected delegated');

      const prepareSpy = jest.spyOn(
        RunbookActorService.prototype,
        'prepareManualDelegationMutation',
      );
      const resolveOverrides = jest.fn(async () => undefined);
      deps.actorMutationRunner = runnerWithFenceEntryHook(deps.actorMutationRunner, () => {
        deps.loadSteps = () => [delegateStep('1', [delegateSubstep('1', 'child.md')])];
      });

      const outcome = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(runId),
        locator: { kind: 'step', step: '1.1', iteration: 2 },
        resolveOverrides,
      });

      expect(outcome.kind).toBe('invalid_index');
      if (outcome.kind !== 'invalid_index') throw new Error('expected invalid_index');
      expect(outcome.message).toBe(
        '--index requires step "1" to be a FOR step, but it is "substeps"',
      );
      expect(resolveOverrides).not.toHaveBeenCalled();
      expect(prepareSpy).not.toHaveBeenCalled();
      // No re-mint: the delegation still carries the token issued above.
      const persisted = await mgr.load(state.id);
      const entry = findSubstepState(persisted?.substepStates ?? [], '1', buildFrameKey('1', 2));
      expect(entry?.delegation?.tokenHash).toBe(first.tokenHash);
    });

    // Everything a retry decides — which substep on which frame, whether the
    // delegation it scanned is still the one recorded, whether the linked child
    // is still terminal — is re-derived inside the fence from the state the
    // aggregate CAPTURED. The pre-fence read only identifies aggregate members.
    // Each test below commits a concurrent mutation exactly as the fence is
    // entered, which is invisible to any decision hoisted out of `beforeEffect`,
    // so a seam that trusts its advisory read fails here and only here.
    describe('in-fence retry re-resolution', () => {
      /**
       * Prompted-FOR fixture: no `forClause`, so the frame derived from the FOR
       * stack (`1|`) can never equal an `--index` frame (`1|2`) the run is
       * parked on. That disagreement is what makes "read `activeFrameKey`"
       * distinguishable from "derive the frame".
       */
      async function startPromptedForSeam(
        substeps: readonly Substep[],
        overrides: Partial<RunbookState> = {},
      ): Promise<ReturnType<typeof buildIssuanceSeam>> {
        const steps: readonly ResolvedStep[] = [delegatePromptedForStep('1', substeps)];
        const state = baseState(overrides);
        await activate(state);
        return buildIssuanceSeam(state, steps);
      }

      it('re-derives a step-locator frame from the captured active frame', async () => {
        const {
          seam: localSeam,
          deps,
          manager: mgr,
          state,
        } = await startPromptedForSeam([delegateSubstep('1', 'child.md')]);
        const base = await localSeam.issueDelegation({
          mode: 'fresh',
          callerEvidence: runControlEvidence(runId),
        });
        if (base.kind !== 'delegated') throw new Error('expected base delegated');
        const iterated = await localSeam.issueDelegation({
          mode: 'fresh',
          callerEvidence: runControlEvidence(runId),
          explicitTarget: { stepId: '1.1', iteration: 2 },
        });
        if (iterated.kind !== 'delegated') throw new Error('expected iterated delegated');

        // The run moves onto iteration 2 as the fence is entered.
        const iterationFrameKey = buildFrameKey('1', 2);
        deps.actorMutationRunner = runnerWithAsyncFenceEntryHook(
          deps.actorMutationRunner,
          async () => {
            await mgr.updateWithState(state.id, () => ({ activeFrameKey: iterationFrameKey }));
          },
        );

        const retried = await localSeam.issueDelegation({
          mode: 'retry',
          callerEvidence: runControlEvidence(runId),
          locator: { kind: 'step', step: '1.1' },
        });

        expect(retried.kind).toBe('retried');
        if (retried.kind !== 'retried') throw new Error('expected retried');
        const persisted = await mgr.load(state.id);
        // Re-minted on the frame the CAPTURE was parked on...
        expect(
          findSubstepState(persisted?.substepStates ?? [], '1', iterationFrameKey)?.delegation
            ?.tokenHash,
        ).toBe(retried.tokenHash);
        // ...and the frame the advisory pre-fence read named is untouched.
        expect(
          findSubstepState(persisted?.substepStates ?? [], '1', buildFrameKey('1'))?.delegation
            ?.tokenHash,
        ).toBe(base.tokenHash);
      });

      it('re-derives an active-locator cursor from the captured substep and frame', async () => {
        const iterationFrameKey = buildFrameKey('1', 2);
        const {
          seam: localSeam,
          deps,
          manager: mgr,
          state,
        } = await startPromptedForSeam(
          [delegateSubstep('1', 'a.md'), delegateSubstep('2', 'b.md')],
          { substep: '1', activeFrameKey: iterationFrameKey },
        );
        const first = await localSeam.issueDelegation({
          mode: 'fresh',
          callerEvidence: runControlEvidence(runId),
          explicitTarget: { stepId: '1.1', iteration: 2 },
        });
        if (first.kind !== 'delegated') throw new Error('expected first delegated');
        const second = await localSeam.issueDelegation({
          mode: 'fresh',
          callerEvidence: runControlEvidence(runId),
          explicitTarget: { stepId: '1.2', iteration: 2 },
        });
        if (second.kind !== 'delegated') throw new Error('expected second delegated');

        // The operator's cursor advances to the sibling substep as the fence opens.
        deps.actorMutationRunner = runnerWithAsyncFenceEntryHook(
          deps.actorMutationRunner,
          async () => {
            await mgr.updateWithState(state.id, () => ({ substep: '2' }));
          },
        );

        const retried = await localSeam.issueDelegation({
          mode: 'retry',
          callerEvidence: runControlEvidence(runId),
          locator: { kind: 'active' },
        });

        expect(retried.kind).toBe('retried');
        if (retried.kind !== 'retried') throw new Error('expected retried');
        const persisted = await mgr.load(state.id);
        expect(
          findSubstepState(persisted?.substepStates ?? [], '2', iterationFrameKey)?.delegation
            ?.tokenHash,
        ).toBe(retried.tokenHash);
        expect(
          findSubstepState(persisted?.substepStates ?? [], '1', iterationFrameKey)?.delegation
            ?.tokenHash,
        ).toBe(first.tokenHash);
      });

      it('re-runs the policy gate against the captured cursor, not the one it was authorized for', async () => {
        // `retry-delegation` grants may be scoped to a single step. A claim
        // scoped to substep `1` passes the pre-fence gate, but the capture is
        // parked on substep `2` — an authority the caller never held. Only a
        // policy decision re-taken inside the fence, against the exact captured
        // cursor, refuses it.
        const iterationFrameKey = buildFrameKey('1', 2);
        const {
          seam: localSeam,
          deps,
          manager: mgr,
          state,
        } = await startPromptedForSeam(
          [delegateSubstep('1', 'a.md'), delegateSubstep('2', 'b.md')],
          { substep: '1', activeFrameKey: iterationFrameKey },
        );
        const first = await localSeam.issueDelegation({
          mode: 'fresh',
          callerEvidence: runControlEvidence(runId),
          explicitTarget: { stepId: '1.1', iteration: 2 },
        });
        if (first.kind !== 'delegated') throw new Error('expected delegated');
        const evidence = runControlEvidence(runId);
        if (evidence.kind !== 'claim_bearer') throw new Error('expected bearer evidence');
        const claimKey = claimKeyFromBearer(evidence.claimId);
        const session = await mgr.loadSession();
        await patchPersistedClaim(tmp, claimKey, {
          grants: session.claims[claimKey].grants.map((grant) =>
            grant.action === 'retry-delegation' ? { ...grant, stepId: '1' } : grant,
          ),
        });
        deps.actorMutationRunner = runnerWithAsyncFenceEntryHook(
          deps.actorMutationRunner,
          async () => {
            await mgr.updateWithState(state.id, () => ({ substep: '2' }));
          },
        );

        const outcome = await localSeam.issueDelegation({
          mode: 'retry',
          callerEvidence: evidence,
          locator: { kind: 'active' },
        });

        expect(outcome.kind).toBe('refused');
        if (outcome.kind !== 'refused') throw new Error('expected refused');
        expect(outcome.policy.kind).toBe('claim_grant_required');
        expect(
          findSubstepState((await mgr.load(state.id))?.substepStates ?? [], '1', iterationFrameKey)
            ?.delegation?.tokenHash,
        ).toBe(first.tokenHash);
      });

      it('refuses retry_target_required when the captured run has left its substep', async () => {
        const {
          seam: localSeam,
          deps,
          manager: mgr,
          state,
        } = await startSeamOnActiveDelegateSubstep();
        const first = await localSeam.issueDelegation({
          mode: 'fresh',
          callerEvidence: runControlEvidence(runId),
        });
        if (first.kind !== 'delegated') throw new Error('expected delegated');
        deps.actorMutationRunner = runnerWithAsyncFenceEntryHook(
          deps.actorMutationRunner,
          async () => {
            await mgr.updateWithState(state.id, () => ({ substep: undefined }));
          },
        );

        const outcome = await localSeam.issueDelegation({
          mode: 'retry',
          callerEvidence: runControlEvidence(runId),
          locator: { kind: 'active' },
        });

        expect(outcome).toEqual({ kind: 'retry_target_required' });
        // No re-mint: the pre-fence cursor was valid, so only the capture can refuse.
        expect(
          findSubstepState((await mgr.load(state.id))?.substepStates ?? [], '1', buildFrameKey('1'))
            ?.delegation?.tokenHash,
        ).toBe(first.tokenHash);
      });

      it('refuses RD-823 when the captured delegation links a child the scan never saw', async () => {
        const { seam: localSeam, deps, manager: mgr, state } = await startSeamOnDelegateStep();
        const first = await localSeam.issueDelegation({
          mode: 'fresh',
          callerEvidence: runControlEvidence(runId),
        });
        if (first.kind !== 'delegated') throw new Error('expected delegated');
        const racingChildRunId = assertRunId('rd_ba0a0000000000000000000000000000');
        deps.actorMutationRunner = runnerWithAsyncFenceEntryHook(
          deps.actorMutationRunner,
          async () => {
            await mgr.updateWithState(state.id, (current) => ({
              substepStates: (current.substepStates ?? []).map((entry) =>
                entry.delegation
                  ? { ...entry, delegation: { ...entry.delegation, childRunId: racingChildRunId } }
                  : entry,
              ),
            }));
          },
        );

        const outcome = await localSeam.issueDelegation({
          mode: 'retry',
          callerEvidence: runControlEvidence(runId),
          locator: { kind: 'step', step: first.stepId },
        });

        expect(outcome.kind).toBe('error');
        if (outcome.kind !== 'error') throw new Error('expected error');
        expect(outcome.error.code).toBe('RD-823');
        // The racing link survives — a retry that lost the race writes nothing.
        const delegation = findSubstepState(
          (await mgr.load(state.id))?.substepStates ?? [],
          '1',
          buildFrameKey('1'),
        )?.delegation;
        expect(delegation?.childRunId).toBe(racingChildRunId);
        expect(delegation?.tokenHash).toBe(first.tokenHash);
      });

      it('refuses RD-823 when the linked child is no longer terminal at capture', async () => {
        const { seam: localSeam, deps, manager: mgr, state } = await startSeamOnDelegateStep();
        const first = await localSeam.issueDelegation({
          mode: 'fresh',
          callerEvidence: runControlEvidence(runId),
        });
        if (first.kind !== 'delegated') throw new Error('expected delegated');
        const childRunId = assertRunId('rd_ba0b0000000000000000000000000000');
        await mgr.updateWithState(state.id, (current) => ({
          substepStates: (current.substepStates ?? []).map((entry) =>
            entry.delegation
              ? { ...entry, delegation: { ...entry.delegation, childRunId } }
              : entry,
          ),
        }));
        await mgr.save(
          baseState({
            id: childRunId,
            runbookPath: 'child.md',
            lifecycle: 'stopped',
            parentLinkage: linkageFor(state.id, '1'),
          }),
        );
        // A controlling claim keeps the child a REQUIRED aggregate member; without
        // one it is dropped as superseded (pinned separately below).
        await issueRunControlClaimFor(childRunId);
        // The child restarts between the pre-fence terminal-state read and the capture.
        deps.actorMutationRunner = runnerWithAsyncFenceEntryHook(
          deps.actorMutationRunner,
          async () => {
            await mgr.updateWithState(childRunId, () => ({ lifecycle: 'running' }));
          },
        );

        const outcome = await localSeam.issueDelegation({
          mode: 'retry',
          callerEvidence: runControlEvidence(runId),
          locator: { kind: 'step', step: first.stepId },
        });

        expect(outcome.kind).toBe('error');
        if (outcome.kind !== 'error') throw new Error('expected error');
        expect(outcome.error.code).toBe('RD-823');
        expect(
          findSubstepState((await mgr.load(state.id))?.substepStates ?? [], '1', buildFrameKey('1'))
            ?.delegation?.tokenHash,
        ).toBe(first.tokenHash);
      });
    });

    it("resolves a named step's own frame, so the machine refuses it as off-frontier", async () => {
      // `--step 1.1` after the run advanced to step 2 must resolve substep `1` on
      // step 1's OWN frame (`1|`) and hand THAT to the machine, which refuses it
      // RD-802 because the frontier has moved on. Resolving the cursor's frame
      // (`2|`) instead would look up a substep that frame never had and surface
      // some other failure — the operator would be told the wrong thing.
      const steps: readonly ResolvedStep[] = [
        delegateStep('1', [delegateSubstep('1', 'a.md')]),
        delegateStep('2', [delegateSubstep('1', 'b.md')]),
      ];
      const state = baseState();
      await activate(state);
      const { seam: localSeam, manager: mgr } = buildIssuanceSeam(state, steps);
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (first.kind !== 'delegated') throw new Error('expected delegated');
      await mgr.updateWithState(state.id, () => ({
        step: '2',
        activeFrameKey: buildFrameKey('2'),
        frameEntryCounts: replace({ [buildFrameKey('1')]: 1, [buildFrameKey('2')]: 1 }),
      }));

      const outcome = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(runId),
        locator: { kind: 'step', step: '1.1' },
      });

      expect(outcome.kind).toBe('error');
      if (outcome.kind !== 'error') throw new Error('expected error');
      expect(outcome.error.code).toBe('RD-802');
      expect(outcome.error.context).toEqual(expect.objectContaining({ step: '1', current: '2' }));
      expect(
        findSubstepState((await mgr.load(state.id))?.substepStates ?? [], '1', buildFrameKey('1'))
          ?.delegation?.tokenHash,
      ).toBe(first.tokenHash);
    });

    it('drops a linked terminal child that no longer has a controlling claim', async () => {
      // The child target is opportunistic: a terminal child whose claim is gone
      // has nothing left to release, so the retry proceeds without it. Making it
      // a required member would strand every delegation whose child was pruned
      // of its claim.
      const { seam: localSeam, manager: mgr, state } = await startSeamOnDelegateStep();
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (first.kind !== 'delegated') throw new Error('expected delegated');
      const childRunId = assertRunId('rd_ba0c0000000000000000000000000000');
      await mgr.updateWithState(state.id, (current) => ({
        substepStates: (current.substepStates ?? []).map((entry) =>
          entry.delegation ? { ...entry, delegation: { ...entry.delegation, childRunId } } : entry,
        ),
      }));
      await mgr.save(
        baseState({
          id: childRunId,
          runbookPath: 'child.md',
          lifecycle: 'stopped',
          parentLinkage: linkageFor(state.id, '1'),
        }),
      );

      const retried = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(runId),
        locator: { kind: 'step', step: first.stepId },
      });

      expect(retried.kind).toBe('retried');
      if (retried.kind !== 'retried') throw new Error('expected retried');
      expect(retried.tokenHash).not.toBe(first.tokenHash);
    });

    it('re-mints the named substep, not the step it belongs to', async () => {
      // `--step 2.1` names substep `1` of step `2`. Collapsing the parsed pair to
      // the step name would re-mint substep `2` instead — a sibling delegation
      // the operator never asked to replace.
      const { seam: localSeam, manager: mgr, state } = await startSeamOnMultiStepRunbook();
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
        explicitTarget: { stepId: '2.1' },
      });
      if (first.kind !== 'delegated') throw new Error('expected first delegated');
      const second = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
        explicitTarget: { stepId: '2.2' },
      });
      if (second.kind !== 'delegated') throw new Error('expected second delegated');

      const retried = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(runId),
        locator: { kind: 'step', step: '2.1' },
      });

      expect(retried.kind).toBe('retried');
      if (retried.kind !== 'retried') throw new Error('expected retried');
      const persisted = await mgr.load(state.id);
      const frameKey = buildFrameKey('2');
      expect(
        findSubstepState(persisted?.substepStates ?? [], '1', frameKey)?.delegation?.tokenHash,
      ).toBe(retried.tokenHash);
      expect(
        findSubstepState(persisted?.substepStates ?? [], '2', frameKey)?.delegation?.tokenHash,
      ).toBe(second.tokenHash);
    });

    it('forwards resolved overrides into the re-minted delegation', async () => {
      // Overrides are the retry's whole reason to take a thunk: dropping them
      // still mints a fresh token, so the value has to be observed where the
      // replacement child will read it. Unspecified keys inherit verbatim.
      const { seam: localSeam, manager: mgr, state } = await startSeamOnDelegateStep();
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
        resolveExtraVars: async () => ({ environment: 'staging', region: 'ap' }) as const,
      });
      if (first.kind !== 'delegated') throw new Error('expected delegated');

      const retried = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(runId),
        locator: { kind: 'step', step: first.stepId },
        resolveOverrides: async () => ({ environment: 'production' }) as const,
      });

      expect(retried.kind).toBe('retried');
      const delegation = findSubstepState(
        (await mgr.load(state.id))?.substepStates ?? [],
        '1',
        buildFrameKey('1'),
      )?.delegation;
      expect(delegation?.extraVars).toEqual({ environment: 'production', region: 'ap' });
      expect(delegation?.contextSnapshot.vars).toEqual(
        expect.objectContaining({ environment: 'production', region: 'ap' }),
      );
    });

    // Mirrors the fresh-issuance mapping: the machine is an independent second
    // gate whose refusals the retry must surface verbatim, and whose unmodelled
    // statuses it must refuse to commit.
    describe('machine preparation refusals', () => {
      it.each([['error'], ['child_in_flight']] as const)(
        'maps a %s retry preparation status to the machine error verbatim',
        async (status) => {
          const { seam: localSeam, manager: mgr, state } = await startSeamOnDelegateStep();
          const first = await localSeam.issueDelegation({
            mode: 'fresh',
            callerEvidence: runControlEvidence(runId),
          });
          if (first.kind !== 'delegated') throw new Error('expected delegated');
          const refusal = Errors.delegationInFlight('1', 'rd_dddddddddddddddddddddddddddddddd');
          jest
            .spyOn(RunbookActorService.prototype, 'prepareManualDelegationMutation')
            .mockResolvedValue(
              status === 'error'
                ? { status: 'error', error: refusal }
                : {
                    status: 'child_in_flight',
                    childRunId: assertRunId('rd_dddddddddddddddddddddddddddddddd'),
                    error: refusal,
                  },
            );

          const outcome = await localSeam.issueDelegation({
            mode: 'retry',
            callerEvidence: runControlEvidence(runId),
            locator: { kind: 'step', step: first.stepId },
          });

          expect(outcome.kind).toBe('error');
          if (outcome.kind !== 'error') throw new Error('expected error');
          expect(outcome.error).toBe(refusal);
          expect(
            findSubstepState(
              (await mgr.load(state.id))?.substepStates ?? [],
              '1',
              buildFrameKey('1'),
            )?.delegation?.tokenHash,
          ).toBe(first.tokenHash);
        },
      );

      it('throws rather than re-minting when retry preparation returns an unmodelled status', async () => {
        const { seam: localSeam, manager: mgr, state } = await startSeamOnDelegateStep();
        const first = await localSeam.issueDelegation({
          mode: 'fresh',
          callerEvidence: runControlEvidence(runId),
        });
        if (first.kind !== 'delegated') throw new Error('expected delegated');
        jest
          .spyOn(RunbookActorService.prototype, 'prepareManualDelegationMutation')
          .mockResolvedValue({ status: 'already_cancelled' });

        await expect(
          localSeam.issueDelegation({
            mode: 'retry',
            callerEvidence: runControlEvidence(runId),
            locator: { kind: 'step', step: first.stepId },
          }),
        ).rejects.toThrow('Retry preparation returned already_cancelled');
        expect(
          findSubstepState((await mgr.load(state.id))?.substepStates ?? [], '1', buildFrameKey('1'))
            ?.delegation?.tokenHash,
        ).toBe(first.tokenHash);
      });
    });

    it('rehydrates the interrupted retry member from its own captured steps', async () => {
      const { seam: localSeam, state } = await startSeamOnDelegateStep();
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (first.kind !== 'delegated') throw new Error('expected delegated');
      jest
        .spyOn(RunbookStore.prototype, 'commitOwnedRunSet')
        .mockRejectedValue(new Error('crash before durable commit'));
      const recoverySpy = jest.spyOn(actorService, 'createRecoveryActor').mockImplementation(() => {
        throw new InvalidRunbookStateError('recovery actor unavailable');
      });

      const outcome = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(runId),
        locator: { kind: 'step', step: first.stepId },
      });

      expect(outcome.kind).toBe('aggregate_recovery_required');
      expect(recoverySpy).toHaveBeenCalledTimes(1);
      expect(recoverySpy.mock.calls[0]?.[0].id).toBe(state.id);
    });

    it('surfaces a typed error when the retried substep carries no delegation', async () => {
      // A substep state can exist without a delegation (a manual completion
      // records one). Reaching into `.delegation.childRunId` unguarded would
      // turn that into a TypeError escaping a seam whose contract is typed data.
      const { seam: localSeam, manager: mgr, state } = await startSeamOnMultiStepRunbook();
      await mgr.updateWithState(state.id, () => ({
        substepStates: [{ id: '1', frameKey: buildFrameKey('2'), status: 'done', result: 'pass' }],
      }));

      const outcome = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(runId),
        locator: { kind: 'step', step: '2.1' },
      });

      expect(outcome.kind).toBe('error');
    });

    it('defers an unparsable indexed retry target to the delegation error contract', async () => {
      const { seam: localSeam } = await startSeamOnDelegateStep();

      const outcome = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(runId),
        locator: { kind: 'step', step: 'not-a-step', iteration: 2 },
      });

      expect(outcome.kind).toBe('error');
      // Without the code, any error — including an unrelated throw — satisfies
      // this test; the point is that the delegation resolver retains ownership
      // of RD-801 (step not found) for the unparsable `--step` target, rather
      // than the index guard dereferencing a null parse.
      if (outcome.kind !== 'error') throw new Error('expected error');
      expect(outcome.error.code).toBe('RD-801');
    });

    // --- retry idempotency (#681) -------------------------------------------
    //
    // RD-826/827/828 and the echo's own bearer-verification arm are decided
    // HERE, in the seam's in-fence capture. `resolveRetryIssuance` is pinned
    // exhaustively in delegation-inference.test.ts; what these add is the
    // wiring the resolver cannot see — that the seam tags each superseding row
    // with the run/substep/frame it actually came from, anchors the capture on
    // the cursor the retry resolved to, and routes each variant to its own
    // typed refusal without putting a bearer on the wire.

    /**
     * Read the delegation persisted at `(substepId, frame "1")` of a run.
     *
     * @param id - Run to read.
     * @param substepId - Substep row id.
     * @returns The persisted delegation.
     * @throws {Error} when no delegation is recorded there.
     */
    async function delegationAt(id: RunId, substepId: string): Promise<StepDelegation> {
      const persisted = await manager.load(id);
      const found = findSubstepState(persisted?.substepStates ?? [], substepId, buildFrameKey('1'));
      if (!found?.delegation) throw new Error(`no delegation persisted at substep ${substepId}`);
      return found.delegation;
    }

    /**
     * Overwrite the delegation persisted at `(substepId, frame "1")`.
     *
     * @param id - Run to mutate.
     * @param substepId - Substep row id.
     * @param delegation - Delegation to record there.
     */
    async function putDelegation(
      id: RunId,
      substepId: string,
      delegation: StepDelegation,
    ): Promise<void> {
      await manager.updateWithState(id, (fresh) => ({
        substepStates: (fresh.substepStates ?? []).map((row) =>
          row.id === substepId && row.frameKey === buildFrameKey('1')
            ? { ...row, delegation }
            : row,
        ),
      }));
    }

    /**
     * Re-stamp a real delegation as superseding `hash`.
     *
     * `supersedesTokenHash` is excluded from the credential HMAC input (#681),
     * so the re-stamped row still derives back to its own bearer and clears
     * `verifyDerivedBearer`. That matters: these fixtures must leave the echo
     * arm REACHABLE, or they would prove only that some unrelated refusal fires
     * first.
     *
     * @param delegation - A genuinely issued delegation.
     * @param hash - Bearer hash to record as superseded.
     * @returns The re-stamped delegation.
     */
    const supersede = (delegation: StepDelegation, hash: DelegationTokenHash): StepDelegation => ({
      ...delegation,
      credential: { ...delegation.credential, supersedesTokenHash: hash },
    });

    /**
     * A supersession-index row, as the bearer lookup's `superseding` half returns it.
     *
     * @param parentState - State the row is reported against (only `id` is read).
     * @param substepId - Substep row id the scan reports.
     * @param delegation - The superseding delegation.
     * @returns The scan row.
     */
    const scanRow = (
      parentState: RunbookState,
      substepId: string,
      delegation: StepDelegation,
    ): TokenScanResult => ({
      parentState,
      stepId: '1',
      substepId,
      frameKey: buildFrameKey('1'),
      delegation,
    });

    /**
     * Override only the supersession half of the merged bearer lookup, leaving
     * the real scan to answer `current`.
     *
     * The two lookups used to be separate dependencies, so a test could swap the
     * supersession index alone. They are one dependency now — answered from one
     * state listing — so preserving that reach means delegating `current` back to
     * the real scanner rather than stubbing it to `undefined`, which would change
     * what each test is actually exercising.
     *
     * @param rows - Supersession-index rows to report.
     * @returns A lookup wired for the seam's `findDelegationsByTokenHash` dep.
     */
    const supersedingIndex =
      (
        rows: readonly TokenScanResult[],
      ): RunbookLifecycleCommandServiceDependencies['findDelegationsByTokenHash'] =>
      async (tokenHash) => ({
        current: (await new DelegationScanService(manager).scanByTokenHash(tokenHash)).current,
        superseding: rows,
      });

    /**
     * Issue two real delegations in frame `1` and vacate `1.1`'s bearer.
     *
     * Leaves `1.1` holding `1.2`'s delegation, so the named bearer `first.token`
     * is no longer current anywhere (the token scan misses, as it does after any
     * real rotation) and nothing on disk records it as superseded. Each fixture
     * below then re-introduces exactly one superseding row, at exactly the
     * coordinate it wants to test.
     *
     * @returns The seam, its mutable deps, the first issuance, and `1.2`'s
     *   delegation (a second real, issuer-derivable credential).
     */
    async function seamWithVacatedBearer(): Promise<{
      localSeam: RunbookLifecycleCommandService;
      deps: ReturnType<typeof buildIssuanceSeam>['deps'];
      first: Extract<Awaited<ReturnType<typeof seam.issueDelegation>>, { kind: 'delegated' }>;
      other: StepDelegation;
      persisted: RunbookState;
    }> {
      const { seam: localSeam, deps, state } = await startSeamOnTwoDelegateSubsteps();
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
        explicitTarget: { stepId: '1.1' },
      });
      if (first.kind !== 'delegated') throw new Error('expected 1.1 delegated');
      const second = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
        explicitTarget: { stepId: '1.2' },
      });
      if (second.kind !== 'delegated') throw new Error('expected 1.2 delegated');

      const other = await delegationAt(state.id, '2');
      await putDelegation(state.id, '1', other);
      const persisted = await manager.load(state.id);
      if (!persisted) throw new Error('expected persisted parent');
      return { localSeam, deps, first, other, persisted };
    }

    it('refuses RD-827 when the only superseding row belongs to another run', async () => {
      // `foreignSuperseding` deliberately admits rows from other runs so
      // cross-run ambiguity stays visible. With exactly one such row the judge
      // would otherwise compare a credential minted in ANOTHER run against THIS
      // run's frame entry and echo it labelled with this run's id and step —
      // the row is shaped so every judge arm resolves rather than refuses
      // (unclaimed, uncancelled, stamped at this frame's entry).
      const { localSeam, deps, first, other, persisted } = await seamWithVacatedBearer();
      const foreignRunId = assertRunId('rd_cccccccccccccccccccccccccccccccc');
      const superseding = supersede(other, assertDelegationTokenHash(first.tokenHash));
      deps.findDelegationsByTokenHash = supersedingIndex([
        scanRow(persisted, '1', superseding),
        scanRow({ ...persisted, id: foreignRunId }, '1', superseding),
      ]);

      const outcome = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(runId),
        locator: { kind: 'token', token: first.token },
      });

      expect(outcome.kind).toBe('error');
      if (outcome.kind !== 'error') throw new Error('expected a typed refusal');
      expect(outcome.error.code).toBe('RD-827');
      const serialized = JSON.stringify(outcome);
      expect(serialized).not.toContain(first.token);
      expect(serialized).not.toContain(TOKEN_PREFIX);
      expect(serialized).not.toContain(foreignRunId);
    });

    it('refuses RD-827 when the only superseding row sits on another substep', async () => {
      // The same-run half of the same defect: the capture collects superseding
      // rows across EVERY substep of the parent, so a replacement recorded at
      // 1.2 would be echoed under 1.1's step label. Delegation rows are keyed
      // `(id, frameKey)`, so 1.2's row is a different row with its own history.
      const { localSeam, deps, first, other, persisted } = await seamWithVacatedBearer();
      const superseding = supersede(other, assertDelegationTokenHash(first.tokenHash));
      await putDelegation(persisted.id, '2', superseding);
      // The index names 1.1 — the coordinate the retry resolves to — while the
      // only row that actually records the bearer lives at 1.2.
      deps.findDelegationsByTokenHash = supersedingIndex([scanRow(persisted, '1', superseding)]);

      const outcome = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(runId),
        locator: { kind: 'token', token: first.token },
      });

      expect(outcome.kind).toBe('error');
      if (outcome.kind !== 'error') throw new Error('expected a typed refusal');
      expect(outcome.error.code).toBe('RD-827');
    });

    it('refuses RD-827 when the named bearer matches neither the current row nor anything superseding it', async () => {
      // Resolver row 7 through the seam: the index located a run, but the
      // in-fence capture holds no row recording the bearer and the current row
      // is a different attempt entirely. Refuse rather than re-mint against an
      // identity the parent does not recognise.
      const { localSeam, deps, first, other, persisted } = await seamWithVacatedBearer();
      deps.findDelegationsByTokenHash = supersedingIndex([
        scanRow(persisted, '1', supersede(other, assertDelegationTokenHash(first.tokenHash))),
      ]);

      const outcome = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(runId),
        locator: { kind: 'token', token: first.token },
      });

      expect(outcome.kind).toBe('error');
      if (outcome.kind !== 'error') throw new Error('expected a typed refusal');
      expect(outcome.error.code).toBe('RD-827');
    });

    it('refuses RD-828 when two captured rows record the named bearer as superseded', async () => {
      // Unreachable by construction — `retryDelegation` writes the replacement
      // at the same coordinate as the bearer it supersedes, so at most one row
      // can record any given bearer. Refused as data rather than resolved: with
      // two candidates there is no single replacement to echo, and picking one
      // would hand out a bearer chosen arbitrarily.
      const { localSeam, first, other, persisted } = await seamWithVacatedBearer();
      const superseding = supersede(other, assertDelegationTokenHash(first.tokenHash));
      await putDelegation(persisted.id, '1', superseding);
      await putDelegation(persisted.id, '2', superseding);

      const outcome = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(runId),
        locator: { kind: 'token', token: first.token },
      });

      expect(outcome.kind).toBe('error');
      if (outcome.kind !== 'error') throw new Error('expected a typed refusal');
      expect(outcome.error.code).toBe('RD-828');
      const serialized = JSON.stringify(outcome);
      expect(serialized).not.toContain(first.token);
      expect(serialized).not.toContain(TOKEN_PREFIX);
    });

    it('refuses RD-821 rather than echoing a replacement the replaying claim cannot re-derive', async () => {
      // The echo arm derives the surviving bearer from its persisted descriptor
      // under the PRESENTING claim. A rotated run-control claim is authorized
      // for the run but did not issue that credential, so derivation cannot
      // succeed — and must surface as a typed refusal carrying no `token`,
      // exactly as the fresh echo does.
      const { seam: localSeam } = await startSeamOnDelegateStep();
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (first.kind !== 'delegated') throw new Error('expected delegated');
      const retried = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(runId),
        locator: { kind: 'step', step: first.stepId },
      });
      if (retried.kind !== 'retried') throw new Error('expected retried');

      await issueRunControlClaimFor(runId);

      const replay = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(runId),
        locator: { kind: 'step', step: first.stepId },
      });

      expect(replay.kind).toBe('error');
      if (replay.kind !== 'error') throw new Error('expected a typed refusal');
      expect(replay.error.code).toBe('RD-821');
      expect(replay).not.toHaveProperty('token');
      const serialized = JSON.stringify(replay);
      expect(serialized).not.toContain(retried.token);
      expect(serialized).not.toContain(first.token);
      expect(serialized).not.toContain(TOKEN_PREFIX);
      expect(serialized).not.toContain(DELEGATION_CLAIM_MARKER);
      // Refusing is not rotating: the replacement is still the persisted row.
      const persisted = await manager.load(runId);
      const entry = findSubstepState(persisted?.substepStates ?? [], '1', buildFrameKey('1'));
      expect(entry?.delegation?.tokenHash).toBe(retried.tokenHash);
    });

    it('refuses a --run that does not own a SUPERSEDED token, without naming the owning run', async () => {
      // `--run` is resolved against `scan ?? supersedingScan.at(0)`, so a
      // superseded bearer reaches the mismatch guard through the supersession
      // index — a path the current-token `--run` tests predate. The refusal
      // still echoes only the caller-supplied id.
      const { seam: localSeam } = await startSeamOnDelegateStep();
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (first.kind !== 'delegated') throw new Error('expected delegated');
      const retried = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(runId),
        locator: { kind: 'step', step: first.stepId },
      });
      if (retried.kind !== 'retried') throw new Error('expected retried');

      const otherRunId = assertRunId('rd_dddddddddddddddddddddddddddddddd');
      await activate(baseState({ id: otherRunId }));

      const outcome = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(otherRunId),
        targetRunId: otherRunId,
        locator: { kind: 'token', token: first.token },
      });

      expect(outcome.kind).toBe('run_target_mismatch');
      if (outcome.kind !== 'run_target_mismatch') throw new Error('expected mismatch');
      expect(outcome.runId).toBe(otherRunId);
      expect(outcome.message).not.toContain(first.parentRunId);
      expect(outcome.message).not.toContain(first.token);
      // No re-mint: the replacement the retry already committed is untouched.
      const persisted = await manager.load(first.parentRunId);
      const entry = findSubstepState(persisted?.substepStates ?? [], '1', buildFrameKey('1'));
      expect(entry?.delegation?.tokenHash).toBe(retried.tokenHash);
    });
  });

  describe('abortDelegation', () => {
    it('returns token_not_found for a token no run owns', async () => {
      const { seam: localSeam } = await startSeamOnDelegateStep();

      await expect(
        localSeam.abortDelegation({
          token: `${TOKEN_PREFIX}unknown00000000000000000000000000`,
          callerEvidence: runControlEvidence(runId),
          force: false,
        }),
      ).resolves.toEqual({ kind: 'token_not_found' });
    });

    it('refuses metadata-only plugin evidence and names the issuance intent', async () => {
      // The abort seam's only authority gate is `#resolveMutationActorContext`,
      // and its refusal must carry the intent the frontend renders — an abort is
      // reported under the delegation-issuance intent, not a bare refusal.
      const { seam: localSeam, manager: mgr, state } = await startSeamOnDelegateStep();
      const issued = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (issued.kind !== 'delegated') throw new Error('expected delegated');

      const outcome = await localSeam.abortDelegation({
        token: issued.token,
        callerEvidence: { kind: 'plugin', agentId: 'a' },
        force: false,
      });

      expect(outcome.kind).toBe('refused');
      if (outcome.kind !== 'refused') throw new Error('expected refused');
      expect(outcome.policy).toEqual({
        kind: 'actor_context_required',
        intent: 'delegation-issuance',
      });
      expect(
        findSubstepState((await mgr.load(state.id))?.substepStates ?? [], '1', buildFrameKey('1'))
          ?.delegation?.cancelledAt,
      ).toBeNull();
    });

    it('cancels by the scanned SUBSTEP id, not the fully qualified step id', async () => {
      // On a multi-substep step the two differ (`2.1` vs `1`), and the persisted
      // substep entry is keyed by the substep id alone. Collapsing to the
      // qualified id finds nothing and reports the live token as unknown.
      const { seam: localSeam, manager: mgr, state } = await startSeamOnMultiStepRunbook();
      const issued = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
        explicitTarget: { stepId: '2.1' },
      });
      if (issued.kind !== 'delegated') throw new Error('expected delegated');

      const outcome = await localSeam.abortDelegation({
        token: issued.token,
        callerEvidence: runControlEvidence(runId),
        force: false,
      });

      expect(outcome).toEqual(
        expect.objectContaining({ kind: 'cancelled', substepId: '1', cleanup: 'none' }),
      );
      expect(
        findSubstepState((await mgr.load(state.id))?.substepStates ?? [], '1', buildFrameKey('2'))
          ?.delegation?.cancelledAt,
      ).toEqual(expect.any(String));
    });

    // The token scan only identifies the aggregate. Every behaviour-bearing
    // decision is re-taken against the captured parent, so a delegation that
    // moves between the scan and the capture must refuse rather than cancel
    // whatever the capture happens to hold.
    describe('in-fence abort re-resolution', () => {
      /** Issue a delegation, then commit `mutate` as the abort fence is entered. */
      async function abortAfterFenceMutation(
        mutate: (issuedTokenHash: string) => (current: RunbookState) => RunbookStateUpdate,
      ): Promise<{
        outcome: DelegationAbortOutcome;
        state: RunbookState;
        mgr: RunbookStateManager;
      }> {
        const { seam: localSeam, deps, manager: mgr, state } = await startSeamOnDelegateStep();
        const issued = await localSeam.issueDelegation({
          mode: 'fresh',
          callerEvidence: runControlEvidence(runId),
        });
        if (issued.kind !== 'delegated') throw new Error('expected delegated');
        const abortingSeam = new RunbookLifecycleCommandService({
          ...deps,
          actorMutationRunner: runnerWithAsyncFenceEntryHook(deps.actorMutationRunner, async () => {
            await mgr.updateWithState(state.id, mutate(issued.tokenHash));
          }),
        });

        const outcome = await abortingSeam.abortDelegation({
          token: issued.token,
          callerEvidence: runControlEvidence(runId),
          force: false,
        });
        return { outcome, state, mgr };
      }

      it('refuses token_not_found when the captured run has no substep states at all', async () => {
        const { outcome } = await abortAfterFenceMutation(() => () => ({ substepStates: [] }));
        expect(outcome).toEqual({ kind: 'token_not_found' });
      });

      it('refuses token_not_found when the captured substep carries no delegation', async () => {
        const { outcome, state, mgr } = await abortAfterFenceMutation(() => (current) => ({
          substepStates: (current.substepStates ?? []).map(({ delegation: _drop, ...entry }) => ({
            ...entry,
            status: 'done' as const,
          })),
        }));

        expect(outcome).toEqual({ kind: 'token_not_found' });
        expect(
          findSubstepState((await mgr.load(state.id))?.substepStates ?? [], '1', buildFrameKey('1'))
            ?.delegation,
        ).toBeUndefined();
      });

      it('refuses token_not_found when the captured delegation linked a child after the scan', async () => {
        // The scan saw no linked child, so no child is an aggregate member. A
        // link that lands before the capture means the abort would tear down a
        // delegation whose child it never owned.
        const racingChildRunId = assertRunId('rd_ca0a0000000000000000000000000000');
        const { outcome, state, mgr } = await abortAfterFenceMutation(() => (current) => ({
          substepStates: (current.substepStates ?? []).map((entry) =>
            entry.delegation
              ? { ...entry, delegation: { ...entry.delegation, childRunId: racingChildRunId } }
              : entry,
          ),
        }));

        expect(outcome).toEqual({ kind: 'token_not_found' });
        const delegation = findSubstepState(
          (await mgr.load(state.id))?.substepStates ?? [],
          '1',
          buildFrameKey('1'),
        )?.delegation;
        expect(delegation?.childRunId).toBe(racingChildRunId);
        expect(delegation?.cancelledAt).toBeNull();
      });
    });

    // Mirrors the issuance and retry mappings: the machine owns the abort
    // decision, and each of its statuses maps to a distinct operator outcome.
    describe('machine preparation refusals', () => {
      async function abortWithPreparedStatus(
        prepared: Awaited<ReturnType<RunbookActorService['prepareManualDelegationMutation']>>,
      ): Promise<DelegationAbortOutcome> {
        const { seam: localSeam } = await startSeamOnDelegateStep();
        const issued = await localSeam.issueDelegation({
          mode: 'fresh',
          callerEvidence: runControlEvidence(runId),
        });
        if (issued.kind !== 'delegated') throw new Error('expected delegated');
        jest
          .spyOn(RunbookActorService.prototype, 'prepareManualDelegationMutation')
          .mockResolvedValue(prepared);
        return localSeam.abortDelegation({
          token: issued.token,
          callerEvidence: runControlEvidence(runId),
          force: false,
        });
      }

      it('maps an error preparation status to the machine error verbatim', async () => {
        const refusal = Errors.delegationInFlight('1', 'rd_eeeeeeeeeeeeeeeeeeeeeeeeeeeeee00');
        const outcome = await abortWithPreparedStatus({ status: 'error', error: refusal });
        expect(outcome).toEqual({ kind: 'error', error: refusal });
      });

      it('maps a child_in_flight preparation status to the machine error verbatim', async () => {
        const refusal = Errors.delegationInFlight('1', 'rd_eeeeeeeeeeeeeeeeeeeeeeeeeeeeee01');
        const outcome = await abortWithPreparedStatus({
          status: 'child_in_flight',
          childRunId: assertRunId('rd_eeeeeeeeeeeeeeeeeeeeeeeeeeeeee01'),
          error: refusal,
        });
        expect(outcome).toEqual({ kind: 'error', error: refusal });
      });

      it('maps a needs_force preparation status to the force-required outcome', async () => {
        const childRunId = assertRunId('rd_eeeeeeeeeeeeeeeeeeeeeeeeeeeeee02');
        const outcome = await abortWithPreparedStatus({ status: 'needs_force', childRunId });
        expect(outcome).toEqual({ kind: 'needs_force', substepId: '1', childRunId });
      });
    });

    it('rehydrates the interrupted abort member from its own captured steps', async () => {
      const { seam: localSeam, state } = await startSeamOnDelegateStep();
      const issued = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (issued.kind !== 'delegated') throw new Error('expected delegated');
      jest
        .spyOn(RunbookStore.prototype, 'commitOwnedRunSet')
        .mockRejectedValue(new Error('crash before durable commit'));
      const recoverySpy = jest.spyOn(actorService, 'createRecoveryActor').mockImplementation(() => {
        throw new InvalidRunbookStateError('recovery actor unavailable');
      });

      const outcome = await localSeam.abortDelegation({
        token: issued.token,
        callerEvidence: runControlEvidence(runId),
        force: false,
      });

      expect(outcome.kind).toBe('aggregate_recovery_required');
      expect(recoverySpy).toHaveBeenCalledTimes(1);
      expect(recoverySpy.mock.calls[0]?.[0].id).toBe(state.id);
    });

    it('commits cancellation through the aggregate workflow and replays as already cancelled', async () => {
      const { seam: localSeam, manager: mgr, state } = await startSeamOnDelegateStep();
      const issued = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (issued.kind !== 'delegated') throw new Error('expected delegated');

      const cancelled = await localSeam.abortDelegation({
        token: issued.token,
        callerEvidence: runControlEvidence(runId),
        force: false,
      });
      expect(cancelled.kind).toBe('cancelled');
      expect(
        (await mgr.load(state.id))?.substepStates?.find((entry) => entry.id === '1')?.delegation
          ?.cancelledAt,
      ).toEqual(expect.any(String));

      await expect(
        localSeam.abortDelegation({
          token: issued.token,
          callerEvidence: runControlEvidence(runId),
          force: false,
        }),
      ).resolves.toEqual(expect.objectContaining({ kind: 'already_cancelled' }));
    });

    it('persists no cancellation when ownership is lost before the abort effect boundary', async () => {
      const { seam: localSeam, manager: mgr, state } = await startSeamOnDelegateStep();
      const issued = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (issued.kind !== 'delegated') throw new Error('expected delegated');
      jest.spyOn(SqliteExecutionLeaseService.prototype, 'markEffectStartedAll').mockResolvedValue({
        kind: 'execution_in_progress',
        runId: state.id,
        message: 'ownership lost before abort effect boundary',
      });

      const outcome = await localSeam.abortDelegation({
        token: issued.token,
        callerEvidence: runControlEvidence(runId),
        force: false,
      });

      expect(outcome.kind).toBe('execution_in_progress');
      expect(
        (await mgr.load(state.id))?.substepStates?.find((entry) => entry.id === '1')?.delegation
          ?.cancelledAt,
      ).toBeNull();
    });

    it('reconciles committed-but-unobserved abort and replays without another mutation', async () => {
      const { seam: localSeam } = await startSeamOnDelegateStep();
      const issued = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (issued.kind !== 'delegated') throw new Error('expected delegated');
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const commit = RunbookStore.prototype.commitOwnedRunSet;
      let first = true;
      jest.spyOn(RunbookStore.prototype, 'commitOwnedRunSet').mockImplementation(async function (
        this: RunbookStore,
        input,
      ) {
        const result = await commit.call(this, input);
        if (first) {
          first = false;
          throw new Error('crash after durable abort commit');
        }
        return result;
      });

      const outcome = await localSeam.abortDelegation({
        token: issued.token,
        callerEvidence: runControlEvidence(runId),
        force: false,
      });
      expect(outcome.kind).toBe('cancelled');

      await expect(
        localSeam.abortDelegation({
          token: issued.token,
          callerEvidence: runControlEvidence(runId),
          force: false,
        }),
      ).resolves.toEqual(expect.objectContaining({ kind: 'already_cancelled' }));
    });

    it('leaves a replacement delegation untouched when the token changes after scan', async () => {
      const { seam: localSeam, deps, manager: mgr, state } = await startSeamOnDelegateStep();
      const issued = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (issued.kind !== 'delegated') throw new Error('expected delegated');
      const replacementHash = assertDelegationTokenHash(`sha256:${'b'.repeat(64)}`);
      const scan = deps.findDelegationsByTokenHash;
      const abortingSeam = new RunbookLifecycleCommandService({
        ...deps,
        findDelegationsByTokenHash: async (tokenHash) => {
          const found = await scan(tokenHash);
          if (found.current) {
            await mgr.updateWithState(state.id, (current) => ({
              substepStates: (current.substepStates ?? []).map((entry) =>
                entry.delegation?.tokenHash === issued.tokenHash
                  ? {
                      ...entry,
                      delegation: { ...entry.delegation, tokenHash: replacementHash },
                    }
                  : entry,
              ),
            }));
          }
          return found;
        },
      });

      const outcome = await abortingSeam.abortDelegation({
        token: issued.token,
        callerEvidence: runControlEvidence(runId),
        force: false,
      });

      expect(outcome.kind).toBe('token_not_found');
      const delegation = (await mgr.load(state.id))?.substepStates?.find(
        (entry) => entry.id === '1',
      )?.delegation;
      expect(delegation?.tokenHash).toBe(replacementHash);
      expect(delegation?.cancelledAt).toBeNull();
    });

    it('writes no cancellation when the parent bearer is removed after authorization', async () => {
      const { seam: localSeam, manager: mgr, state } = await startSeamOnDelegateStep();
      const issued = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (issued.kind !== 'delegated') throw new Error('expected delegated');
      const recordSeen = sessionService.recordClaimSeen.bind(sessionService);
      jest.spyOn(sessionService, 'recordClaimSeen').mockImplementation(async (claimId) => {
        const result = await recordSeen(claimId);
        unwrapSessionMutation(await sessionService.releaseRunbook(state.id));
        return result;
      });

      const outcome = await localSeam.abortDelegation({
        token: issued.token,
        callerEvidence: runControlEvidence(runId),
        force: false,
      });

      expect(outcome.kind).toBe('claim_superseded');
      expect(
        (await mgr.load(state.id))?.substepStates?.find((entry) => entry.id === '1')?.delegation
          ?.cancelledAt,
      ).toBeNull();
    });

    // The linked child is captured as an aggregate member on the strength of the
    // parent's `childRunId` alone. Before anything is torn down, the child's OWN
    // linkage must name this exact delegation back: run, substep, frame and
    // token verifier. A child that names a different one is somebody else's, and
    // force-aborting it would stop an unrelated run.
    describe('linked-child linkage verification', () => {
      /**
       * Force-abort a delegation whose linked child carries `linkage`.
       *
       * @param linkage - Parent linkage to persist on the linked child.
       * @returns The abort outcome and the parent's delegation afterwards.
       */
      async function forceAbortWithChildLinkage(
        linkage: (issuedTokenHash: string, parentRunId: RunId) => RunbookState['parentLinkage'],
      ): Promise<{ outcome: DelegationAbortOutcome; cancelledAt: string | null | undefined }> {
        const { seam: localSeam, manager: mgr, state } = await startSeamOnDelegateStep();
        const issued = await localSeam.issueDelegation({
          mode: 'fresh',
          callerEvidence: runControlEvidence(runId),
        });
        if (issued.kind !== 'delegated') throw new Error('expected delegated');
        const childRunId = assertRunId('rd_da0a0000000000000000000000000000');
        await mgr.updateWithState(state.id, (current) => ({
          substepStates: (current.substepStates ?? []).map((entry) =>
            entry.delegation
              ? { ...entry, delegation: { ...entry.delegation, childRunId } }
              : entry,
          ),
        }));
        await mgr.save(
          baseState({
            id: childRunId,
            runbookPath: 'child.md',
            lifecycle: 'stopped',
            ...(() => {
              const built = linkage(issued.tokenHash, state.id);
              return built === undefined ? {} : { parentLinkage: built };
            })(),
          }),
        );
        await issueRunControlClaimFor(childRunId);

        const outcome = await localSeam.abortDelegation({
          token: issued.token,
          callerEvidence: runControlEvidence(runId),
          force: true,
        });
        const cancelledAt = findSubstepState(
          (await mgr.load(state.id))?.substepStates ?? [],
          '1',
          buildFrameKey('1'),
        )?.delegation?.cancelledAt;
        return { outcome, cancelledAt };
      }

      /** The linkage a real delegation writes; each case below breaks one field. */
      const matching = (tokenHash: string, parentRunId: RunId) =>
        ({
          kind: 'delegation',
          parentRunId,
          parentStepId: '1',
          parentStep: '1',
          parentFrameKey: buildFrameKey('1'),
          parentEntry: 1,
          tokenHash: assertDelegationTokenHash(tokenHash),
        }) as const;

      it('force-aborts a child whose linkage names this exact delegation', async () => {
        const { outcome, cancelledAt } = await forceAbortWithChildLinkage(matching);
        expect(outcome).toEqual(
          expect.objectContaining({ kind: 'cancelled', cleanup: 'terminal_child_cleaned' }),
        );
        expect(cancelledAt).toEqual(expect.any(String));
      });

      it.each([
        ['no linkage at all', () => undefined],
        [
          'an inline linkage',
          (_hash: string, parentRunId: RunId) =>
            ({
              kind: 'inline',
              parentRunId,
              parentStepId: '1',
              parentStep: '1',
              parentFrameKey: buildFrameKey('1'),
              parentEntry: 1,
            }) as unknown as RunbookState['parentLinkage'],
        ],
        [
          'a different parent run',
          (hash: string) => ({
            ...matching(hash, assertRunId('rd_da0b0000000000000000000000000000')),
          }),
        ],
        [
          'a different parent substep',
          (hash: string, parentRunId: RunId) => ({
            ...matching(hash, parentRunId),
            parentStepId: '2',
          }),
        ],
        [
          'a different parent frame',
          (hash: string, parentRunId: RunId) => ({
            ...matching(hash, parentRunId),
            parentFrameKey: buildFrameKey('1', 2),
          }),
        ],
        [
          'a different token verifier',
          (_hash: string, parentRunId: RunId) => ({
            ...matching(`sha256:${'b'.repeat(64)}`, parentRunId),
          }),
        ],
      ])('refuses token_not_found for a child with %s', async (_label, linkage) => {
        const { outcome, cancelledAt } = await forceAbortWithChildLinkage(linkage);
        expect(outcome).toEqual({ kind: 'token_not_found' });
        expect(cancelledAt).toBeNull();
      });
    });

    it('refuses to commit a force-abort whose child failure could not be recorded', async () => {
      // The parent's delegated outcome is the only evidence a collect can ever
      // resolve against the torn-down child. If the completion cannot be
      // prepared the abort must abandon the whole transaction rather than commit
      // a cancellation with no matching outcome — a silently unresolvable run.
      const { seam: localSeam, manager: mgr, state } = await startSeamOnDelegateStep();
      const issued = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (issued.kind !== 'delegated') throw new Error('expected delegated');
      const childRunId = assertRunId('rd_da0d0000000000000000000000000000');
      await mgr.updateWithState(state.id, (current) => ({
        substepStates: (current.substepStates ?? []).map((entry) =>
          entry.delegation ? { ...entry, delegation: { ...entry.delegation, childRunId } } : entry,
        ),
      }));
      await mgr.save(
        baseState({
          id: childRunId,
          runbookPath: 'child.md',
          lifecycle: 'stopped',
          parentLinkage: {
            kind: 'delegation',
            parentRunId: state.id,
            parentStepId: '1',
            parentStep: '1',
            parentFrameKey: buildFrameKey('1'),
            parentEntry: 1,
            tokenHash: assertDelegationTokenHash(issued.tokenHash),
          },
        }),
      );
      await issueRunControlClaimFor(childRunId);
      jest
        .spyOn(RunbookCompletionService.prototype, 'prepareChildCompletion')
        .mockReturnValue({ kind: 'not-applicable' });

      await expect(
        localSeam.abortDelegation({
          token: issued.token,
          callerEvidence: runControlEvidence(runId),
          force: true,
        }),
      ).rejects.toThrow('Force abort could not prepare child failure: not-applicable');
      expect(
        findSubstepState((await mgr.load(state.id))?.substepStates ?? [], '1', buildFrameKey('1'))
          ?.delegation?.cancelledAt,
      ).toBeNull();
    });

    it('force-stops a running linked child and records the failure against the parent', async () => {
      // The `active_child_failed` cleanup branch: unlike a terminal child, a
      // running one must actually be driven terminal by the same commit, not
      // merely unlinked.
      const { seam: localSeam, deps, manager: mgr, state } = await startSeamOnDelegateStep();
      const issued = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (issued.kind !== 'delegated') throw new Error('expected delegated');
      const childRunId = assertRunId('rd_da0c0000000000000000000000000000');
      await mgr.updateWithState(state.id, (current) => ({
        substepStates: (current.substepStates ?? []).map((entry) =>
          entry.delegation ? { ...entry, delegation: { ...entry.delegation, childRunId } } : entry,
        ),
      }));
      await mgr.save(
        baseState({
          id: childRunId,
          runbookPath: 'child.md',
          lifecycle: 'running',
          parentLinkage: {
            kind: 'delegation',
            parentRunId: state.id,
            parentStepId: '1',
            parentStep: '1',
            parentFrameKey: buildFrameKey('1'),
            parentEntry: 1,
            tokenHash: assertDelegationTokenHash(issued.tokenHash),
          },
        }),
      );
      await issueRunControlClaimFor(childRunId);
      const parentLoadSteps = deps.loadSteps;
      deps.loadSteps = (target) =>
        target.id === childRunId
          ? [
              {
                kind: 'base',
                name: '1',
                description: 'child step',
                transitions: tx('CONTINUE', 'STOP'),
              },
            ]
          : parentLoadSteps(target);

      const outcome = await localSeam.abortDelegation({
        token: issued.token,
        callerEvidence: runControlEvidence(runId),
        force: true,
      });

      expect(outcome).toEqual(
        expect.objectContaining({ kind: 'cancelled', cleanup: 'active_child_failed' }),
      );
      // Driven terminal by the same commit, not merely unlinked.
      expect((await mgr.load(childRunId))?.lifecycle).toBe('stopped');
      const parent = await mgr.load(state.id);
      expect(parent?.substepStates?.find((entry) => entry.id === '1')).toEqual(
        expect.objectContaining({ status: 'done', result: 'fail' }),
      );
      expect(Object.values(parent?.resolvedCompletions ?? {})).toEqual([
        expect.objectContaining({ agentId: 'delegation', result: 'fail' }),
      ]);
    });

    it('retains a terminal child, records fail, and releases its claim in the same commit', async () => {
      const { seam: localSeam, manager: mgr, state } = await startSeamOnDelegateStep();
      const issued = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (issued.kind !== 'delegated') throw new Error('expected delegated');
      const childRunId = assertRunId('rd_ab0b0000000000000000000000000000');
      await mgr.updateWithState(state.id, (current) => ({
        substepStates: (current.substepStates ?? []).map((entry) =>
          entry.delegation?.tokenHash === issued.tokenHash
            ? { ...entry, delegation: { ...entry.delegation, childRunId } }
            : entry,
        ),
      }));
      await mgr.save(
        baseState({
          id: childRunId,
          lifecycle: 'stopped',
          parentLinkage: {
            kind: 'delegation',
            parentRunId: state.id,
            parentStepId: '1',
            parentStep: '1',
            parentFrameKey: buildFrameKey('1'),
            parentEntry: 1,
            tokenHash: assertDelegationTokenHash(issued.tokenHash),
          },
        }),
      );
      await issueRunControlClaimFor(childRunId);
      const childClaim = issuedRunControlClaims.get(childRunId);
      if (childClaim === undefined) throw new Error('expected child claim');

      const outcome = await localSeam.abortDelegation({
        token: issued.token,
        callerEvidence: runControlEvidence(runId),
        force: true,
      });

      expect(outcome).toEqual(
        expect.objectContaining({ kind: 'cancelled', cleanup: 'terminal_child_cleaned' }),
      );
      expect((await mgr.load(childRunId))?.lifecycle).toBe('stopped');
      expect((await mgr.loadSession()).claims[claimKeyFromBearer(childClaim)]).toBeUndefined();
      const parent = await mgr.load(state.id);
      expect(parent?.substepStates?.find((entry) => entry.id === '1')).toEqual(
        expect.objectContaining({ status: 'done', result: 'fail' }),
      );
      expect(Object.values(parent?.resolvedCompletions ?? {})).toEqual([
        expect.objectContaining({ agentId: 'delegation', result: 'fail' }),
      ]);
    });

    it('rolls back child evidence, parent cancellation, completion, and release on projection fault', async () => {
      const { seam: localSeam, manager: mgr, state } = await startSeamOnDelegateStep();
      const issued = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (issued.kind !== 'delegated') throw new Error('expected delegated');
      const childRunId = assertRunId('rd_ab0c0000000000000000000000000000');
      await mgr.updateWithState(state.id, (current) => ({
        substepStates: (current.substepStates ?? []).map((entry) =>
          entry.delegation?.tokenHash === issued.tokenHash
            ? { ...entry, delegation: { ...entry.delegation, childRunId } }
            : entry,
        ),
      }));
      await mgr.save(
        baseState({
          id: childRunId,
          lifecycle: 'stopped',
          parentLinkage: {
            kind: 'delegation',
            parentRunId: state.id,
            parentStepId: '1',
            parentStep: '1',
            parentFrameKey: buildFrameKey('1'),
            parentEntry: 1,
            tokenHash: assertDelegationTokenHash(issued.tokenHash),
          },
        }),
      );
      await issueRunControlClaimFor(childRunId);
      const childClaim = issuedRunControlClaims.get(childRunId);
      if (childClaim === undefined) throw new Error('expected child claim');
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const commit = RunbookStore.prototype.commitOwnedRunSet;
      jest.spyOn(RunbookStore.prototype, 'commitOwnedRunSet').mockImplementation(function (
        this: RunbookStore,
        input,
      ) {
        return commit.call(this, {
          ...input,
          updateSession: (session) => {
            input.updateSession?.(session);
            throw new Error('abort session projection fault');
          },
        });
      });
      jest.spyOn(actorService, 'createRecoveryActor').mockImplementation(() => {
        throw new InvalidRunbookStateError('simulated abort commit crash');
      });

      const outcome = await localSeam.abortDelegation({
        token: issued.token,
        callerEvidence: runControlEvidence(runId),
        force: true,
      });

      expect(outcome.kind).toBe('aggregate_recovery_required');
      const parent = await mgr.load(state.id);
      expect(
        parent?.substepStates?.find((entry) => entry.id === '1')?.delegation?.cancelledAt,
      ).toBeNull();
      expect(Object.keys(parent?.resolvedCompletions ?? {})).toHaveLength(0);
      expect((await mgr.load(childRunId))?.lifecycle).toBe('stopped');
      expect((await mgr.loadSession()).claims[claimKeyFromBearer(childClaim)]).toBeDefined();
    });

    /**
     * Link a live child run to the delegation `issued` on `parentRunId`, seed
     * the delegated outcome it reported, and issue its run-control claim.
     *
     * @param parentRunId - Parent run owning the delegation.
     * @param issued - The delegation issuance whose substep gains the child link.
     * @param childRunId - Child run to create and link.
     * @returns The completion key of the seeded delegated outcome.
     */
    async function linkLiveChild(
      parentRunId: RunId,
      issued: { readonly tokenHash: string },
      childRunId: RunId,
    ): Promise<string> {
      await manager.updateWithState(parentRunId, (current) => ({
        substepStates: (current.substepStates ?? []).map((entry) =>
          entry.delegation?.tokenHash === issued.tokenHash
            ? { ...entry, delegation: { ...entry.delegation, childRunId } }
            : entry,
        ),
      }));
      await manager.save(
        baseState({
          id: childRunId,
          lifecycle: 'running',
          parentLinkage: {
            kind: 'delegation',
            parentRunId,
            parentStepId: '1',
            parentStep: '1',
            parentFrameKey: buildFrameKey('1'),
            parentEntry: 1,
            tokenHash: assertDelegationTokenHash(issued.tokenHash),
          },
        }),
      );
      await issueRunControlClaimFor(childRunId);
      const completionKey = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
      const parent = await manager.load(parentRunId);
      if (!parent) throw new Error('expected persisted parent');
      await manager.save({
        ...parent,
        resolvedCompletions: {
          [completionKey]: buildResolvedCompletion({
            agentId: 'delegation',
            result: 'fail',
            targetStep: '1',
            targetSubstep: '1',
            targetFrame: activeFrame(buildFrameKey('1'), 1),
            completedAt: '2026-07-05T00:00:00.000Z',
          }),
        },
      });
      return completionKey;
    }

    it('cancels the parent delegation and cleans the reference when the linked child state is gone', async () => {
      // Regression guard: a parent that still records a `childRunId` whose run
      // has been pruned or deleted must stay force-abortable. Refusing
      // `missing` before the aggregate left the delegation permanently linked
      // — a stuck state with no operator recovery.
      const { seam: localSeam, manager: mgr, state } = await startSeamOnDelegateStep();
      const issued = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (issued.kind !== 'delegated') throw new Error('expected delegated');
      const childRunId = assertRunId('rd_ab0d0000000000000000000000000000');
      await linkLiveChild(state.id, issued, childRunId);
      // Prune the child exactly as `rundown prune` does: the parent keeps its
      // reference, the run itself is gone.
      await mgr.delete(childRunId);

      const outcome = await localSeam.abortDelegation({
        token: issued.token,
        callerEvidence: runControlEvidence(runId),
        force: true,
      });

      expect(outcome).toEqual(
        expect.objectContaining({
          kind: 'cancelled',
          cleanup: 'missing_child_cleaned',
          childRunId,
        }),
      );
      const parent = await mgr.load(state.id);
      expect(
        parent?.substepStates?.find((entry) => entry.id === '1')?.delegation?.cancelledAt,
      ).toEqual(expect.any(String));
      // The vanished child's stale delegated outcome is superseded, so nothing
      // is left that a later collect could resolve against a run that is gone.
      expect(Object.keys(parent?.resolvedCompletions ?? {})).toHaveLength(0);
    });

    it('leaves the delegation re-issuable after force-aborting a pruned linked child', async () => {
      // The operator recovery the `missing` refusal removed: once the stale
      // link is force-aborted, the same substep accepts a fresh delegation.
      const { seam: localSeam, manager: mgr, state } = await startSeamOnDelegateStep();
      const issued = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (issued.kind !== 'delegated') throw new Error('expected delegated');
      const childRunId = assertRunId('rd_ab0e0000000000000000000000000000');
      await linkLiveChild(state.id, issued, childRunId);
      await mgr.delete(childRunId);

      const cancelled = await localSeam.abortDelegation({
        token: issued.token,
        callerEvidence: runControlEvidence(runId),
        force: true,
      });
      expect(cancelled.kind).toBe('cancelled');

      // Force-abort is terminal for the token: the replay is idempotent, not a
      // second `missing`.
      await expect(
        localSeam.abortDelegation({
          token: issued.token,
          callerEvidence: runControlEvidence(runId),
          force: true,
        }),
      ).resolves.toEqual(expect.objectContaining({ kind: 'already_cancelled' }));

      const retried = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: runControlEvidence(runId),
        locator: { kind: 'step', step: issued.stepId },
      });
      expect(retried.kind).toBe('retried');
      if (retried.kind !== 'retried') throw new Error('expected retried');
      expect(retried.tokenHash).not.toBe(issued.tokenHash);
      const parent = await mgr.load(state.id);
      const delegation = parent?.substepStates?.find((entry) => entry.id === '1')?.delegation;
      expect(delegation?.tokenHash).toBe(retried.tokenHash);
      expect(delegation?.childRunId).toBeNull();
      expect(delegation?.cancelledAt).toBeNull();
    });

    it('still refuses the force-abort when the present linked child is owned by another execution', async () => {
      // The counterweight to the missing-child drop: a child that EXISTS stays
      // a required aggregate member, so a genuine capture refusal still vetoes
      // the whole force-abort instead of being silently discarded.
      const { seam: localSeam, deps, manager: mgr, state } = await startSeamOnDelegateStep();
      const issued = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(runId),
      });
      if (issued.kind !== 'delegated') throw new Error('expected delegated');
      const childRunId = assertRunId('rd_ab0f0000000000000000000000000000');
      const completionKey = await linkLiveChild(state.id, issued, childRunId);
      // The child runs its own runbook, so it resolves its own steps.
      const parentLoadSteps = deps.loadSteps;
      deps.loadSteps = (target) =>
        target.id === childRunId
          ? [
              {
                kind: 'base',
                name: '1',
                description: 'child step',
                transitions: tx('CONTINUE', 'STOP'),
              },
            ]
          : parentLoadSteps(target);
      await ownRunForTest(tmp, childRunId);

      const outcome = await localSeam.abortDelegation({
        token: issued.token,
        callerEvidence: runControlEvidence(runId),
        force: true,
      });

      expect(outcome).toEqual({
        kind: 'execution_in_progress',
        runId: childRunId,
        message: `Run ${childRunId} has an execution in progress.`,
      });
      const parent = await mgr.load(state.id);
      const delegation = parent?.substepStates?.find((entry) => entry.id === '1')?.delegation;
      expect(delegation?.cancelledAt).toBeNull();
      expect(delegation?.childRunId).toBe(childRunId);
      expect(Object.keys(parent?.resolvedCompletions ?? {})).toEqual([completionKey]);
      expect((await mgr.load(childRunId))?.lifecycle).toBe('running');
    });
  });

  describe('runTransition refusals', () => {
    const steps: ResolvedStep[] = [
      { kind: 'base', name: '1', description: 'one', transitions: tx('CONTINUE', 'STOP') },
    ];

    beforeEach(() => {
      loadStepsImpl = () => steps;
    });

    it('returns none when there is no active run', async () => {
      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: DIRECT_CLI,
        targetSelector: { kind: 'default' },
        terminalPolicy: RELEASE_POLICY,
      });
      expect(outcome).toEqual({ kind: 'none' });
    });

    it('allows metadata-only plugin evidence on a standalone transition', async () => {
      await activate(baseState());
      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: { kind: 'plugin', agentId: 'a' },
        targetSelector: { kind: 'default' },
        terminalPolicy: RELEASE_POLICY,
      });
      expect(outcome.kind).toBe('applied');
    });

    it('refuses a bare advance while delegation collection is pending', async () => {
      const completionKey = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
      await activate(
        baseState({
          resolvedCompletions: {
            [completionKey]: buildResolvedCompletion({
              agentId: 'delegation',
              result: 'pass',
              targetStep: '1',
              targetSubstep: '1',
              targetFrame: activeFrame(buildFrameKey('1'), 1),
              completedAt: '2026-06-28T00:00:00.000Z',
            }),
          },
        }),
      );

      const outcome = await seam.runTransition({
        command: 'pass',
        // The pending-outcome run classifies `delegating`; the guard's subject
        // needs named authority. The direct-CLI twin below pins the role gate.
        callerEvidence: runControlEvidence(runId),
        targetSelector: { kind: 'default' },
        terminalPolicy: RELEASE_POLICY,
      });
      expect(outcome.kind).toBe('delegation_collection_pending');

      const bare = await seam.runTransition({
        command: 'pass',
        callerEvidence: DIRECT_CLI,
        targetSelector: { kind: 'default' },
        terminalPolicy: RELEASE_POLICY,
      });
      expect(bare.kind).toBe('actor_context_required');
    });

    it('still refuses (does not throw) an explicit-step transition with no active run', async () => {
      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: DIRECT_CLI,
        targetSelector: { kind: 'explicit-step', step: '1.1' },
        terminalPolicy: RELEASE_POLICY,
      });
      expect(outcome).toEqual({ kind: 'none' });
    });

    it('throws when a ready explicit-step transition carries no explicit target', async () => {
      await activate(baseState());
      await expect(
        seam.runTransition({
          command: 'pass',
          callerEvidence: runControlEvidence(runId),
          targetSelector: { kind: 'explicit-step', step: '1.1' },
          terminalPolicy: RELEASE_POLICY,
        }),
      ).rejects.toThrow(/requires an explicit target/);
    });

    it('does not over-tighten: a deliberate non-active --index target records at an inactive frame', async () => {
      // A deliberate `--step`/`--index` target of a non-active FOR iteration
      // resolves in-lock to an `inactive` frame (frame-only, sentinel entry) and
      // records — live-frame identity only pins `active`-kind targets. Record and
      // drain are mocked (the unlocked twins — the explicit span holds the
      // CompletionLock) so this isolates the frame decision.
      const forSteps: ResolvedStep[] = [
        {
          kind: 'for',
          name: '1',
          description: 'FOR step',
          forClause: { variable: 'i', start: 1, end: 9 },
          substeps: [
            { id: '1', description: 'A', transitions: tx('CONTINUE', 'STOP') },
            { id: '2', description: 'B', transitions: tx('CONTINUE', 'STOP') },
          ],
          transitions: tx('CONTINUE', 'STOP'),
        },
      ];
      loadStepsImpl = () => forSteps;
      const recordSpy = jest.spyOn(completionService, 'prepareManualCompletion');
      await activate(
        baseState({
          step: '1',
          stepName: 'FOR step',
          substep: '1',
          activeFrameKey: buildFrameKey('1', 1),
          frameEntryCounts: { [buildFrameKey('1', 1)]: 1 },
          substepStates: [{ id: '1', frameKey: buildFrameKey('1', 1), status: 'running' }],
        }),
      );

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: runControlEvidence(runId),
        targetSelector: { kind: 'explicit-step', step: '1.1' },
        terminalPolicy: RELEASE_POLICY,
        explicitTarget: { stepId: '1.1', iteration: 5 },
      });

      expect(recordSpy).toHaveBeenCalledTimes(1);
      expect(recordSpy).toHaveBeenCalledWith(
        expect.objectContaining({ targetFrame: inactiveFrame(buildFrameKey('1', 5)) }),
      );
      expect(outcome.kind).toBe('applied');
    });
  });

  // #613: a `claim` target selector names its run BY the bearer, so it is the
  // same fact as `claim_bearer` evidence carrying that id. Every seam that
  // accepts the two as separate fields reconciles them at entry; a divergence
  // refuses rather than deriving authority from the TARGET's own claim, which
  // would silently authorize as the target while the caller's evidence said
  // something else.
  describe('claim-target reconciliation (#613)', () => {
    const runA = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const runB = assertRunId('rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    // A claim id that parses and is shaped like a bearer but names no session
    // claim: presenting it proves the reconciliation runs BEFORE resolution.
    const unresolvableClaimId = assertClaimId(
      'rdclm_00000000000000000000000000000000_abcdefghijklmnopqrstuvwxyzABCDE1234567890-_',
    );

    const twoSteps: ResolvedStep[] = [
      { kind: 'base', name: '1', description: 'one', transitions: tx('CONTINUE', 'STOP') },
      { kind: 'base', name: '2', description: 'two', transitions: tx('COMPLETE', 'STOP') },
    ];

    /**
     * Stand up runs A and B, each with its own run-control claim.
     *
     * B is pushed FIRST so A ends up stack-top: every case below targets B's
     * claim, so a seam that lost the claim selector would fall back to A rather
     * than coincidentally landing on the same run these cases assert about.
     */
    async function activateTwoClaimedRuns(): Promise<{ claimA: ClaimId; claimB: ClaimId }> {
      loadStepsImpl = () => twoSteps;
      await activate(baseState({ id: runB, runbookPath: 'b.md' }));
      await activate(baseState({ id: runA, runbookPath: 'a.md' }));
      return { claimA: claimFor(runA), claimB: claimFor(runB) };
    }

    /** The run-control claim minted for a run by `activate`. */
    function claimFor(id: RunbookState['id']): ClaimId {
      const claimId = issuedRunControlClaims.get(id);
      if (claimId === undefined) throw new Error(`expected run-control claim for ${id}`);
      return claimId;
    }

    it('refuses a transition whose presented bearer names a different claim', async () => {
      const { claimA, claimB } = await activateTwoClaimedRuns();

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: { kind: 'claim_bearer', claimId: claimA },
        targetSelector: { kind: 'claim', claimId: claimB },
        terminalPolicy: RELEASE_POLICY,
      });

      expect(outcome).toEqual({ kind: 'claim_bearer_mismatch' });
      // Neither run moved: the target was never resolved, let alone advanced.
      expect((await manager.load(runA))?.step).toBe('1');
      expect((await manager.load(runB))?.step).toBe('1');
    });

    it('refuses a transition naming a claim with no bearer evidence at all', async () => {
      // The complementary hole: a claim selector carries the live secret, so
      // treating it as authority without the caller declaring it would let an
      // ambient `direct_cli` command mutate a claimed run.
      const { claimB } = await activateTwoClaimedRuns();

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: DIRECT_CLI,
        targetSelector: { kind: 'claim', claimId: claimB },
        terminalPolicy: RELEASE_POLICY,
      });

      expect(outcome).toEqual({ kind: 'claim_bearer_mismatch' });
      expect((await manager.load(runB))?.step).toBe('1');
    });

    it('refuses non-bearer evidence that smuggles a matching claimId field', async () => {
      // Authority keys on the DECLARED evidence kind, never on the presence of a
      // `claimId` property. `CallerEvidence` has no non-bearer variant carrying
      // one, so this shape is only reachable from an untyped frontend — which is
      // exactly the boundary the discriminant check has to hold at. Without the
      // kind check the field alone would authorize.
      const { claimB } = await activateTwoClaimedRuns();
      const smuggled = {
        kind: 'plugin',
        agentId: 'a',
        claimId: claimB,
      } as unknown as CallerEvidence;

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: smuggled,
        targetSelector: { kind: 'claim', claimId: claimB },
        terminalPolicy: RELEASE_POLICY,
      });

      expect(outcome).toEqual({ kind: 'claim_bearer_mismatch' });
      expect((await manager.load(runB))?.step).toBe('1');
    });

    it('applies a transition when the presented bearer is the named claim', async () => {
      // The positive control: reconciliation must not over-refuse the one shape
      // every frontend actually produces.
      const { claimB } = await activateTwoClaimedRuns();

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: { kind: 'claim_bearer', claimId: claimB },
        targetSelector: { kind: 'claim', claimId: claimB },
        terminalPolicy: RELEASE_POLICY,
      });

      expect(outcome.kind).toBe('applied');
      expect((await manager.load(runB))?.step).toBe('2');
      expect((await manager.load(runA))?.step).toBe('1');
    });

    it('reconciles before resolving, so a divergence outranks a stale target claim', async () => {
      // Presenting A against an unresolvable target refuses on the divergence,
      // NOT `stale_claim` — the ordering proof that nothing is read from a
      // claim the caller never presented.
      const { claimA } = await activateTwoClaimedRuns();

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: { kind: 'claim_bearer', claimId: claimA },
        targetSelector: { kind: 'claim', claimId: unresolvableClaimId },
        terminalPolicy: RELEASE_POLICY,
      });

      expect(outcome).toEqual({ kind: 'claim_bearer_mismatch' });
    });

    it('refuses a navigation whose presented bearer names a different claim', async () => {
      const { claimA, claimB } = await activateTwoClaimedRuns();

      const outcome = await seam.resolveRunNavigation({
        command: 'goto',
        callerEvidence: { kind: 'claim_bearer', claimId: claimA },
        targetSelector: { kind: 'claim', claimId: claimB },
      });

      expect(outcome).toEqual({ kind: 'claim_bearer_mismatch' });
    });

    it('refuses a navigation naming a claim with no bearer evidence at all', async () => {
      const { claimB } = await activateTwoClaimedRuns();

      const outcome = await seam.resolveRunNavigation({
        command: 'goto',
        callerEvidence: DIRECT_CLI,
        targetSelector: { kind: 'claim', claimId: claimB },
      });

      expect(outcome).toEqual({ kind: 'claim_bearer_mismatch' });
    });

    it('allows a navigation when the presented bearer is the named claim', async () => {
      const { claimB } = await activateTwoClaimedRuns();

      const outcome = await seam.resolveRunNavigation({
        command: 'goto',
        callerEvidence: { kind: 'claim_bearer', claimId: claimB },
        targetSelector: { kind: 'claim', claimId: claimB },
      });

      expect(outcome.kind).toBe('allowed');
      if (outcome.kind !== 'allowed') return;
      expect(outcome.runId).toBe(runB);
    });

    it('refuses a terminal whose presented bearer names a different claim', async () => {
      const { claimA, claimB } = await activateTwoClaimedRuns();
      const sendSpy = jest.spyOn(actorService, 'sendAndSync');

      const outcome = await seam.runTerminal({
        command: 'complete',
        callerEvidence: { kind: 'claim_bearer', claimId: claimA },
        targetSelector: { kind: 'claim', claimId: claimB },
      });

      expect(outcome).toEqual({ kind: 'claim_bearer_mismatch' });
      expect(sendSpy).not.toHaveBeenCalled();
      expect((await manager.load(runB))?.lifecycle).toBe('running');
    });

    it('refuses a terminal naming a claim with no bearer evidence at all', async () => {
      const { claimB } = await activateTwoClaimedRuns();
      const sendSpy = jest.spyOn(actorService, 'sendAndSync');

      const outcome = await seam.runTerminal({
        command: 'complete',
        callerEvidence: DIRECT_CLI,
        targetSelector: { kind: 'claim', claimId: claimB },
      });

      expect(outcome).toEqual({ kind: 'claim_bearer_mismatch' });
      expect(sendSpy).not.toHaveBeenCalled();
      expect((await manager.load(runB))?.lifecycle).toBe('running');
    });

    it('reconciles identically across all three seams for the same divergence', async () => {
      // The three seams each own a claim-shaped entry point, and each must
      // reconcile it the same way. Asserting them together — rather than one
      // case per seam — is what fails if a seam reconciles differently, skips
      // the reconciliation, or grows a fourth entry point that forgets it.
      // Divergence, and the no-bearer variant, must both refuse everywhere.
      // Arrange.
      const { claimA, claimB } = await activateTwoClaimedRuns();
      const divergent = { kind: 'claim_bearer', claimId: claimA } as const;
      const target = { kind: 'claim', claimId: claimB } as const;
      const expected = { kind: 'claim_bearer_mismatch' };

      // Act. Every seam runs for every evidence shape BEFORE anything is
      // asserted: interleaving act and assert would abort at the first
      // divergence and hide the very comparison this test exists to make. The
      // labels make the single diff below name which seam drifted.
      const outcomes: { readonly at: string; readonly outcome: unknown }[] = [];
      for (const [shape, evidence] of [
        ['divergent bearer', divergent],
        ['no bearer', DIRECT_CLI],
      ] as const) {
        outcomes.push({
          at: `${shape} → runTransition`,
          outcome: await seam.runTransition({
            command: 'pass',
            callerEvidence: evidence,
            targetSelector: target,
            terminalPolicy: RELEASE_POLICY,
          }),
        });
        outcomes.push({
          at: `${shape} → runTerminal`,
          outcome: await seam.runTerminal({
            command: 'complete',
            callerEvidence: evidence,
            targetSelector: target,
          }),
        });
        outcomes.push({
          at: `${shape} → resolveRunNavigation`,
          outcome: await seam.resolveRunNavigation({
            command: 'goto',
            callerEvidence: evidence,
            targetSelector: target,
          }),
        });
      }
      const finalA = await manager.load(runA);
      const finalB = await manager.load(runB);

      // Assert.
      expect(outcomes).toEqual([
        { at: 'divergent bearer → runTransition', outcome: expected },
        { at: 'divergent bearer → runTerminal', outcome: expected },
        { at: 'divergent bearer → resolveRunNavigation', outcome: expected },
        { at: 'no bearer → runTransition', outcome: expected },
        { at: 'no bearer → runTerminal', outcome: expected },
        { at: 'no bearer → resolveRunNavigation', outcome: expected },
      ]);
      // Six refusals, and neither run advanced or terminalized under any of them.
      expect(finalA?.step).toBe('1');
      expect(finalB?.step).toBe('1');
      expect(finalB?.lifecycle).toBe('running');
    });

    it('admits the matching bearer on all three seams, so the gate is not blanket refusal', async () => {
      // Anti-vacuity for the case above: if the gate refused every claim-shaped
      // target, the six refusals would prove nothing. Each seam must still
      // accept the claim whose bearer was actually presented.
      const { claimB } = await activateTwoClaimedRuns();
      const presented = { kind: 'claim_bearer', claimId: claimB } as const;
      const target = { kind: 'claim', claimId: claimB } as const;

      const navigation = await seam.resolveRunNavigation({
        command: 'goto',
        callerEvidence: presented,
        targetSelector: target,
      });
      expect(navigation.kind).toBe('allowed');

      const transition = await seam.runTransition({
        command: 'pass',
        callerEvidence: presented,
        targetSelector: target,
        terminalPolicy: RELEASE_POLICY,
      });
      expect(transition.kind).not.toBe('claim_bearer_mismatch');

      const terminal = await seam.runTerminal({
        command: 'complete',
        callerEvidence: presented,
        targetSelector: target,
      });
      expect(terminal.kind).not.toBe('claim_bearer_mismatch');
    });
  });

  describe('explicit --run targeting', () => {
    const namedRunId = assertRunId('rd_77777777777777777777777777777777');
    const topRunId = assertRunId('rd_88888888888888888888888888888888');
    const foreignRunId = assertRunId('rd_99999999999999999999999999999999');

    const twoSteps: ResolvedStep[] = [
      { kind: 'base', name: '1', description: 'one', transitions: tx('CONTINUE', 'STOP') },
      { kind: 'base', name: '2', description: 'two', transitions: tx('COMPLETE', 'STOP') },
    ];

    it('applies a run-targeted pass to the named run even when a different run is stack-top', async () => {
      loadStepsImpl = () => twoSteps;
      await activate(baseState({ id: namedRunId }));
      await activate(baseState({ id: topRunId, runbookPath: 'top.md' }));

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: runControlEvidence(namedRunId),
        targetSelector: { kind: 'run', runId: namedRunId },
        terminalPolicy: RELEASE_POLICY,
      });

      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      expect(outcome.runId).toBe(namedRunId);
      expect(outcome.updatedState?.step).toBe('2');
      // The stack-top run was untouched.
      const top = await manager.load(topRunId);
      expect(top?.step).toBe('1');
    });

    it('reports terminal when the prepared lifecycle is terminal but the snapshot is not', async () => {
      // INJECTED, not naturally reachable through this path: the snapshot below
      // is stubbed. `COMPLETE`/`STOPPED` are top-level `type: 'final'` states
      // whose entry actions assign `context.lifecycle`, so a real actor sets the
      // terminal value, the terminal status, and the context field together and
      // the two signals agree. (They DO diverge on the drain path — see
      // `deriveTerminalDrainObservationEvent` — which is why the reconciliation
      // exists at all.)
      //
      // What this pins is the seam's consistency invariant: the fenced release
      // fires on the persisted `lifecycle`, so the reported status must follow
      // the same signal. Were they ever to part, taking the status from the
      // observation alone would release the run from the session while telling
      // the caller execution continues — a released run the agent still drives.
      loadStepsImpl = () => twoSteps;
      await activate(baseState({ id: namedRunId }));

      const realPrepare = actorService.prepareActorMutation.bind(actorService);
      jest.spyOn(actorService, 'prepareActorMutation').mockImplementation(async (...args) => {
        const prepared = await realPrepare(...args);
        return {
          ...prepared,
          nextState: { ...prepared.nextState, lifecycle: 'completed' as const },
          snapshot: { status: 'active', value: 'COMPLETE' },
        };
      });

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: runControlEvidence(namedRunId),
        targetSelector: { kind: 'run', runId: namedRunId },
        terminalPolicy: RELEASE_POLICY,
      });

      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      // The release committed with the state, so the outcome must agree.
      expect(await manager.loadSession()).toEqual(
        expect.objectContaining({ defaultStack: expect.not.arrayContaining([namedRunId]) }),
      );
      expect(outcome.status).toBe('done');
      expect(outcome.events.map((event) => event.type)).toContain('RUNBOOK_COMPLETED');
    });

    it('refuses an unknown --run id with the typed unknown_run outcome', async () => {
      loadStepsImpl = () => twoSteps;
      await activate(baseState({ id: namedRunId }));

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: runControlEvidence(namedRunId),
        targetSelector: { kind: 'run', runId: foreignRunId },
        terminalPolicy: RELEASE_POLICY,
      });

      expect(outcome).toEqual({
        kind: 'unknown_run',
        runId: foreignRunId,
        message: `Run ${foreignRunId} is not part of this session's active stack.`,
      });
    });

    it('refuses a bare-shaped run-targeted advance over open claims', async () => {
      loadStepsImpl = () => twoSteps;
      const childRunId = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab');
      await activate(baseState({ id: namedRunId }));
      await manager.save(
        baseState({
          id: childRunId,
          runbookPath: 'child.md',
          parentLinkage: linkageFor(namedRunId, 'a'),
        }),
      );
      assertClaimed(
        await claimLiveDelegation(sessionService, manager, childRunId, linkageFor(namedRunId, 'a')),
      );

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: runControlEvidence(namedRunId),
        targetSelector: { kind: 'run', runId: namedRunId },
        terminalPolicy: RELEASE_POLICY,
      });

      expect(outcome.kind).toBe('open_delegated_children');
    });

    it('refuses a racing child claim through the in-transaction guard, without recovery', async () => {
      // Only the in-transaction guard can catch this interleaving (see
      // `raceChildClaimDuringActorPrepare`). That guard aborts the commit
      // transaction before its first UPDATE, so the run is provably untouched:
      // the caller gets the actionable refusal and the run is NOT parked in
      // recovery for a race that changed nothing.
      loadStepsImpl = () => twoSteps;
      const childRunId = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac');
      const linkage = linkageFor(namedRunId, 'a');
      await activate(baseState({ id: namedRunId }));
      await manager.save(
        baseState({ id: childRunId, runbookPath: 'child.md', parentLinkage: linkage }),
      );
      await seedLiveDelegation(manager, linkage);

      const racingClaim = raceChildClaimDuringActorPrepare(
        actorService,
        new SessionService(new RunbookStateManager(tmp)),
        childRunId,
        linkage,
      );

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: runControlEvidence(namedRunId),
        targetSelector: { kind: 'run', runId: namedRunId },
        terminalPolicy: RELEASE_POLICY,
      });

      expect(outcome.kind).toBe('open_delegated_children');
      expect(racingClaim()?.kind).toBe('committed');
      expect((await manager.load(namedRunId))?.step).toBe('1');
      // No recovery was recorded: a write-free refusal leaves the run usable.
      const store = await getRunbookStore(tmp);
      expect(await store.readPendingRecovery(namedRunId)).toBeNull();
    });

    it('commits substep recording and machine advancement as one fenced mutation', async () => {
      const substepSteps: ResolvedStep[] = [
        {
          kind: 'substeps',
          name: '1',
          description: 'Substeps',
          aggregation: { strategy: 'ALL' },
          substeps: [{ id: '1', description: 'one', transitions: tx('CONTINUE', 'STOP') }],
          transitions: tx('CONTINUE', 'STOP'),
        },
        { kind: 'base', name: '2', description: 'two', transitions: tx('COMPLETE', 'STOP') },
      ];
      loadStepsImpl = () => substepSteps;
      await activate(
        baseState({
          id: namedRunId,
          step: '1',
          stepName: 'Substeps',
          substep: '1',
          substepStates: [{ id: '1', frameKey: buildFrameKey('1'), status: 'running' }],
        }),
      );

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: runControlEvidence(namedRunId),
        targetSelector: { kind: 'run', runId: namedRunId },
        terminalPolicy: RELEASE_POLICY,
      });

      expect(outcome.kind).toBe('applied');
      const persisted = await manager.load(namedRunId);
      expect(persisted?.step).toBe('2');
      expect(persisted?.substep).toBeUndefined();
      expect(persisted?.resolvedCompletions).toEqual({});
    });

    it('mints a run-targeted delegation against the named run, not the stack top', async () => {
      const namedState = baseState({ id: namedRunId });
      await activate(namedState);
      const { seam: localSeam } = buildIssuanceSeam(namedState, [
        delegateStep('1', [delegateSubstep('1', 'child.md')]),
      ]);
      await activate(baseState({ id: topRunId, runbookPath: 'top.md' }));

      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(namedRunId),
        targetRunId: namedRunId,
      });

      expect(outcome.kind).toBe('delegated');
      if (outcome.kind !== 'delegated') return;
      expect(outcome.parentRunId).toBe(namedRunId);
    });

    it('refuses a delegation issuance naming a run outside the session stack', async () => {
      const namedState = baseState({ id: namedRunId });
      await activate(namedState);
      const { seam: localSeam } = buildIssuanceSeam(namedState, [
        delegateStep('1', [delegateSubstep('1', 'child.md')]),
      ]);

      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: runControlEvidence(namedRunId),
        targetRunId: foreignRunId,
      });

      expect(outcome).toEqual({
        kind: 'unknown_run',
        runId: foreignRunId,
        message: `Run ${foreignRunId} is not part of this session's active stack.`,
      });
    });

    it('forces the named run terminal via runTerminal --run', async () => {
      loadStepsImpl = () => twoSteps;
      await activate(baseState({ id: namedRunId }));
      await activate(baseState({ id: topRunId, runbookPath: 'top.md' }));

      const outcome = await seam.runTerminal({
        command: 'complete',
        callerEvidence: runControlEvidence(namedRunId),
        targetSelector: { kind: 'run', runId: namedRunId },
      });

      expect(outcome.kind).toBe('applied_bare');
      if (outcome.kind !== 'applied_bare') return;
      expect(outcome.rootRunId).toBe(namedRunId);
      const named = await manager.load(namedRunId);
      expect(named?.lifecycle).toBe('completed');
      const top = await manager.load(topRunId);
      expect(top?.lifecycle).toBe('running');
    });

    it('refuses runTerminal --run without bearer authority', async () => {
      loadStepsImpl = () => twoSteps;
      await activate(baseState({ id: namedRunId }));
      await activate(baseState({ id: topRunId, runbookPath: 'top.md' }));
      const sendSpy = jest.spyOn(actorService, 'sendAndSync');

      const outcome = await seam.runTerminal({
        command: 'stop',
        callerEvidence: DIRECT_CLI,
        targetSelector: { kind: 'run', runId: namedRunId },
      });

      expect(outcome).toEqual({ kind: 'actor_context_required' });
      expect(sendSpy).not.toHaveBeenCalled();
      expect((await manager.load(namedRunId))?.lifecycle).toBe('running');
    });

    it('forces the whole contiguous-inline chain when --run names an inline chain member', async () => {
      // The chain is one orchestrator's composition: naming the inline child
      // carries derived authority over the walked-to root (never ambient —
      // the root is reached by climbing inline linkage from the named run).
      loadStepsImpl = () => twoSteps;
      const rootId = assertRunId('rd_cccccccccccccccccccccccccccccccc');
      const childId = assertRunId('rd_dddddddddddddddddddddddddddddddd');
      await activate(baseState({ id: rootId }));
      await activate(
        baseState({
          id: childId,
          runbookPath: 'child.md',
          parentLinkage: {
            kind: 'inline',
            parentRunId: rootId,
            parentStepId: '1.1',
            parentStep: '1',
            parentFrameKey: buildFrameKey('1'),
            parentEntry: 1,
          },
        }),
      );

      const outcome = await seam.runTerminal({
        command: 'complete',
        callerEvidence: runControlEvidence(rootId),
        targetSelector: { kind: 'run', runId: childId },
      });

      expect(outcome.kind).toBe('applied_bare');
      if (outcome.kind !== 'applied_bare') return;
      expect(outcome.rootRunId).toBe(rootId);
      expect((await manager.load(childId))?.lifecycle).toBe('completed');
      expect((await manager.load(rootId))?.lifecycle).toBe('completed');
    });

    it('refuses runTerminal --run for an id outside the session stack', async () => {
      loadStepsImpl = () => twoSteps;
      await activate(baseState({ id: namedRunId }));

      const outcome = await seam.runTerminal({
        command: 'complete',
        callerEvidence: runControlEvidence(namedRunId),
        targetSelector: { kind: 'run', runId: foreignRunId },
      });

      expect(outcome).toEqual({
        kind: 'unknown_run',
        runId: foreignRunId,
        message: `Run ${foreignRunId} is not part of this session's active stack.`,
      });
    });
  });

  describe('claim-targeted open-children guard', () => {
    const parentRunId = assertRunId('rd_eeeeeeeeeeeeeeeeeeeeeeeeeeeeee10');
    const childRunId = assertRunId('rd_eeeeeeeeeeeeeeeeeeeeeeeeeeeeee11');

    const twoSteps: ResolvedStep[] = [
      { kind: 'base', name: '1', description: 'one', transitions: tx('CONTINUE', 'STOP') },
      { kind: 'base', name: '2', description: 'two', transitions: tx('COMPLETE', 'STOP') },
    ];

    it('refuses a racing child claim on the run-control claim arm', async () => {
      // Same race as the `--run` arm above, on the arm an orchestrator can
      // actually reach: pins that a run-control `--claim-id` transition routes
      // through the in-transaction guard rather than committing over the claim.
      loadStepsImpl = () => twoSteps;
      const linkage = linkageFor(parentRunId, 'a');
      await activate(baseState({ id: parentRunId }));
      await manager.save(
        baseState({ id: childRunId, runbookPath: 'child.md', parentLinkage: linkage }),
      );
      await seedLiveDelegation(manager, linkage);

      const evidence = runControlEvidence(parentRunId);
      if (evidence.kind !== 'claim_bearer') throw new Error('expected bearer evidence');

      const racingClaim = raceChildClaimDuringActorPrepare(
        actorService,
        new SessionService(new RunbookStateManager(tmp)),
        childRunId,
        linkage,
      );

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: evidence,
        targetSelector: { kind: 'claim', claimId: evidence.claimId },
        terminalPolicy: RELEASE_POLICY,
      });

      expect(racingClaim()?.kind).toBe('committed');
      expect(outcome.kind).toBe('open_delegated_children');
      // The guard aborts before the first UPDATE, so the parent never advanced
      // and the run is not parked in recovery — write-free, as on the `--run`
      // arm. Asserted here too because this is the arm the fix exists for.
      expect((await manager.load(parentRunId))?.step).toBe('1');
      const store = await getRunbookStore(tmp);
      expect(await store.readPendingRecovery(parentRunId)).toBeNull();
    });

    it('exempts a delegated-child bearer from the open-children guard', async () => {
      // Asserted as "the read is skipped" rather than "the read returns
      // nothing": the latter passes with or without the exemption and so pins
      // nothing. Why the exemption is sound is argued once, at
      // `guardOpenChildren`.
      loadStepsImpl = () => twoSteps;
      const linkage = linkageFor(parentRunId, 'a');
      await activate(baseState({ id: parentRunId }));
      await manager.save(
        baseState({ id: childRunId, runbookPath: 'child.md', parentLinkage: linkage }),
      );
      const claimed = assertClaimed(
        await claimLiveDelegation(sessionService, manager, childRunId, linkage),
      );
      const guardSpy = jest.spyOn(sessionService, 'runGuardedParentAdvance');

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: { kind: 'claim_bearer', claimId: claimed.claimId },
        targetSelector: { kind: 'claim', claimId: claimed.claimId },
        terminalPolicy: RELEASE_POLICY,
      });

      expect(outcome.kind).toBe('applied');
      expect(guardSpy).not.toHaveBeenCalled();
    });

    it('routes a bare advance through the guard seam', async () => {
      // The bare arm cannot itself reach an open-children refusal — a run with
      // delegated children is delegation-exposed, so a bare mutation is refused
      // ACTOR_CONTEXT_REQUIRED first — so the seam call is the only observable
      // property. Routing it through the guarded seam anyway keeps the
      // open-children and collection-pending checks a property of the seam
      // rather than something each caller has to remember.
      loadStepsImpl = () => twoSteps;
      await activate(baseState({ id: parentRunId }));
      const guardSpy = jest.spyOn(sessionService, 'runGuardedParentAdvance');

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: DIRECT_CLI,
        targetSelector: { kind: 'default' },
        terminalPolicy: RELEASE_POLICY,
      });

      expect(outcome.kind).toBe('applied');
      expect(guardSpy).toHaveBeenCalledWith(parentRunId, expect.any(Function));
    });
  });

  describe('resolveRunNavigation (goto seam)', () => {
    const twoSteps: ResolvedStep[] = [
      { kind: 'base', name: '1', description: 'one', transitions: tx('CONTINUE', 'STOP') },
      { kind: 'base', name: '2', description: 'two', transitions: tx('COMPLETE', 'STOP') },
    ];

    it('bumps the active entry exactly once for a navigation onto the occupied frame', async () => {
      // A GOTO onto the step the cursor already occupies is a real frame
      // re-entry, not a no-op: it resets the frame's substep rows, increments
      // `retryCount`, re-fires `__issue-delegations`, and declares
      // `frameReentry`. The machine's leaf entry action is the sole writer of
      // the ordinal, so the fence commits exactly one bump — the double-bump
      // this case was written to catch is prevented by that single writer, not
      // by suppressing the bump. `activeEntry` is what an inline launch intent
      // pins its `parentEntry` to, so a *second* bump here would make a
      // recovered intent stop matching its own child's linkage (RD
      // inline-child recovery); zero bumps would instead leave a delegation
      // `classifyDelegationLiveness` should have closed as `cursor-advanced`.
      loadStepsImpl = () => twoSteps;
      await activate(baseState({ id: runId }));
      const before = await manager.load(runId);
      const beforeEntry = before?.activeEntry ?? 1;

      const outcome = await seam.runNavigationMutation({
        runId,
        callerEvidence: runControlEvidence(runId),
        steps: twoSteps,
        target: { step: '1' },
        terminalReleaseMode: 'stack-pop',
      });

      expect(outcome.kind).toBe('applied');
      const after = await manager.load(runId);
      expect(after?.activeEntry).toBe(beforeEntry + 1);
      expect(after?.frameEntryCounts).toEqual({ '1|': beforeEntry + 1 });
    });

    it('captures bare authority for a navigation presented without a bearer', async () => {
      // `claimKeyFromBearer(input.callerEvidence.claimId)` reads a field only
      // the bearer variant carries, so forcing the keyed arm for non-bearer
      // evidence parses `undefined` as a claim id. Every other test on this
      // seam presents a bearer, which left the guard on that arm unobserved.
      // The counterpart of the `claim_superseded` witness below: that one pins
      // the key is threaded when there IS one, this one that it is not
      // fabricated when there is not.
      loadStepsImpl = () => twoSteps;
      await activate(baseState({ id: runId }));
      const store = await getRunbookStore(tmp);
      const keyedCapture = jest.spyOn(store, 'captureAuthorityState');

      const outcome = await seam.runNavigationMutation({
        runId,
        callerEvidence: DIRECT_CLI,
        steps: twoSteps,
        target: { step: '2' },
        terminalReleaseMode: 'stack-pop',
      });

      expect(outcome.kind).toBe('applied');
      expect(keyedCapture).not.toHaveBeenCalled();
      expect((await manager.load(runId))?.step).toBe('2');
    });

    it('allows bare navigation on a standalone run (stack-pop release)', async () => {
      loadStepsImpl = () => twoSteps;
      await activate(baseState());

      const outcome = await seam.resolveRunNavigation({
        command: 'goto',
        callerEvidence: runControlEvidence(runId),
        targetSelector: { kind: 'default' },
      });

      expect(outcome.kind).toBe('allowed');
      if (outcome.kind !== 'allowed') return;
      expect(outcome.runId).toBe(runId);
      expect(outcome.steps).toEqual(twoSteps);
      expect(outcome.terminalReleaseMode).toBe('stack-pop');
    });

    it('allows navigation when a bearer claim authorizes the run', async () => {
      loadStepsImpl = () => [delegateStep('1', [delegateSubstep('1', 'child.md')])];
      await activate(baseState());

      const outcome = await seam.resolveRunNavigation({
        command: 'goto',
        callerEvidence: runControlEvidence(runId),
        targetSelector: { kind: 'default' },
      });

      expect(outcome.kind).toBe('allowed');
      if (outcome.kind !== 'allowed') return;
      expect(outcome.delegationRuntime).toBeDefined();
      const runtime = outcome.delegationRuntime;
      if (runtime === undefined) return;
      const issued = runtime.issueDelegationCredential({
        parentRunId: runId,
        parentStepId: '1.1',
        parentFrameKey: buildFrameKey('1'),
        parentEntry: 1,
      });
      expect(runtime.deriveDelegationToken(issued.credential)).toBe(issued.token);
    });

    it('allows run-named navigation over the same delegation-exposed run', async () => {
      loadStepsImpl = () => [delegateStep('1', [delegateSubstep('1', 'child.md')])];
      await activate(baseState());

      const outcome = await seam.resolveRunNavigation({
        command: 'goto',
        callerEvidence: runControlEvidence(runId),
        targetSelector: { kind: 'run', runId },
      });

      expect(outcome.kind).toBe('allowed');
      if (outcome.kind !== 'allowed') return;
      expect(outcome.runId).toBe(runId);
    });

    it('refuses an unknown --run id with the shared unknown_run refusal', async () => {
      await activate(baseState());
      const foreign = assertRunId('rd_99999999999999999999999999999999');

      const outcome = await seam.resolveRunNavigation({
        command: 'goto',
        callerEvidence: runControlEvidence(runId),
        targetSelector: { kind: 'run', runId: foreign },
      });

      expect(outcome).toEqual({
        kind: 'unknown_run',
        runId: foreign,
        message: `Run ${foreign} is not part of this session's active stack.`,
      });
    });

    it('resolves a claim-targeted navigation to the claimed child with release-runbook', async () => {
      loadStepsImpl = () => twoSteps;
      await activate(baseState());
      const childRunId = assertRunId('rd_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
      await manager.save(
        baseState({
          id: childRunId,
          runbookPath: 'child.md',
          parentLinkage: linkageFor(runId, 'a'),
        }),
      );
      const claimed = assertClaimed(
        await claimLiveDelegation(sessionService, manager, childRunId, linkageFor(runId, 'a')),
      );

      // The claim is presented as evidence AND named as the target — the single
      // shape a `--claim-id` goto produces, and the only one #613 leaves
      // representable on a claim-shaped selector.
      const outcome = await seam.resolveRunNavigation({
        command: 'goto',
        callerEvidence: { kind: 'claim_bearer', claimId: claimed.claimId },
        targetSelector: { kind: 'claim', claimId: claimed.claimId },
      });

      expect(outcome.kind).toBe('allowed');
      if (outcome.kind !== 'allowed') return;
      expect(outcome.runId).toBe(childRunId);
      expect(outcome.terminalReleaseMode).toBe('release-runbook');
    });

    it('refuses a bearer retired inside the fenced navigation write, without recovery', async () => {
      // The interleave witness for #608 path 1. Both reads that precede the
      // decisive write see a LIVE bearer — `resolveRunNavigation` returns
      // `allowed`, and the fence's own authority capture returns `captured` —
      // and the claim is retired only after that capture returns. Nothing but
      // the claim re-validation inside the decisive write's transaction can
      // refuse from there, which is what makes this a sensitivity witness
      // rather than one more pre-check test: racing the retirement any earlier
      // is caught by the capture read, and a test that cannot tell those two
      // apart passes with the in-transaction re-read deleted.
      //
      // Retirement is committed by an independent `SessionService` on its own
      // manager — a second connection, exactly as the transition seam's witness
      // ("refuses a racing child claim through the in-transaction guard")
      // commits its racing claim.
      //
      // The capture is the last point a claim write on the TARGET can land:
      // from lease acquisition onward the run carries `exec_token`, and the
      // schema's `claims_guard_*` triggers abort any claim write against an
      // execution-owned run. So this window, not the compute window, is where a
      // navigation's authority can go stale.
      loadStepsImpl = () => twoSteps;
      await activate(baseState());
      const childRunId = assertRunId('rd_eeeeeeeeeeeeeeeeeeeeeeeeeeeeee20');
      const linkage = linkageFor(runId, 'a');
      await manager.save(
        baseState({ id: childRunId, runbookPath: 'child.md', parentLinkage: linkage }),
      );
      const claimed = assertClaimed(
        await claimLiveDelegation(sessionService, manager, childRunId, linkage),
      );
      const evidence: CallerEvidence = { kind: 'claim_bearer', claimId: claimed.claimId };

      const navigation = await seam.resolveRunNavigation({
        command: 'goto',
        callerEvidence: evidence,
        targetSelector: { kind: 'claim', claimId: claimed.claimId },
      });
      expect(navigation.kind).toBe('allowed');
      if (navigation.kind !== 'allowed') return;

      const store = await getRunbookStore(tmp);
      const retiring = new SessionService(new RunbookStateManager(tmp));
      const realCapture = store.captureAuthorityState.bind(store);
      let capturedKind: string | undefined;
      let retired: Awaited<ReturnType<SessionService['releaseRunbook']>> | undefined;
      jest.spyOn(store, 'captureAuthorityState').mockImplementation(async (...args) => {
        const captured = await realCapture(...args);
        capturedKind ??= captured.kind;
        retired ??= await retiring.releaseRunbook(childRunId);
        return captured;
      });

      const outcome = await seam.runNavigationMutation({
        runId: childRunId,
        callerEvidence: evidence,
        steps: navigation.steps,
        target: { step: '2' },
        terminalReleaseMode: navigation.terminalReleaseMode,
      });

      // The authority the write would be validated against was live when read.
      expect(capturedKind).toBe('captured');
      expect(retired?.kind).toBe('committed');
      // Asserted by message, not by kind alone: the re-read refuses on two
      // independent arms — the claim row's own status, and the
      // `claim_generation` CAS — and a retirement trips both, so `kind` alone
      // cannot say which one fired. The message names the arm.
      expect(outcome).toEqual({
        kind: 'claim_superseded',
        runId: childRunId,
        message: `The presented claim no longer controls run ${childRunId}.`,
      });
      // Write-free: the guard refuses before the first UPDATE, so the run never
      // moved and is not parked in recovery for a race that changed nothing.
      expect((await manager.load(childRunId))?.step).toBe('1');
      expect(await store.readPendingRecovery(childRunId)).toBeNull();
    });

    it('commits a run-targeted navigation over a racing child claim and retires it', async () => {
      // The counterpart, at the same fence point the transition seam's witness
      // uses — and the opposite outcome. #702 proposed racing a CHILD claim into
      // the goto window on the model of `runTransition`'s witness; it cannot
      // refuse here, by design twice over.
      //
      // First, navigation is exempt from the open-claims guard on purpose (see
      // `resolveRunNavigation`) — it is operator control flow, not completion —
      // so `runNavigationMutation` threads no `ParentAdvanceGuard` into the
      // commit and there is no seam for `open_delegated_children` to come from.
      // Second, even the fence cannot see it: `claimRunbook` writes only the
      // child's claim row, and `claims_bump_gen_insert` bumps the CHILD's
      // `claim_generation`, so every value the parent's CAS compares is
      // unchanged.
      //
      // Pinned as an allowance rather than left unstated: arming a guard here is
      // a decision about what `goto` means, not a defect fix, and this is the
      // test that makes someone make it. But the allowance is NOT symmetric —
      // see the post-write assertions: the navigation commits AND revokes the
      // racing bearer.
      loadStepsImpl = () => twoSteps;
      const childRunId = assertRunId('rd_eeeeeeeeeeeeeeeeeeeeeeeeeeeeee21');
      const linkage = linkageFor(runId, 'a');
      await activate(baseState());
      await manager.save(
        baseState({ id: childRunId, runbookPath: 'child.md', parentLinkage: linkage }),
      );
      await seedLiveDelegation(manager, linkage);

      const navigation = await seam.resolveRunNavigation({
        command: 'goto',
        callerEvidence: runControlEvidence(runId),
        targetSelector: { kind: 'run', runId },
      });
      expect(navigation.kind).toBe('allowed');
      if (navigation.kind !== 'allowed') return;

      const claimant = new SessionService(new RunbookStateManager(tmp));
      const realPrepare = actorService.prepareActorMutation.bind(actorService);
      let claimResult: Awaited<ReturnType<SessionService['claimRunbook']>> | undefined;
      jest.spyOn(actorService, 'prepareActorMutation').mockImplementation(async (...args) => {
        claimResult ??= await claimant.claimRunbook(childRunId, linkage);
        return realPrepare(...args);
      });

      const outcome = await seam.runNavigationMutation({
        runId,
        callerEvidence: runControlEvidence(runId),
        steps: navigation.steps,
        target: { step: '2' },
        terminalReleaseMode: navigation.terminalReleaseMode,
      });

      expect(claimResult?.kind).toBe('committed');
      expect(outcome.kind).toBe('applied');
      expect((await manager.load(runId))?.step).toBe('2');

      // The allowance is ONE-sided, and the `applied` outcome hides the other
      // half: the racing bearer does NOT survive. The decisive write's own
      // transaction retires it. `afterAuthoritativeStateWrite` runs
      // `invalidateClosedDelegatedClaims` — the parent half of R2's two-sided
      // durable latch — right after the run UPDATE, and classifies every active
      // claim naming this parent against the COMMITTED parent state, whose
      // cursor has just left the delegating step. `classifyDelegationLiveness`
      // therefore reads `closed`/`cursor-advanced` and tombstones the row in the
      // same transaction that let the navigation through.
      //
      // So goto does not merely proceed past an open child: it revokes the
      // child's authority. Only WHICH write collects the tombstone is timing-
      // dependent — a claim committing after this transaction opens is missed
      // here and superseded by the next authoritative parent write, with the
      // claim-side half of the latch refusing its use meanwhile. The bearer
      // never regains authority either way.
      if (claimResult === undefined) throw new Error('expected the racing claim to have run');
      const raced = assertClaimed(unwrapSessionMutation(claimResult));
      const store = await getRunbookStore(tmp);
      expect((await store.loadClaim(claimKeyFromBearer(raced.claimId)))?.status).toBe('superseded');
      // Read through the bearer as a caller would, not just off the row:
      // `loadSession` surfaces active claims only, so the tombstone is what makes
      // verification report the bearer missing rather than verified.
      expect((await sessionService.verifyClaimId(raced.claimId)).status).toBe('missing');
    });
  });

  describe('top-level transition drive', () => {
    it('applies a PASS CONTINUE and instructs the loop to continue', async () => {
      const steps: ResolvedStep[] = [
        { kind: 'base', name: '1', description: 'one', transitions: tx('CONTINUE', 'STOP') },
        { kind: 'base', name: '2', description: 'two', transitions: tx('COMPLETE', 'STOP') },
      ];
      loadStepsImpl = () => steps;
      await activate(baseState());
      const fenced = jest.spyOn(actorMutationRunner, 'run');

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: runControlEvidence(runId),
        targetSelector: { kind: 'default' },
        terminalPolicy: RELEASE_POLICY,
      });

      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      expect(outcome.status).toBe('continue');
      expect(outcome.terminalReleaseMode).toBe('stack-pop');
      expect(outcome.loop).toEqual({ kind: 'run', prompted: false });
      expect(outcome.events.some((e) => e.type === 'STEP_TRANSITIONED')).toBe(true);
      expect(outcome.updatedState?.step).toBe('2');
      expect(fenced).toHaveBeenCalledTimes(1);
    });

    it('applies a PASS COMPLETE as a terminal done with no loop', async () => {
      const steps: ResolvedStep[] = [
        { kind: 'base', name: '1', description: 'one', transitions: tx('COMPLETE', 'STOP') },
      ];
      loadStepsImpl = () => steps;
      await activate(baseState());

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: runControlEvidence(runId),
        targetSelector: { kind: 'default' },
        terminalPolicy: RELEASE_POLICY,
      });

      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      expect(outcome.status).toBe('done');
      expect(outcome.loop).toEqual({ kind: 'none' });
      expect(outcome.events.some((e) => e.type === 'RUNBOOK_COMPLETED')).toBe(true);
    });

    it('drives FAIL through the fail handler distinctly from PASS', async () => {
      // pass -> STOP, fail -> CONTINUE: only the FAIL mapping advances, so a
      // continue + persisted `fail` proves the command drove the fail handler
      // rather than silently reusing the pass path.
      const steps: ResolvedStep[] = [
        { kind: 'base', name: '1', description: 'one', transitions: tx('STOP', 'CONTINUE') },
        { kind: 'base', name: '2', description: 'two', transitions: tx('COMPLETE', 'STOP') },
      ];
      loadStepsImpl = () => steps;
      await activate(baseState());
      const fenced = jest.spyOn(actorMutationRunner, 'run');

      const outcome = await seam.runTransition({
        command: 'fail',
        callerEvidence: runControlEvidence(runId),
        targetSelector: { kind: 'default' },
        terminalPolicy: RELEASE_POLICY,
      });

      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      expect(outcome.status).toBe('continue');
      expect(outcome.loop).toEqual({ kind: 'run', prompted: false });
      expect(outcome.events.some((e) => e.type === 'STEP_TRANSITIONED')).toBe(true);
      expect(outcome.updatedState?.step).toBe('2');

      const persisted = await manager.load(runId);
      expect(persisted?.step).toBe('2');
      expect(persisted?.lastResult).toBe('fail');
      expect(fenced).toHaveBeenCalledTimes(1);
    });

    it('threads computeActionResult into the top-level observation', async () => {
      // The DISPLAY result is policy the caller supplies; the PERSISTED result is
      // the command. A `fail` whose callback returns true must project PASS while
      // still persisting `fail` — asserting both is what separates "the callback
      // was threaded" from "the command was misread".
      loadStepsImpl = () => [
        { kind: 'base', name: '1', description: 'one', transitions: tx('STOP', 'CONTINUE') },
        { kind: 'base', name: '2', description: 'two', transitions: tx('COMPLETE', 'STOP') },
      ];
      await activate(baseState());

      const outcome = await seam.runTransition({
        command: 'fail',
        callerEvidence: runControlEvidence(runId),
        targetSelector: { kind: 'default' },
        terminalPolicy: RELEASE_POLICY,
        computeActionResult: () => true,
      });

      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      const transitioned = outcome.events.find((e) => e.type === 'STEP_TRANSITIONED');
      expect(transitioned?.payload).toMatchObject({ result: 'PASS' });
      expect((await manager.load(runId))?.lastResult).toBe('fail');
    });

    it('validates a top-level transition against the PRESENTED claim, not the current one', async () => {
      // The fenced mutation is capture-keyed by the presented bearer. Drop that
      // key and the runner falls back to `captureRunAuthorityState`, which
      // resolves whatever claim CURRENTLY controls the run — so a bearer that
      // went stale between authorization and capture would be silently upgraded
      // to whatever authority replaced it.
      //
      // `retireDuringCapture` is what makes the difference observable: the seam
      // it spies is reached ONLY on the keyed path, so retiring the claim from
      // inside it both opens the race and witnesses that the key was used.
      // Modelled on the goto seam's witness, at the same fence point.
      const steps: ResolvedStep[] = [
        { kind: 'base', name: '1', description: 'one', transitions: tx('CONTINUE', 'STOP') },
        { kind: 'base', name: '2', description: 'two', transitions: tx('COMPLETE', 'STOP') },
      ];
      loadStepsImpl = () => steps;
      await activate(baseState());
      const childRunId = assertRunId('rd_eeeeeeeeeeeeeeeeeeeeeeeeeeeeee31');
      const linkage = linkageFor(runId, 'a');
      await manager.save(
        baseState({ id: childRunId, runbookPath: 'child.md', parentLinkage: linkage }),
      );
      const claimed = assertClaimed(
        await claimLiveDelegation(sessionService, manager, childRunId, linkage),
      );
      const evidence: CallerEvidence = { kind: 'claim_bearer', claimId: claimed.claimId };

      const capturedRunIds = retireDuringCapture(
        await getRunbookStore(tmp),
        new SessionService(new RunbookStateManager(tmp)),
        childRunId,
      );

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: evidence,
        targetSelector: { kind: 'claim', claimId: claimed.claimId },
        terminalPolicy: RELEASE_POLICY,
      });

      // The keyed capture is the arm under test: if the spread is dropped this
      // never runs, the retirement never lands, and the transition commits.
      expect(capturedRunIds()).toEqual([childRunId]);
      expect(outcome.kind).toBe('claim_superseded');
      // Write-free: the run never left step 1.
      expect((await manager.load(childRunId))?.step).toBe('1');
    });
  });

  /**
   * Automatic issuance requires VERIFIED RUN-CONTROL authority — the
   * `delegate-from-run` grant on the run being advanced — not merely the
   * `mutate-run` grant that authorized the transition itself. These tests are
   * deliberately written against runs with NO delegation parent linkage, so
   * they observe the authority gate structurally rather than through RD-819:
   * the nested-delegation prohibition would refuse a delegated child before the
   * issuer was ever exercised, which is why the weaker gate has never been
   * exploitable — and exactly why the pin must not depend on it.
   */
  describe('verified issuer reaches the machine on every transition path', () => {
    // Three seams forward the verified issuer as the `runtime` argument to
    // `prepareActorMutation`, and that argument is the ONLY route it takes to
    // `delegationIssueActor`. Replacing the object literal with `{}` drives the
    // machine with no authority to mint, so a transition landing on a DELEGATE
    // frontier refuses `actor_context_required` and stops the run — for a
    // caller that HELD the authority. The literal survived mutation at every
    // site; nothing pinned the hand-off.
    //
    // These assert at the machine boundary rather than by driving issuance to
    // completion. Machine-owned issuance is covered by the compiler and
    // actor-service suites, and reproducing its full input here (resolver,
    // artifact roots, seeded RunId) would test that path a third time rather
    // than the thing that was untested: whether THIS seam hands the issuer
    // across. The issuer is exercised, not merely counted — a forwarded value
    // that cannot mint fails the same assertion an absent one does.
    const stepsLandingOnDelegate: ResolvedStep[] = [
      { kind: 'base', name: '1', description: 'one', transitions: tx('CONTINUE', 'STOP') },
      delegateStep('2', [delegateSubstep('1', 'child.md')]),
    ];

    /**
     * Capture the `runtime` argument every `prepareActorMutation` call receives.
     *
     * @returns Accessor for the captured runtime arguments, in call order.
     */
    function captureRuntimeArgs(): () => ReadonlyArray<
      { readonly issueDelegationCredential?: DelegationCredentialIssuer } | undefined
    > {
      const seen: Array<
        { readonly issueDelegationCredential?: DelegationCredentialIssuer } | undefined
      > = [];
      const real = actorService.prepareActorMutation.bind(actorService);
      jest
        .spyOn(actorService, 'prepareActorMutation')
        .mockImplementation(async (id, previous, steps, event, runtime) => {
          seen.push(runtime);
          return await real(id, previous, steps, event, runtime);
        });
      return () => seen;
    }

    /**
     * Assert a forwarded runtime carries an issuer that actually mints.
     *
     * @param runtime - The runtime argument the seam handed to the machine.
     */
    function expectWorkingIssuer(
      runtime: { readonly issueDelegationCredential?: DelegationCredentialIssuer } | undefined,
    ): void {
      const issue = runtime?.issueDelegationCredential;
      expect(issue).toBeDefined();
      if (!issue) return;
      const issued = issue({
        parentRunId: runId,
        parentStepId: '2.1',
        parentFrameKey: buildFrameKey('2'),
        parentEntry: 1,
      });
      expect(issued.token).toMatch(/^rdtk_/);
      expect(issued.credential.issuerClaimKey).toBeDefined();
    }

    it('forwards a working issuer through a pass/fail transition', async () => {
      loadStepsImpl = () => stepsLandingOnDelegate;
      await activate(baseState());
      const runtimeArgs = captureRuntimeArgs();

      await seam.runTransition({
        command: 'pass',
        callerEvidence: runControlEvidence(runId),
        targetSelector: { kind: 'default' },
        terminalPolicy: RELEASE_POLICY,
      });

      const seen = runtimeArgs();
      expect(seen.length).toBeGreaterThan(0);
      expectWorkingIssuer(seen.at(-1));
    });

    it('forwards a working issuer through a GOTO', async () => {
      loadStepsImpl = () => stepsLandingOnDelegate;
      await activate(baseState());

      const allowed = await seam.resolveRunNavigation({
        command: 'goto',
        callerEvidence: runControlEvidence(runId),
        targetSelector: { kind: 'default' },
      });
      expect(allowed.kind).toBe('allowed');
      if (allowed.kind !== 'allowed') return;
      expect(allowed.delegationRuntime).toBeDefined();
      const runtimeArgs = captureRuntimeArgs();

      await seam.runNavigationMutation({
        runId,
        callerEvidence: runControlEvidence(runId),
        steps: stepsLandingOnDelegate,
        target: { step: '2' },
        terminalReleaseMode: allowed.terminalReleaseMode,
        ...(allowed.delegationRuntime === undefined
          ? {}
          : { issueDelegationCredential: allowed.delegationRuntime.issueDelegationCredential }),
      });

      const seen = runtimeArgs();
      expect(seen.length).toBeGreaterThan(0);
      expectWorkingIssuer(seen.at(-1));
    });

    it('forwards a working issuer through the substep completion drain', async () => {
      // The third site: `#driveSubstepFenced` records the explicit substep
      // completion and then DRAINS, and each drained apply is its own
      // `prepareActorMutation`. That apply can advance the cursor onto a
      // DELEGATE frontier just as a top-level transition can, so it needs the
      // issuer for the same reason.
      const substepSteps: ResolvedStep[] = [
        {
          kind: 'substeps',
          name: '1',
          description: 'Substeps',
          aggregation: { strategy: 'ALL' },
          substeps: [
            { id: '1', description: 'A', transitions: tx('CONTINUE', 'STOP') },
            { id: '2', description: 'B', transitions: tx('CONTINUE', 'STOP') },
          ],
          transitions: tx('CONTINUE', 'STOP'),
        },
        delegateStep('2', [delegateSubstep('1', 'child.md')]),
      ];
      loadStepsImpl = () => substepSteps;
      await activate(
        baseState({
          step: '1',
          stepName: 'Substeps',
          substep: '1',
          substepStates: [{ id: '1', frameKey: buildFrameKey('1'), status: 'running' }],
        }),
      );
      const runtimeArgs = captureRuntimeArgs();

      await seam.runTransition({
        command: 'pass',
        callerEvidence: runControlEvidence(runId),
        targetSelector: { kind: 'explicit-step', step: '1.1' },
        terminalPolicy: RELEASE_POLICY,
        explicitTarget: { stepId: '1.1' },
      });

      const seen = runtimeArgs();
      expect(seen.length).toBeGreaterThan(0);
      expectWorkingIssuer(seen.at(-1));
    });
  });

  describe('delegation runtime authority', () => {
    const twoSteps: ResolvedStep[] = [
      { kind: 'base', name: '1', description: 'one', transitions: tx('CONTINUE', 'STOP') },
      { kind: 'base', name: '2', description: 'two', transitions: tx('COMPLETE', 'STOP') },
    ];

    /** Strip one grant action from the run's persisted run-control claim. */
    async function revokeGrant(claimId: ClaimId, action: string): Promise<void> {
      const claimKey = claimKeyFromBearer(claimId);
      const session = await manager.loadSession();
      await patchPersistedClaim(tmp, claimKey, {
        grants: session.claims[claimKey].grants.filter((grant) => grant.action !== action),
      });
    }

    it('carries the delegation runtime for a bearer holding delegate-from-run', async () => {
      loadStepsImpl = () => twoSteps;
      await activate(baseState());

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: runControlEvidence(runId),
        targetSelector: { kind: 'default' },
        terminalPolicy: RELEASE_POLICY,
      });

      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      expect(outcome.delegationRuntime).toBeDefined();
      expect(outcome.delegationRuntime?.issueDelegationCredential).toBeDefined();
      expect(outcome.delegationRuntime?.deriveDelegationToken).toBeDefined();
    });

    it('withholds the delegation runtime from a transition bearer without delegate-from-run', async () => {
      loadStepsImpl = () => twoSteps;
      await activate(baseState());
      const evidence = runControlEvidence(runId);
      if (evidence.kind !== 'claim_bearer') throw new Error('expected bearer evidence');
      await revokeGrant(evidence.claimId, 'delegate-from-run');

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: evidence,
        targetSelector: { kind: 'default' },
        terminalPolicy: RELEASE_POLICY,
      });

      // `mutate-run` still authorizes the advance itself, so the transition
      // applies; only the issuance capability is withheld.
      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      expect(outcome.updatedState?.step).toBe('2');
      expect(outcome.delegationRuntime).toBeUndefined();
    });

    it('carries the delegation runtime for a navigation bearer holding delegate-from-run', async () => {
      loadStepsImpl = () => twoSteps;
      await activate(baseState());

      const outcome = await seam.resolveRunNavigation({
        command: 'goto',
        callerEvidence: runControlEvidence(runId),
        targetSelector: { kind: 'default' },
      });

      expect(outcome.kind).toBe('allowed');
      if (outcome.kind !== 'allowed') return;
      expect(outcome.delegationRuntime).toBeDefined();
      expect(outcome.delegationRuntime?.issueDelegationCredential).toBeDefined();
      expect(outcome.delegationRuntime?.deriveDelegationToken).toBeDefined();
    });

    it('withholds the delegation runtime from a navigation bearer without delegate-from-run', async () => {
      loadStepsImpl = () => twoSteps;
      await activate(baseState());
      const evidence = runControlEvidence(runId);
      if (evidence.kind !== 'claim_bearer') throw new Error('expected bearer evidence');
      await revokeGrant(evidence.claimId, 'delegate-from-run');

      const outcome = await seam.resolveRunNavigation({
        command: 'goto',
        callerEvidence: evidence,
        targetSelector: { kind: 'default' },
      });

      expect(outcome.kind).toBe('allowed');
      if (outcome.kind !== 'allowed') return;
      expect(outcome.delegationRuntime).toBeUndefined();
    });
  });

  describe('terminal release side effects', () => {
    // Top-level terminal release is projected inside the fenced owned-state
    // commit. These tests pin that no follow-on SessionService write occurs and
    // that the durable session projection follows the per-status policy.

    it('releases the runbook with retainClaimsAsTerminal on a terminal done (onComplete branch)', async () => {
      const steps: ResolvedStep[] = [
        { kind: 'base', name: '1', description: 'one', transitions: tx('COMPLETE', 'STOP') },
      ];
      loadStepsImpl = () => steps;
      await activate(baseState());
      const releaseSpy = jest.spyOn(sessionService, 'releaseRunbook');
      const fenced = jest.spyOn(actorMutationRunner, 'run');

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: runControlEvidence(runId),
        targetSelector: { kind: 'default' },
        terminalPolicy: RELEASE_POLICY,
      });

      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      expect(outcome.status).toBe('done');
      expect(releaseSpy).not.toHaveBeenCalled();
      expect(await sessionService.getActive()).toBeNull();
      expect(fenced).toHaveBeenCalledWith(
        expect.objectContaining({
          terminalRelease: {
            onComplete: true,
            onStopped: true,
            retainClaimsAsTerminal: true,
          },
        }),
      );
    });

    it('releases the runbook with retainClaimsAsTerminal on a terminal stopped (onStopped branch)', async () => {
      const steps: ResolvedStep[] = [
        { kind: 'base', name: '1', description: 'one', transitions: tx('STOP', 'STOP') },
      ];
      loadStepsImpl = () => steps;
      await activate(baseState());
      const releaseSpy = jest.spyOn(sessionService, 'releaseRunbook');
      const fenced = jest.spyOn(actorMutationRunner, 'run');

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: runControlEvidence(runId),
        targetSelector: { kind: 'default' },
        terminalPolicy: RELEASE_POLICY,
      });

      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      expect(outcome.status).toBe('stopped');
      expect(releaseSpy).not.toHaveBeenCalled();
      expect(await sessionService.getActive()).toBeNull();
      expect(fenced).toHaveBeenCalledWith(
        expect.objectContaining({
          terminalRelease: {
            onComplete: true,
            onStopped: true,
            retainClaimsAsTerminal: true,
          },
        }),
      );
    });

    it('does not release a terminal done when onComplete opts out (releaseRunbook: false)', async () => {
      // Split policy: `done` reads `onComplete` (false here) and must NOT release,
      // even though `onStopped` is true — proving `done` routes through its own
      // branch rather than reading `onStopped`.
      const policy: LifecycleTerminalReleasePolicy = {
        onComplete: { releaseRunbook: false },
        onStopped: { releaseRunbook: true },
      };
      const steps: ResolvedStep[] = [
        { kind: 'base', name: '1', description: 'one', transitions: tx('COMPLETE', 'STOP') },
      ];
      loadStepsImpl = () => steps;
      await activate(baseState());
      const releaseSpy = jest.spyOn(sessionService, 'releaseRunbook');

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: runControlEvidence(runId),
        targetSelector: { kind: 'default' },
        terminalPolicy: policy,
      });

      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      expect(outcome.status).toBe('done');
      expect(releaseSpy).not.toHaveBeenCalled();
    });

    it('does not release a terminal stopped when onStopped opts out (releaseRunbook: false)', async () => {
      // Mirror of the done opt-out: `stopped` reads `onStopped` (false here) and
      // must NOT release, even though `onComplete` is true — proving `stopped`
      // routes through its own branch rather than reading `onComplete`.
      const policy: LifecycleTerminalReleasePolicy = {
        onComplete: { releaseRunbook: true },
        onStopped: { releaseRunbook: false },
      };
      const steps: ResolvedStep[] = [
        { kind: 'base', name: '1', description: 'one', transitions: tx('STOP', 'STOP') },
      ];
      loadStepsImpl = () => steps;
      await activate(baseState());
      const releaseSpy = jest.spyOn(sessionService, 'releaseRunbook');

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: runControlEvidence(runId),
        targetSelector: { kind: 'default' },
        terminalPolicy: policy,
      });

      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      expect(outcome.status).toBe('stopped');
      expect(releaseSpy).not.toHaveBeenCalled();
    });
  });

  describe('manual substep completion drive', () => {
    it('records a bare substep completion and drains it', async () => {
      const steps: ResolvedStep[] = [
        {
          kind: 'substeps',
          name: '1',
          description: 'Substeps',
          aggregation: { strategy: 'ALL' },
          substeps: [{ id: '1', description: 'A', transitions: tx('CONTINUE', 'STOP') }],
          transitions: tx('CONTINUE', 'STOP'),
        },
        { kind: 'base', name: '2', description: 'two', transitions: tx('COMPLETE', 'STOP') },
      ];
      loadStepsImpl = () => steps;
      await activate(
        baseState({
          step: '1',
          stepName: 'Substeps',
          substep: '1',
          substepStates: [{ id: '1', frameKey: buildFrameKey('1'), status: 'running' }],
        }),
      );

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: runControlEvidence(runId),
        targetSelector: { kind: 'default' },
        terminalPolicy: RELEASE_POLICY,
      });

      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      expect(outcome.status).toBe('continue');
      expect(outcome.events.some((e) => e.type === 'STEP_TRANSITIONED')).toBe(true);
      // Pin that the drain actually advanced out of the substep rather than
      // leaving the cursor parked on substep 1.
      expect(outcome.updatedState?.step).toBe('2');
      expect(outcome.updatedState?.substep).toBeUndefined();

      const persisted = await manager.load(runId);
      expect(persisted?.step).toBe('2');
      expect(persisted?.substep).toBeUndefined();
    });

    it('threads computeActionResult into the substep drain observation', async () => {
      // The substep drain builds its own observation, separately from the
      // top-level drive, so the callback has to be threaded twice and can be
      // dropped from either. Inverted the other way here — a `pass` whose
      // callback returns false — so the assertion cannot pass by coincidence of
      // sharing the previous test's direction.
      const steps: ResolvedStep[] = [
        {
          kind: 'substeps',
          name: '1',
          description: 'Substeps',
          aggregation: { strategy: 'ALL' },
          substeps: [{ id: '1', description: 'A', transitions: tx('CONTINUE', 'STOP') }],
          transitions: tx('CONTINUE', 'STOP'),
        },
        { kind: 'base', name: '2', description: 'two', transitions: tx('COMPLETE', 'STOP') },
      ];
      loadStepsImpl = () => steps;
      await activate(
        baseState({
          step: '1',
          stepName: 'Substeps',
          substep: '1',
          substepStates: [{ id: '1', frameKey: buildFrameKey('1'), status: 'running' }],
        }),
      );

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: runControlEvidence(runId),
        targetSelector: { kind: 'default' },
        terminalPolicy: RELEASE_POLICY,
        computeActionResult: () => false,
      });

      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      const transitioned = outcome.events.find((e) => e.type === 'STEP_TRANSITIONED');
      expect(transitioned?.payload).toMatchObject({ result: 'FAIL' });
      // The drain still advanced: only the projection was overridden.
      expect(outcome.updatedState?.step).toBe('2');
    });

    it('validates a substep completion against the PRESENTED claim, not the current one', async () => {
      // The substep fence builds its own `actorMutationRunner.run` description
      // with its own copy of the capture key, so the top-level witness does not
      // cover it. Same mechanism, same fence point: `captureAuthorityState` is
      // reached only when the key is threaded.
      const steps: ResolvedStep[] = [
        {
          kind: 'substeps',
          name: '1',
          description: 'Substeps',
          aggregation: { strategy: 'ALL' },
          substeps: [{ id: '1', description: 'A', transitions: tx('CONTINUE', 'STOP') }],
          transitions: tx('CONTINUE', 'STOP'),
        },
        { kind: 'base', name: '2', description: 'two', transitions: tx('COMPLETE', 'STOP') },
      ];
      loadStepsImpl = () => steps;
      await activate(baseState());
      const childRunId = assertRunId('rd_eeeeeeeeeeeeeeeeeeeeeeeeeeeeee32');
      const linkage = linkageFor(runId, 'a');
      await manager.save(
        baseState({
          id: childRunId,
          runbookPath: 'child.md',
          parentLinkage: linkage,
          step: '1',
          stepName: 'Substeps',
          substep: '1',
          substepStates: [{ id: '1', frameKey: buildFrameKey('1'), status: 'running' }],
        }),
      );
      const claimed = assertClaimed(
        await claimLiveDelegation(sessionService, manager, childRunId, linkage),
      );
      const evidence: CallerEvidence = { kind: 'claim_bearer', claimId: claimed.claimId };

      const capturedRunIds = retireDuringCapture(
        await getRunbookStore(tmp),
        new SessionService(new RunbookStateManager(tmp)),
        childRunId,
      );

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: evidence,
        targetSelector: { kind: 'claim', claimId: claimed.claimId },
        terminalPolicy: RELEASE_POLICY,
      });

      expect(capturedRunIds()).toEqual([childRunId]);
      expect(outcome.kind).toBe('claim_superseded');
      expect((await manager.load(childRunId))?.substep).toBe('1');
    });

    it('captures bare authority for a substep drive presented without a bearer', async () => {
      // The other direction of the same spread, and the one the witness above
      // cannot reach: `claimKeyFromBearer(input.callerEvidence.claimId)` reads a
      // field only the bearer variant of CallerEvidence carries, so forcing the
      // keyed arm for non-bearer evidence parses `undefined` as a claim id.
      // Every other test on this seam presents a bearer, which left the arm
      // unobserved — a bare drive must resolve the run's own controlling claim
      // through `captureRunAuthorityState` and never touch the keyed capture.
      const steps: ResolvedStep[] = [
        {
          kind: 'substeps',
          name: '1',
          description: 'Substeps',
          aggregation: { strategy: 'ALL' },
          substeps: [{ id: '1', description: 'A', transitions: tx('CONTINUE', 'STOP') }],
          transitions: tx('CONTINUE', 'STOP'),
        },
        { kind: 'base', name: '2', description: 'two', transitions: tx('COMPLETE', 'STOP') },
      ];
      loadStepsImpl = () => steps;
      await activate(
        baseState({
          step: '1',
          stepName: 'Substeps',
          substep: '1',
          substepStates: [{ id: '1', frameKey: buildFrameKey('1'), status: 'running' }],
        }),
      );
      const store = await getRunbookStore(tmp);
      const keyedCapture = jest.spyOn(store, 'captureAuthorityState');

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: DIRECT_CLI,
        targetSelector: { kind: 'default' },
        terminalPolicy: RELEASE_POLICY,
      });

      expect(outcome.kind).toBe('applied');
      expect(keyedCapture).not.toHaveBeenCalled();
      expect((await manager.load(runId))?.step).toBe('2');
    });

    it('refuses a racing child claim through the substep fence in-transaction guard', async () => {
      // The substep fence builds its own `actorMutationRunner.run` description
      // with its own copy of the guard spread, so a guard dropped HERE is
      // invisible to every witness in `claim-targeted open-children guard` —
      // all of them drive the top-level arm. Same fence point and same race:
      // the claim commits inside `prepareActorMutation`, past every pre-check,
      // so only the in-transaction guard can catch it.
      const steps: ResolvedStep[] = [
        {
          kind: 'substeps',
          name: '1',
          description: 'Substeps',
          aggregation: { strategy: 'ALL' },
          substeps: [
            { id: '1', description: 'A', transitions: tx('CONTINUE', 'STOP') },
            { id: '2', description: 'B', transitions: tx('CONTINUE', 'STOP') },
          ],
          transitions: tx('CONTINUE', 'STOP'),
        },
        { kind: 'base', name: '2', description: 'two', transitions: tx('COMPLETE', 'STOP') },
      ];
      loadStepsImpl = () => steps;
      const childRunId = assertRunId('rd_eeeeeeeeeeeeeeeeeeeeeeeeeeeeee33');
      // The delegation occupies substep '2' so `seedLiveDelegation`'s substep
      // upsert leaves the active substep '1' — the one being completed — alone.
      const linkage = linkageFor(runId, 'a', '2');
      await activate(
        baseState({
          step: '1',
          stepName: 'Substeps',
          substep: '1',
          substepStates: [
            { id: '1', frameKey: buildFrameKey('1'), status: 'running' },
            { id: '2', frameKey: buildFrameKey('1'), status: 'running' },
          ],
        }),
      );
      await manager.save(
        baseState({ id: childRunId, runbookPath: 'child.md', parentLinkage: linkage }),
      );
      await seedLiveDelegation(manager, linkage);

      const racingClaim = raceChildClaimDuringActorPrepare(
        actorService,
        new SessionService(new RunbookStateManager(tmp)),
        childRunId,
        linkage,
      );

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: runControlEvidence(runId),
        targetSelector: { kind: 'default' },
        terminalPolicy: RELEASE_POLICY,
      });

      expect(racingClaim()?.kind).toBe('committed');
      expect(outcome.kind).toBe('open_delegated_children');
      // Write-free, as on the top-level arm: the guard aborts the commit before
      // its first UPDATE, so no completion row landed and the cursor never moved.
      const persisted = await manager.load(runId);
      expect(persisted?.substep).toBe('1');
      expect(Object.keys(persisted?.resolvedCompletions ?? {})).toEqual([]);
    });

    it('treats an explicit cursor for an already-advanced sibling substep as an idempotent duplicate (no orphan row)', async () => {
      // TOCTOU within the same active frame: the frontend resolved `--step 1.1`
      // against a snapshot where substep '1' was active, but the run advanced to
      // sibling substep '2' (frame key + entry unchanged) before the seam ran.
      // The explicit cursor's active frame still matches the run's active frame,
      // so the frame guard does not fire; the completion-service duplicate guard
      // (substep '1' already `done`) makes this a graceful no-op rather than an
      // orphaned resolved-completion / premature `done` write.
      const steps: ResolvedStep[] = [
        {
          kind: 'substeps',
          name: '1',
          description: 'Substeps',
          aggregation: { strategy: 'ALL' },
          substeps: [
            { id: '1', description: 'A', transitions: tx('CONTINUE', 'STOP') },
            { id: '2', description: 'B', transitions: tx('CONTINUE', 'STOP') },
          ],
          transitions: tx('CONTINUE', 'STOP'),
        },
        { kind: 'base', name: '2', description: 'two', transitions: tx('COMPLETE', 'STOP') },
      ];
      loadStepsImpl = () => steps;
      await activate(
        baseState({
          step: '1',
          stepName: 'Substeps',
          substep: '2',
          substepStates: [
            { id: '1', frameKey: buildFrameKey('1'), status: 'done', result: 'pass' },
            { id: '2', frameKey: buildFrameKey('1'), status: 'running' },
          ],
        }),
      );

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: runControlEvidence(runId),
        targetSelector: { kind: 'explicit-step', step: '1.1' },
        terminalPolicy: RELEASE_POLICY,
        explicitTarget: { stepId: '1.1' },
      });

      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      // Idempotent: surfaced as already-resolved, not an advance.
      expect(outcome.duplicate?.at).toBe('1.1');
      expect(outcome.updatedState).toBeUndefined();

      // No orphan row was written and the run did not move.
      const persisted = await manager.load(runId);
      expect(Object.keys(persisted?.resolvedCompletions ?? {})).toEqual([]);
      expect(persisted?.substep).toBe('2');
      expect(persisted?.substepStates).toEqual([
        { id: '1', frameKey: buildFrameKey('1'), status: 'done', result: 'pass' },
        { id: '2', frameKey: buildFrameKey('1'), status: 'running' },
      ]);
    });

    it('emits a terminal event when the drain reaches terminal but the completion observation did not', async () => {
      // Divergence the seam must handle: `drainResolvedCompletions` derives
      // terminal from the applied completion's `state.lifecycle`, while
      // `deriveTransitionObservation` derives it from the XState snapshot's
      // top-level status/value. Force the drain to report `done` for an applied
      // completion whose snapshot is still active — the per-completion
      // observation returns `continue` (STEP_TRANSITIONED only), so the seam must
      // emit RUNBOOK_COMPLETED from the drain's authoritative status. Without the
      // fix the run is released but the outcome carries no terminal envelope.
      const steps: ResolvedStep[] = [
        {
          kind: 'substeps',
          name: '1',
          description: 'Substeps',
          aggregation: { strategy: 'ALL' },
          substeps: [{ id: '1', description: 'A', transitions: tx('CONTINUE', 'STOP') }],
          transitions: tx('CONTINUE', 'STOP'),
        },
      ];
      loadStepsImpl = () => steps;
      const activeState = baseState({
        step: '1',
        stepName: 'Substeps',
        substep: '1',
        substepStates: [{ id: '1', frameKey: buildFrameKey('1'), status: 'running' }],
      });
      await activate(activeState);

      // Record succeeds; the divergence lives entirely in the drain result.
      jest
        .spyOn(completionService, 'recordManualCompletion')
        .mockResolvedValue({ status: 'recorded', key: 'k' });

      const built = buildResolvedCompletion({
        agentId: 'manual',
        result: 'pass',
        targetStep: '1',
        targetSubstep: '1',
        targetFrame: activeFrame(buildFrameKey('1'), 1),
        completedAt: '2026-06-28T00:00:00.000Z',
      });
      // `buildResolvedCompletion` widens `targetSubstep` to `string | undefined`;
      // re-narrow it (the value is known) so the branded-current-cursor helper,
      // which requires a concrete `targetSubstep`, accepts it without a cast.
      const terminalCompletion = brandCurrentCursorResolvedCompletionForTest({
        ...built,
        targetSubstep: built.targetSubstep ?? '1',
      });
      jest.spyOn(completionService, 'drainResolvedCompletions').mockResolvedValue({
        status: 'done',
        unresolved: 0,
        applied: [
          {
            key: 'k',
            completion: terminalCompletion,
            stateBefore: activeState,
            // Terminal via `state.lifecycle` only — the snapshot stays active so
            // `deriveTransitionObservation` reports `continue`.
            stateAfter: { ...activeState, lifecycle: 'completed' },
            snapshot: { status: 'active', value: '1' },
          },
        ],
      });

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: runControlEvidence(runId),
        targetSelector: { kind: 'default' },
        terminalPolicy: RELEASE_POLICY,
      });

      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      expect(outcome.status).toBe('done');
      expect(outcome.loop).toEqual({ kind: 'none' });
      // The STEP_TRANSITIONED from the continue observation AND the terminal
      // envelope derived from the drain's authoritative status.
      expect(outcome.events.some((e) => e.type === 'STEP_TRANSITIONED')).toBe(true);
      expect(outcome.events.some((e) => e.type === 'RUNBOOK_COMPLETED')).toBe(true);
    });

    it('emits a terminal stopped event when the drain reaches stopped but the completion observation did not', async () => {
      // The `stopped` mirror of the `done` divergence above. The drain reports
      // `stopped` (derived from the applied completion's `state.lifecycle`) for an
      // applied completion whose snapshot is still active, so the per-completion
      // observation returns `continue` (STEP_TRANSITIONED only). The seam must emit
      // RUNBOOK_STOPPED from the drain's authoritative status via
      // `deriveTerminalDrainObservationEvent` and apply the seam-owned terminal
      // release through the `onStopped` branch.
      const steps: ResolvedStep[] = [
        {
          kind: 'substeps',
          name: '1',
          description: 'Substeps',
          aggregation: { strategy: 'ALL' },
          substeps: [{ id: '1', description: 'A', transitions: tx('CONTINUE', 'STOP') }],
          transitions: tx('CONTINUE', 'STOP'),
        },
      ];
      loadStepsImpl = () => steps;
      const activeState = baseState({
        step: '1',
        stepName: 'Substeps',
        substep: '1',
        substepStates: [{ id: '1', frameKey: buildFrameKey('1'), status: 'running' }],
      });
      await activate(activeState);

      // Record succeeds; the divergence lives entirely in the drain result.
      jest
        .spyOn(completionService, 'recordManualCompletion')
        .mockResolvedValue({ status: 'recorded', key: 'k' });

      const built = buildResolvedCompletion({
        agentId: 'manual',
        result: 'fail',
        targetStep: '1',
        targetSubstep: '1',
        targetFrame: activeFrame(buildFrameKey('1'), 1),
        completedAt: '2026-06-28T00:00:00.000Z',
      });
      // `buildResolvedCompletion` widens `targetSubstep` to `string | undefined`;
      // re-narrow it (the value is known) so the branded-current-cursor helper,
      // which requires a concrete `targetSubstep`, accepts it without a cast.
      const terminalCompletion = brandCurrentCursorResolvedCompletionForTest({
        ...built,
        targetSubstep: built.targetSubstep ?? '1',
      });
      jest.spyOn(completionService, 'drainResolvedCompletions').mockResolvedValue({
        status: 'stopped',
        unresolved: 0,
        applied: [
          {
            key: 'k',
            completion: terminalCompletion,
            stateBefore: activeState,
            // Terminal via `state.lifecycle` only — the snapshot stays active so
            // `deriveTransitionObservation` reports `continue`.
            stateAfter: { ...activeState, lifecycle: 'stopped' },
            snapshot: { status: 'active', value: '1' },
          },
        ],
      });

      const outcome = await seam.runTransition({
        command: 'fail',
        callerEvidence: runControlEvidence(runId),
        targetSelector: { kind: 'default' },
        terminalPolicy: RELEASE_POLICY,
      });

      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      expect(outcome.status).toBe('stopped');
      expect(outcome.loop).toEqual({ kind: 'none' });
      // The STEP_TRANSITIONED from the continue observation AND the stopped
      // terminal envelope derived from the drain's authoritative status.
      expect(outcome.events.some((e) => e.type === 'STEP_TRANSITIONED')).toBe(true);
      expect(outcome.events.some((e) => e.type === 'RUNBOOK_STOPPED')).toBe(true);
      // Terminal state and session release are one owned-store commit.
      expect((await manager.load(runId))?.lifecycle).toBe('stopped');
      expect(await sessionService.getActive()).toBeNull();
    });
  });

  describe('fenced explicit-target substep completion', () => {
    const fencedSteps: ResolvedStep[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Substeps',
        aggregation: { strategy: 'ALL' },
        substeps: [
          { id: '1', description: 'one', transitions: tx('CONTINUE', 'STOP') },
          { id: '2', description: 'two', transitions: tx('CONTINUE', 'STOP') },
        ],
        transitions: tx('CONTINUE', 'STOP'),
      },
      { kind: 'base', name: '2', description: 'done', transitions: tx('COMPLETE', 'STOP') },
    ];

    beforeEach(() => {
      loadStepsImpl = () => fencedSteps;
    });

    it('drains the exact current-entry completion before an older completion on the same frame', async () => {
      const frameKey = buildFrameKey('1');
      const staleKey = buildCompletionKey(activeFrame(frameKey, 1), '1');
      await activate(
        baseState({
          step: '1',
          stepName: 'Substeps',
          substep: '1',
          substepStates: [{ id: '1', frameKey, status: 'running' }],
          frameEntryCounts: { [frameKey]: 2 },
          activeFrameKey: frameKey,
          activeEntry: 2,
          resolvedCompletions: {
            [staleKey]: buildResolvedCompletion({
              agentId: 'manual',
              result: 'pass',
              targetStep: '1',
              targetSubstep: '1',
              targetFrame: activeFrame(frameKey, 1),
              completedAt: '2026-06-27T00:00:00.000Z',
            }),
          },
        }),
      );

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: runControlEvidence(runId),
        targetSelector: { kind: 'explicit-step', step: '1.1' },
        terminalPolicy: RELEASE_POLICY,
        explicitTarget: { stepId: '1.1' },
      });

      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      expect(outcome.updatedState?.substep).toBe('2');
      const persisted = await manager.load(runId);
      expect(persisted?.substep).toBe('2');
      // The old row remains historical evidence; only the exact entry-2 row was
      // selected and consumed by this transition.
      expect(persisted?.resolvedCompletions?.[staleKey]?.targetEntry).toBe(1);
    });

    it('allows exactly one concurrent owner and leaves no orphaned completion row', async () => {
      await activate(
        baseState({
          step: '1',
          stepName: 'Substeps',
          substep: '1',
          substepStates: [{ id: '1', frameKey: buildFrameKey('1'), status: 'running' }],
        }),
      );

      const transition = () =>
        seam.runTransition({
          command: 'pass',
          callerEvidence: runControlEvidence(runId),
          targetSelector: { kind: 'explicit-step', step: '1.1' },
          terminalPolicy: RELEASE_POLICY,
          explicitTarget: { stepId: '1.1' },
        });
      const outcomes = await Promise.all([transition(), transition()]);

      expect(outcomes.filter(({ kind }) => kind === 'applied')).toHaveLength(1);
      expect(outcomes.filter(({ kind }) => kind === 'execution_in_progress')).toHaveLength(1);
      const persisted = await manager.load(runId);
      expect(Object.keys(persisted?.resolvedCompletions ?? {})).toEqual([]);
      expect(persisted?.substep).toBe('2');
    });

    it('commits terminal session release with the terminal run state', async () => {
      loadStepsImpl = () => [
        {
          kind: 'substeps',
          name: '1',
          description: 'Substeps',
          aggregation: { strategy: 'ALL' },
          substeps: [{ id: '1', description: 'one', transitions: tx('COMPLETE', 'STOP') }],
          transitions: tx('COMPLETE', 'STOP'),
        },
      ];
      await activate(
        baseState({
          step: '1',
          stepName: 'Substeps',
          substep: '1',
          substepStates: [{ id: '1', frameKey: buildFrameKey('1'), status: 'running' }],
        }),
      );

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: runControlEvidence(runId),
        targetSelector: { kind: 'explicit-step', step: '1.1' },
        terminalPolicy: RELEASE_POLICY,
        explicitTarget: { stepId: '1.1' },
      });

      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      expect(outcome.status).toBe('done');
      expect((await manager.load(runId))?.lifecycle).toBe('completed');
      expect(await sessionService.getActive()).toBeNull();
    });
  });

  describe('bare inline-child reactivation', () => {
    const childRunId = assertRunId('rd_22222222222222222222222222222222');

    const inlineSteps: ResolvedStep[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Substeps',
        aggregation: { strategy: 'ALL' },
        substeps: [{ id: '1', description: 'A', transitions: tx('CONTINUE', 'STOP') }],
        transitions: tx('CONTINUE', 'STOP'),
      },
      { kind: 'base', name: '2', description: 'two', transitions: tx('COMPLETE', 'STOP') },
    ];

    beforeEach(() => {
      loadStepsImpl = () => inlineSteps;
    });

    // Parent parked at substep 1 whose substep state is running with inline-child
    // launch metadata. `withInline` lets a test drop the inline metadata to model
    // "no running inline child" while keeping the running substep.
    function parentAtSubstep(withInline = true): RunbookState {
      const frameKey = buildFrameKey('1');
      const parent = baseState({
        step: '1',
        stepName: 'Substeps',
        substep: '1',
        activeFrameKey: frameKey,
        activeEntry: 1,
      });
      const inline: NonNullable<SubstepState['inline']> = {
        childRunbookPath: 'child.runbook.md',
        childRunbookRef: { source: 'project', path: 'child.runbook.md' },
        contextSnapshot: buildContextSnapshot(parent, '1'),
        childRunId,
        createdAt: '2026-06-28T00:00:00.000Z',
        startedAt: '2026-06-28T00:00:01.000Z',
      };
      const substepState: SubstepState = {
        id: '1',
        frameKey,
        status: 'running',
        ...(withInline ? { inline } : {}),
      };
      return { ...parent, substepStates: [substepState] };
    }

    // Running inline child whose linkage matches the parent cursor by default.
    function childState(linkage: Partial<InlineLinkage> = {}): RunbookState {
      return baseState({
        id: childRunId,
        runbook: { source: 'project', path: 'child.runbook.md' },
        runbookPath: 'child.runbook.md',
        lifecycle: 'running',
        parentLinkage: {
          kind: 'inline',
          parentRunId: runId,
          parentStep: '1',
          parentStepId: '1',
          parentFrameKey: buildFrameKey('1'),
          parentEntry: 1,
          ...linkage,
        },
      });
    }

    it('resumes the running inline child instead of recording a completion', async () => {
      await manager.save(childState());
      await activate(parentAtSubstep());

      const pushSpy = jest.spyOn(sessionService, 'pushRunbook');
      const recordSpy = jest.spyOn(completionService, 'prepareManualCompletion');

      const outcome = await seam.runTransition({
        command: 'pass',
        // The parent carries an inline substep record (clause f), so the
        // reactivation subject needs named authority post-flip.
        callerEvidence: runControlEvidence(runId),
        targetSelector: { kind: 'default' },
        terminalPolicy: RELEASE_POLICY,
      });

      // No manual completion recorded; the parent did not change; the child is
      // now the active run.
      expect(outcome).toEqual({
        kind: 'applied',
        runId,
        mutation: 'manual-completion',
        terminalReleaseMode: 'stack-pop',
        status: 'continue',
        events: [],
        loop: { kind: 'none' },
      });
      expect(pushSpy).toHaveBeenCalledTimes(1);
      expect(pushSpy).toHaveBeenCalledWith(childRunId);
      expect(recordSpy).not.toHaveBeenCalled();
    });

    it('records a completion when there is no running inline child', async () => {
      await activate(parentAtSubstep(false));

      const recordSpy = jest.spyOn(completionService, 'prepareManualCompletion');

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: runControlEvidence(runId),
        targetSelector: { kind: 'default' },
        terminalPolicy: RELEASE_POLICY,
      });

      expect(recordSpy).toHaveBeenCalledTimes(1);
      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      expect(outcome.updatedState?.step).toBe('2');
    });

    it('does not reactivate a child whose linkage does not match the parent cursor', async () => {
      // Linkage points at a different parent entry, so it is not the inline child
      // of this cursor: the seam must record, not reactivate.
      await manager.save(childState({ parentEntry: 2 }));
      await activate(parentAtSubstep());

      const pushSpy = jest.spyOn(sessionService, 'pushRunbook');
      await seam.runTransition({
        command: 'pass',
        callerEvidence: runControlEvidence(runId),
        targetSelector: { kind: 'default' },
        terminalPolicy: RELEASE_POLICY,
      });

      expect(pushSpy).not.toHaveBeenCalledWith(childRunId);
    });

    it('never reactivates on the explicit --step path (always records)', async () => {
      await manager.save(childState());
      await activate(parentAtSubstep());

      const pushSpy = jest.spyOn(sessionService, 'pushRunbook');
      await seam.runTransition({
        command: 'pass',
        callerEvidence: runControlEvidence(runId),
        targetSelector: { kind: 'explicit-step', step: '1.1' },
        terminalPolicy: RELEASE_POLICY,
        explicitTarget: { stepId: '1.1' },
      });

      expect(pushSpy).not.toHaveBeenCalledWith(childRunId);
    });
  });

  describe('single-resolution loadSteps', () => {
    it('derives steps exactly once from the resolved active state', async () => {
      const steps: ResolvedStep[] = [
        { kind: 'base', name: '1', description: 'one', transitions: tx('CONTINUE', 'STOP') },
        { kind: 'base', name: '2', description: 'two', transitions: tx('COMPLETE', 'STOP') },
      ];
      loadStepsImpl = () => steps;
      await activate(baseState());

      await seam.runTransition({
        command: 'pass',
        // The orchestrator drives with its run-control bearer claim; this branch
        // pins the drive-side single-resolution property.
        callerEvidence: runControlEvidence(runId),
        targetSelector: { kind: 'default' },
        terminalPolicy: RELEASE_POLICY,
      });

      // The seam resolves the target once and derives steps once from that
      // resolved state — the observable proxy for single resolution.
      expect(loadStepsArgs).toHaveLength(1);
      expect(loadStepsArgs[0]?.id).toBe(runId);
    });

    it('derives steps for the claimed child run, not the active default', async () => {
      const parentRunId = assertRunId('rd_44444444444444444444444444444444');
      const claimChildRunId = assertRunId('rd_33333333333333333333333333333333');
      const childSteps: ResolvedStep[] = [
        { kind: 'base', name: '1', description: 'child one', transitions: tx('COMPLETE', 'STOP') },
      ];
      loadStepsImpl = () => childSteps;

      await manager.save(baseState({ id: parentRunId }));
      await sessionService.pushRunbook(parentRunId);
      await manager.save(
        baseState({
          id: claimChildRunId,
          runbook: { source: 'project', path: 'claim-child.md' },
          runbookPath: 'claim-child.md',
          parentLinkage: linkageFor(parentRunId, 'a'),
        }),
      );
      const claimed = assertClaimed(
        await claimLiveDelegation(
          sessionService,
          manager,
          claimChildRunId,
          linkageFor(parentRunId, 'a'),
        ),
      );

      await seam.runTransition({
        command: 'pass',
        callerEvidence: {
          kind: 'claim_bearer',
          claimId: claimed.claimId,
        },
        targetSelector: { kind: 'claim', claimId: claimed.claimId },
        terminalPolicy: RELEASE_POLICY,
      });

      // loadSteps saw the resolved claimed child, not the active default parent.
      expect(loadStepsArgs).toHaveLength(1);
      expect(loadStepsArgs[0]?.id).toBe(claimChildRunId);
    });

    it('returns claim_grant_required when a claimed child lacks mutate-run grant', async () => {
      const parentRunId = assertRunId('rd_44444444444444444444444444444444');
      const claimChildRunId = assertRunId('rd_33333333333333333333333333333333');
      await manager.save(baseState({ id: parentRunId }));
      await sessionService.pushRunbook(parentRunId);
      await manager.save(
        baseState({
          id: claimChildRunId,
          runbook: { source: 'project', path: 'claim-child.md' },
          runbookPath: 'claim-child.md',
          parentLinkage: linkageFor(parentRunId, 'a'),
        }),
      );
      const claimed = assertClaimed(
        await claimLiveDelegation(
          sessionService,
          manager,
          claimChildRunId,
          linkageFor(parentRunId, 'a'),
        ),
      );
      const session = await manager.loadSession();
      const claimKey = claimKeyFromBearer(claimed.claimId);
      const claim = session.claims[claimKey];
      await patchPersistedClaim(manager.cwd, claimKey, {
        lastSeenAt: '2020-01-01T00:00:00.000Z',
        grants: claim.grants.filter((grant) => grant.action !== 'mutate-run'),
      });

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: {
          kind: 'claim_bearer',
          claimId: claimed.claimId,
        },
        targetSelector: { kind: 'claim', claimId: claimed.claimId },
        terminalPolicy: RELEASE_POLICY,
      });

      expect(outcome).toEqual({
        kind: 'claim_grant_required',
        claimId: claimed.claimId,
        runId: claimChildRunId,
      });
      expect((await manager.loadSession()).claims[claimKey].lastSeenAt).toBe(
        '2020-01-01T00:00:00.000Z',
      );
    });

    it('returns claim_grant_required when a run-targeted bearer lacks mutate-run grant', async () => {
      const targetRunId = assertRunId('rd_12121212121212121212121212121212');
      await manager.save(baseState({ id: targetRunId }));
      await sessionService.pushRunbook(targetRunId);
      await issueRunControlClaimFor(targetRunId);
      const evidence = runControlEvidence(targetRunId);
      if (evidence.kind !== 'claim_bearer') throw new Error('expected bearer evidence');
      const claimKey = claimKeyFromBearer(evidence.claimId);
      const session = await manager.loadSession();
      const claim = session.claims[claimKey];
      await patchPersistedClaim(manager.cwd, claimKey, {
        grants: claim.grants.filter((grant) => grant.action !== 'mutate-run'),
      });

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: evidence,
        targetSelector: { kind: 'run', runId: targetRunId },
        terminalPolicy: RELEASE_POLICY,
      });

      expect(outcome).toEqual({
        kind: 'claim_grant_required',
        claimId: evidence.claimId,
        runId: targetRunId,
      });
    });
  });

  describe('runTerminal', () => {
    /**
     * Flatten a claim-path terminal outcome's observation events.
     *
     * @param outcome - Outcome returned by `runTerminal`.
     * @returns The observation events the claim path surfaced.
     * @throws {Error} When the outcome is not `applied_claim`.
     */
    function claimEvents(outcome: LifecycleTerminalOutcome): readonly TransitionObservationEvent[] {
      if (outcome.kind !== 'applied_claim') {
        throw new Error(`expected applied_claim, got ${outcome.kind}`);
      }
      return outcome.events;
    }

    /**
     * Flatten a bare-path terminal outcome's observation events.
     *
     * The bare cascade tags each event with the run it came from, so unwrap to
     * the same shape the claim path returns and both assertions can be read
     * side by side.
     *
     * @param outcome - Outcome returned by `runTerminal`.
     * @returns The observation events, stripped of their run tagging.
     * @throws {Error} When the outcome is not `applied_bare`.
     */
    function bareEvents(outcome: LifecycleTerminalOutcome): readonly TransitionObservationEvent[] {
      if (outcome.kind !== 'applied_bare') {
        throw new Error(`expected applied_bare, got ${outcome.kind}`);
      }
      return outcome.events.map((tagged) => tagged.event);
    }

    /**
     * The single `STEP_TRANSITIONED` observation in an event list.
     *
     * @param events - Observation events from a terminal outcome.
     * @returns The step-transition event, or undefined when none was emitted.
     */
    function stepTransition(
      events: readonly TransitionObservationEvent[],
    ): TransitionObservationEvent | undefined {
      return events.find((event) => event.type === 'STEP_TRANSITIONED');
    }

    it('rejects an explicit-step selector', async () => {
      await expect(
        seam.runTerminal({
          command: 'complete',
          callerEvidence: DIRECT_CLI,
          targetSelector: { kind: 'explicit-step', step: '1.1' },
        }),
      ).rejects.toThrow(/do not support --step/);
    });

    it('refuses a bare complete/stop on a delegation-exposed run', async () => {
      // A run carrying a *delegation* parent linkage is delegation-exposed even
      // with zero open child claims and no pending outcomes, so bare `complete`/
      // `stop` MUST refuse without named authority. Regression guard: the terminal
      // path previously skipped the delegation-exposure gate, so a bare direct-CLI
      // `complete`/`stop` could force a delegation-exposed run terminal without a
      // `--claim-id`. The gate consults the delegation axis of
      // classifyDelegationExposureDetail (covered exhaustively, including the
      // inline-composition axis that must NOT gate terminal-force, in
      // delegation-exposure.test.ts; the bare inline-chain force stays allowed —
      // see the complete/stop inline-ancestor CLI integration tests).
      // A valid single-step graph so the pre-fix drive reaches (and mutates) the
      // run rather than throwing on step lookup — isolating the missing gate.
      loadStepsImpl = () => [
        { kind: 'base', name: '1', description: 'one', transitions: tx('CONTINUE', 'STOP') },
      ];
      const parentRunId = assertRunId('rd_77777777777777777777777777777777');
      await activate(baseState({ parentLinkage: linkageFor(parentRunId, 'a') }));

      // Twin (pass) pins that the state is genuinely delegation-exposed.
      const bareAdvance = await seam.runTransition({
        command: 'pass',
        callerEvidence: DIRECT_CLI,
        targetSelector: { kind: 'default' },
        terminalPolicy: RELEASE_POLICY,
      });
      expect(bareAdvance).toEqual({ kind: 'actor_context_required' });

      const bareComplete = await seam.runTerminal({
        command: 'complete',
        callerEvidence: DIRECT_CLI,
        targetSelector: { kind: 'default' },
      });
      expect(bareComplete).toEqual({ kind: 'actor_context_required' });

      const bareStop = await seam.runTerminal({
        command: 'stop',
        callerEvidence: DIRECT_CLI,
        targetSelector: { kind: 'default' },
      });
      expect(bareStop).toEqual({ kind: 'actor_context_required' });

      // The run stays running — neither terminal command mutated it.
      expect((await manager.load(runId))?.lifecycle).toBe('running');
    });

    describe('claim path', () => {
      const claimParentRunId = assertRunId('rd_55555555555555555555555555555555');
      const claimChildRunId = assertRunId('rd_66666666666666666666666666666666');

      // Stand up a running parent + claimed child, then optionally overwrite the
      // child to a terminal tombstone lifecycle (claimRunbook refuses claiming a
      // terminal child, so the claim must land while the child is still running).
      async function setupClaim(childLifecycle: RunbookState['lifecycle']) {
        const stampedLinkage = linkageFor(claimParentRunId, 'a');
        await manager.save(
          baseState({
            id: claimParentRunId,
          }),
        );
        await sessionService.pushRunbook(claimParentRunId);
        await issueRunControlClaimFor(claimParentRunId);
        const childBase = {
          id: claimChildRunId,
          runbook: { source: 'project', path: 'claim-child.md' } as const,
          runbookPath: 'claim-child.md',
          parentLinkage: stampedLinkage,
        };
        await manager.save(baseState(childBase));
        const claimed = assertClaimed(
          await claimLiveDelegation(sessionService, manager, claimChildRunId, stampedLinkage),
        );
        if (childLifecycle !== 'running') {
          await manager.save(baseState({ ...childBase, lifecycle: childLifecycle }));
        }
        return claimed.claimId;
      }

      /**
       * Caller evidence for a claim-targeted terminal.
       *
       * A `--claim-id` target is named BY its bearer, so the frontend presents
       * that same bearer as evidence — the only shape #613 leaves representable
       * on a claim-shaped selector, and exactly what `runSeamTerminal` builds.
       *
       * @param claimId - The bearer naming the claim-shaped target.
       * @returns Bearer caller evidence for that claim.
       */
      function presentedBy(claimId: ClaimId): CallerEvidence {
        return { kind: 'claim_bearer', claimId };
      }

      it('forwards a stale_claim for a non-existent claim without dispatching', async () => {
        // A claim id that was never claimed resolves as `missing` in the resolver,
        // which the seam forwards as `stale_claim`. Pins the wiring branch and that
        // no FORCE is dispatched for an unresolved claim target.
        const missingClaimId = assertClaimId(
          'rdclm_00000000000000000000000000000000_abcdefghijklmnopqrstuvwxyzABCDE1234567890-_',
        );
        const sendSpy = jest.spyOn(actorService, 'sendAndSync');
        const out = await seam.runTerminal({
          command: 'complete',
          callerEvidence: presentedBy(missingClaimId),
          targetSelector: { kind: 'claim', claimId: missingClaimId },
        });
        expect(out).toMatchObject({ kind: 'stale_claim', claimId: missingClaimId });
        expect(sendSpy).not.toHaveBeenCalled();
      });

      it('claim complete on a completed child confirms and retains the tombstone', async () => {
        const claimId = await setupClaim('completed');
        const releaseSpy = jest.spyOn(sessionService, 'releaseRunbook');
        const out = await seam.runTerminal({
          command: 'complete',
          callerEvidence: presentedBy(claimId),
          targetSelector: { kind: 'claim', claimId },
        });
        expect(out.kind).toBe('terminal_claim_confirmed');
        // Idempotent path STILL releases with retain (item 4, second site).
        expect(releaseSpy).toHaveBeenCalledWith(claimChildRunId, { retainClaimsAsTerminal: true });
      });

      it('claim complete on a stopped child conflicts (no FORCE, still retains)', async () => {
        const claimId = await setupClaim('stopped');
        const sendSpy = jest.spyOn(actorService, 'sendAndSync');
        const releaseSpy = jest.spyOn(sessionService, 'releaseRunbook');
        const out = await seam.runTerminal({
          command: 'complete',
          callerEvidence: presentedBy(claimId),
          targetSelector: { kind: 'claim', claimId },
        });
        expect(out.kind).toBe('terminal_claim_conflict');
        expect(sendSpy).not.toHaveBeenCalled();
        expect(releaseSpy).toHaveBeenCalledWith(claimChildRunId, { retainClaimsAsTerminal: true });
      });

      it('claim stop atomically forces, reports, and releases the running child', async () => {
        const claimId = await setupClaim('running');
        loadStepsImpl = () => [
          {
            kind: 'base',
            name: '1',
            description: 'child one',
            transitions: tx('COMPLETE', 'STOP'),
          },
        ];
        const aggregate = jest.spyOn(actorMutationRunner, 'runAll');
        const releaseSpy = jest.spyOn(sessionService, 'releaseRunbook');
        const out = await seam.runTerminal({
          command: 'stop',
          callerEvidence: presentedBy(claimId),
          targetSelector: { kind: 'claim', claimId },
        });
        expect(out).toMatchObject({ kind: 'applied_claim', status: 'stopped' });
        expect(aggregate).toHaveBeenCalledTimes(1);
        expect((await manager.load(claimChildRunId))?.lifecycle).toBe('stopped');
        expect(
          Object.keys((await manager.load(claimParentRunId))?.resolvedCompletions ?? {}),
        ).toHaveLength(1);
        expect(releaseSpy).not.toHaveBeenCalled();
      });

      it('routes a claim without a delegation linkage through the bare inline cascade', async () => {
        // A claim carrying no delegation linkage is a run-control-shaped claim: the
        // terminal dispatch must drive the inline force-terminal cascade
        // (#driveTerminalBare), never the delegated child-report path. This is the
        // complement of the delegated-child routing test — together they pin that
        // routing keys off the claim's delegation SHAPE, not its grants. (The
        // report-gate itself is unit-tested in claim-id.test.ts.)
        const claimId = await setupClaim('running');
        const session = await manager.loadSession();
        const claimKey = claimKeyFromBearer(claimId);
        const claim = session.claims[claimKey];
        // Drop the delegation linkage (run-control shape) and its now-forbidden
        // report grant to keep the persisted claim schema-valid.
        await patchPersistedClaim(manager.cwd, claimKey, {
          delegation: null,
          grants: claim.grants.filter((grant) => grant.action !== 'report-delegation-result'),
        });
        loadStepsImpl = () => [
          {
            kind: 'base',
            name: '1',
            description: 'child one',
            transitions: tx('COMPLETE', 'STOP'),
          },
        ];
        const barePlanSpy = jest.spyOn(sessionService, 'resolveActiveInlineForceTerminalPlan');

        const out = await seam.runTerminal({
          command: 'stop',
          callerEvidence: presentedBy(claimId),
          targetSelector: { kind: 'claim', claimId },
        });

        expect(out.kind).toBe('applied_bare');
        expect(barePlanSpy).toHaveBeenCalled();
      });

      it('claim complete on a running child dispatches FORCE_COMPLETE and forwards the message', async () => {
        const claimId = await setupClaim('running');
        loadStepsImpl = () => [
          {
            kind: 'base',
            name: '1',
            description: 'child one',
            transitions: tx('COMPLETE', 'STOP'),
          },
        ];
        const prepareSpy = jest.spyOn(actorService, 'prepareActorMutation');

        const out = await seam.runTerminal({
          command: 'complete',
          callerEvidence: presentedBy(claimId),
          targetSelector: { kind: 'claim', claimId },
          message: 'wrap up',
        });

        // complete → FORCE_COMPLETE (not FORCE_STOP), status derived completed.
        expect(out).toMatchObject({ kind: 'applied_claim', status: 'completed' });
        // The message is forwarded into the FORCE event (not dropped).
        expect(prepareSpy).toHaveBeenCalledWith(
          claimChildRunId,
          expect.anything(),
          expect.anything(),
          { type: 'FORCE_COMPLETE', message: 'wrap up' },
        );
      });

      it.each([
        ['complete', 'PASS'],
        ['stop', 'FAIL'],
      ] as const)(
        'projects a force-%s onto a %s transition result the parent can read',
        async (command, expected) => {
          // The result the claim path reports is derived from the COMMAND, not from
          // anything the machine decided: `complete` is a pass, `stop` is a fail.
          // Nothing else in this describe reads `events`, so without this the whole
          // mapping is free to invert — a force-stop could report PASS to the
          // delegating parent and every other assertion here would still hold.
          const claimId = await setupClaim('running');
          loadStepsImpl = () => [
            {
              kind: 'base',
              name: '1',
              description: 'child one',
              transitions: tx('COMPLETE', 'STOP'),
            },
          ];

          const out = await seam.runTerminal({
            command,
            callerEvidence: presentedBy(claimId),
            targetSelector: { kind: 'claim', claimId },
          });

          expect(out).toMatchObject({ kind: 'applied_claim' });
          expect(stepTransition(claimEvents(out))?.payload).toMatchObject({ result: expected });
        },
      );

      it('threads computeActionResult into the claim-path observation', async () => {
        // `computeActionResult` overrides the command-derived result for DISPLAY
        // only. Proving it arrives needs a callback that DISAGREES with the
        // fallback: on a force-stop the fallback is FAIL, so a callback returning
        // true can only produce PASS if it was actually threaded through.
        const claimId = await setupClaim('running');
        loadStepsImpl = () => [
          {
            kind: 'base',
            name: '1',
            description: 'child one',
            transitions: tx('COMPLETE', 'STOP'),
          },
        ];

        const out = await seam.runTerminal({
          command: 'stop',
          callerEvidence: presentedBy(claimId),
          targetSelector: { kind: 'claim', claimId },
          computeActionResult: () => true,
        });

        expect(stepTransition(claimEvents(out))?.payload).toMatchObject({ result: 'PASS' });
      });

      it('records the presented bearer as seen before dispatching the force', async () => {
        // Observing the holder is what lets a later `rundown collect` tell a claim
        // that acted from one that never showed up. It happens BEFORE dispatch on
        // purpose, so an authorized policy refusal or a no-op still records the
        // holder — nothing downstream of the force can be the thing that proves
        // this ran.
        //
        // ORDER IS THE ASSERTION, not invocation. A bare `toHaveBeenCalledWith`
        // is satisfied by a recorder moved to AFTER the aggregate, which is
        // precisely the arrangement this behaviour rules out: the force can
        // refuse or fail to commit, and the holder must be observed anyway.
        // `runAll` is the dispatch witness — the single seam every claim-path
        // force passes through — so the two call orders are directly comparable.
        const claimId = await setupClaim('running');
        loadStepsImpl = () => [
          {
            kind: 'base',
            name: '1',
            description: 'child one',
            transitions: tx('COMPLETE', 'STOP'),
          },
        ];
        const seen = jest.spyOn(sessionService, 'recordClaimSeen');
        const dispatch = jest.spyOn(actorMutationRunner, 'runAll');

        await seam.runTerminal({
          command: 'complete',
          callerEvidence: presentedBy(claimId),
          targetSelector: { kind: 'claim', claimId },
        });

        // Both calls must have happened for the order comparison to mean
        // anything — a never-dispatched force would otherwise read as "early".
        expect(seen).toHaveBeenCalledWith(claimId);
        expect(dispatch).toHaveBeenCalled();
        expect(seen.mock.invocationCallOrder[0]).toBeLessThan(dispatch.mock.invocationCallOrder[0]);
      });

      it('routes a delegated child to the report path even when it also holds a collect-for-run grant', async () => {
        // Routing between the report path and the bare inline-cascade must be
        // decided by claim SHAPE (a delegation linkage), not by the presence of a
        // run-control `collect-for-run` grant. The schema permits a delegated
        // claim to also carry a collect-for-run grant for its own run, so keying
        // the dispatch off that grant would route the child through the bare
        // cascade instead and silently skip its delegation report. Guards the
        // type-driven dispatch.
        const claimId = await setupClaim('running');
        const session = await manager.loadSession();
        const claimKey = claimKeyFromBearer(claimId);
        const claim = session.claims[claimKey];
        await patchPersistedClaim(manager.cwd, claimKey, {
          grants: [...claim.grants, { action: 'collect-for-run', runId: claimChildRunId }],
        });
        loadStepsImpl = () => [
          {
            kind: 'base',
            name: '1',
            description: 'child one',
            transitions: tx('COMPLETE', 'STOP'),
          },
        ];
        const aggregate = jest.spyOn(actorMutationRunner, 'runAll');

        const out = await seam.runTerminal({
          command: 'stop',
          callerEvidence: presentedBy(claimId),
          targetSelector: { kind: 'claim', claimId },
        });

        // Report path taken (child completion recorded to the parent), NOT the
        // bare inline cascade — which never calls recordChildCompletion.
        expect(out).toMatchObject({
          kind: 'applied_claim',
          status: 'stopped',
          reported: 'recorded',
        });
        expect(aggregate).toHaveBeenCalledTimes(1);
        expect(
          Object.keys((await manager.load(claimParentRunId))?.resolvedCompletions ?? {}),
        ).toHaveLength(1);
      });

      it('still closes a claimed child when the delegating parent holds no controlling claim', async () => {
        // The parent is captured with the BARE `captureRunAuthorityState`, which
        // refuses `claim_superseded` for a run with no active controlling claim.
        // A delegating parent in that state is ordinary — its own run-control
        // bearer may have been released or pruned while the delegation is still
        // live — so folding it into the aggregate as a hard target strands a
        // child that can then never be completed. The child close and its
        // bearer's terminal answer must not depend on the parent's own claim.
        const claimId = await setupClaim('running');
        loadStepsImpl = () => [
          {
            kind: 'base',
            name: '1',
            description: 'child one',
            transitions: tx('COMPLETE', 'STOP'),
          },
        ];
        // Drop the parent's run-control claim, leaving the parent run row and
        // the live delegation intact.
        unwrapSessionMutation(await sessionService.releaseRunbook(claimParentRunId));

        const out = await seam.runTerminal({
          command: 'complete',
          callerEvidence: presentedBy(claimId),
          targetSelector: { kind: 'claim', claimId },
        });

        expect(out).toMatchObject({ kind: 'applied_claim', status: 'completed' });
        expect((await manager.load(claimChildRunId))?.lifecycle).toBe('completed');
        // The parent target was DROPPED from the aggregate, not captured and
        // failed — so no report was attempted and the outcome says exactly that.
        // Paired with the `recorded` case below, this is what pins the spread:
        // one arm adds the parent, the other omits it, and `reported` is the
        // only field that tells them apart.
        expect(out).toMatchObject({ reported: 'not-applicable' });
      });

      it('targets the delegating parent so the child result is actually reported', async () => {
        // The opposite arm of the opportunistic spread, and the one nothing
        // asserted: when the parent IS reachable it must be added to the
        // aggregate and receive the child's outcome. Read off `reported`, not off
        // the parent's `resolvedCompletions` — the delegation fixture seeds a
        // substep on the parent, so a count-based assertion can be satisfied by
        // setup and stay green while the report never happens.
        const claimId = await setupClaim('running');
        loadStepsImpl = () => [
          {
            kind: 'base',
            name: '1',
            description: 'child one',
            transitions: tx('COMPLETE', 'STOP'),
          },
        ];

        const out = await seam.runTerminal({
          command: 'complete',
          callerEvidence: presentedBy(claimId),
          targetSelector: { kind: 'claim', claimId },
        });

        expect(out).toMatchObject({ kind: 'applied_claim', reported: 'recorded' });
      });

      it('never targets the parent when defensive resolution supplies a drifted claim', async () => {
        // Production claim minting and resolution now compare every shared
        // authority coordinate, so neither can supply this state. Injecting the
        // pre-fix resolution keeps the downstream guard observable: it remains
        // fail-closed if a malformed collaborator result reaches the terminal
        // service, and it kills both mutants on the empty target-list arm.
        const claimId = await setupClaim('running');
        const claimKey = claimKeyFromBearer(claimId);
        const session = await manager.loadSession();
        const record = session.claims[claimKey];
        if (!record.delegation) throw new Error('Expected delegated claim');
        const driftedDelegation = {
          ...record.delegation,
          parentEntry: record.delegation.parentEntry + 1,
        };
        const driftedGrants = record.grants.map((grant) =>
          grant.action === 'report-delegation-result'
            ? { ...grant, parentEntry: driftedDelegation.parentEntry }
            : grant,
        );
        const driftedRecord = {
          ...record,
          delegation: driftedDelegation,
          grants: driftedGrants,
        };
        const childState = await manager.load(claimChildRunId);
        if (!childState) throw new Error('Expected claimed child state');
        jest.spyOn(sessionService, 'getActiveForClaimId').mockResolvedValue({
          status: 'claimed',
          claimId,
          claim: {
            claimKey: driftedRecord.claimKey,
            controlledRunId: driftedRecord.controlledRunId,
            delegation: driftedRecord.delegation,
            grants: driftedRecord.grants,
          },
          record: driftedRecord,
          state: childState,
        });
        loadStepsImpl = () => [
          {
            kind: 'base',
            name: '1',
            description: 'child one',
            transitions: tx('COMPLETE', 'STOP'),
          },
        ];
        const aggregate = jest.spyOn(actorMutationRunner, 'runAll');

        const out = await seam.runTerminal({
          command: 'complete',
          callerEvidence: presentedBy(claimId),
          targetSelector: { kind: 'claim', claimId },
        });

        // The parent is not a target AT ALL, as opposed to a target that capture
        // dropped. `reported` cannot see that difference — it reads
        // `captured.at(1)`, which is empty either way — so the target list is the
        // only thing that pins this arm. Invert the spread and a second entry
        // appears here.
        expect(aggregate.mock.calls[0][0].targets).toEqual([
          { runId: claimChildRunId, claimKey: claimKeyFromBearer(claimId) },
        ]);
        expect(out).toMatchObject({ kind: 'applied_claim', reported: 'not-applicable' });
        // Defensive behavior still closes the authorized child without sending
        // a result under authority that does not match its persisted linkage.
        expect((await manager.load(claimChildRunId))?.lifecycle).toBe('completed');
      });

      it('claim complete returns claim_grant_required when the claim lacks mutate-run grant', async () => {
        const claimId = await setupClaim('running');
        const session = await manager.loadSession();
        const claimKey = claimKeyFromBearer(claimId);
        const claim = session.claims[claimKey];
        await patchPersistedClaim(manager.cwd, claimKey, {
          grants: claim.grants.filter((grant) => grant.action !== 'mutate-run'),
        });
        const sendSpy = jest.spyOn(actorService, 'sendAndSync');

        const out = await seam.runTerminal({
          command: 'complete',
          callerEvidence: presentedBy(claimId),
          targetSelector: { kind: 'claim', claimId },
        });

        expect(out).toEqual({ kind: 'claim_grant_required', claimId, runId: claimChildRunId });
        expect(sendSpy).not.toHaveBeenCalled();
      });
    });

    describe('bare path', () => {
      const ROOT = assertRunId('rd_77777777777777777777777777777777');
      const CHILD = assertRunId('rd_88888888888888888888888888888888');
      // A delegating parent OUTSIDE the inline force order. The bare cascade
      // owns the inline chain; a run that delegated the chain's root is not a
      // member of it, and appending it opportunistically is the arm below.
      const EXTERNAL_PARENT = assertRunId('rd_eeeeeeeeeeeeeeeeeeeeeeeeeeeeee99');

      // A root state carrying a reported-but-uncollected delegation outcome, i.e.
      // collection pending (mirrors command-policy.test.ts stateWithReportedOutcome).
      function collectionPendingState(id: RunbookState['id']): RunbookState {
        const completionKey = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
        return baseState({
          id,
          resolvedCompletions: {
            [completionKey]: buildResolvedCompletion({
              agentId: 'delegation',
              result: 'pass',
              targetStep: '1',
              targetSubstep: '1',
              targetFrame: activeFrame(buildFrameKey('1'), 1),
              completedAt: '2026-06-28T00:00:00.000Z',
            }),
          },
        });
      }

      // Build and install a synthetic resolved plan on the spied session method.
      function installResolvedPlan(target: RunbookState, forceOrder: readonly RunbookState[]) {
        const releaseRunIds = forceOrder.map((s) => s.id);
        jest.spyOn(sessionService, 'resolveActiveInlineForceTerminalPlan').mockResolvedValue({
          status: 'resolved',
          kind: 'complete',
          activeState: forceOrder[0] ?? target,
          targetState: target,
          descendantStates: forceOrder.filter((s) => s.id !== target.id),
          forceOrder,
          releaseRunIds,
        });
      }

      it('bare complete can force a standalone resolved root with unknown caller evidence', async () => {
        loadStepsImpl = () => [
          { kind: 'base', name: '1', description: 'one', transitions: tx('COMPLETE', 'STOP') },
        ];
        const root = baseState({ id: ROOT });
        await manager.save(root);
        await issueRunControlClaimFor(ROOT);
        installResolvedPlan(root, [root]);
        const out = await seam.runTerminal({
          command: 'complete',
          callerEvidence: { kind: 'unknown' },
          targetSelector: { kind: 'default' },
        });
        expect(out).toMatchObject({ kind: 'applied_bare', rootRunId: ROOT });
      });

      it('bare stop refuses when the resolved root is collection pending (item 8)', async () => {
        // The pending-outcome root classifies `delegating`, so the guard's
        // subject needs bearer authority; the bare direct-CLI
        // twin below pins the role-gate refusal.
        const root = collectionPendingState(ROOT);
        await manager.save(root);
        await issueRunControlClaimFor(ROOT);
        installResolvedPlan(root, [root]);
        const evidence = runControlEvidence(ROOT);
        if (evidence.kind !== 'claim_bearer') throw new Error('expected bearer evidence');
        const claimKey = claimKeyFromBearer(evidence.claimId);
        await patchPersistedClaim(manager.cwd, claimKey, {
          lastSeenAt: '2020-01-01T00:00:00.000Z',
        });
        const out = await seam.runTerminal({
          command: 'stop',
          callerEvidence: evidence,
          targetSelector: { kind: 'default' },
        });
        expect(out.kind).toBe('delegation_collection_pending');
        expect(
          Date.parse((await manager.loadSession()).claims[claimKey].lastSeenAt),
        ).toBeGreaterThan(Date.parse('2020-01-01T00:00:00.000Z'));
      });

      it('run-control claim terminal refuses when the resolved root is collection pending', async () => {
        const root = collectionPendingState(ROOT);
        await manager.save(root);
        await issueRunControlClaimFor(ROOT);
        installResolvedPlan(root, [root]);
        const evidence = runControlEvidence(ROOT);
        if (evidence.kind !== 'claim_bearer') throw new Error('expected bearer evidence');

        const out = await seam.runTerminal({
          command: 'complete',
          callerEvidence: evidence,
          targetSelector: { kind: 'claim', claimId: evidence.claimId },
        });

        expect(out.kind).toBe('delegation_collection_pending');
      });

      it('bare terminal returns claim_grant_required when the bearer lacks mutate-run on the resolved root', async () => {
        const root = baseState({ id: ROOT });
        await manager.save(root);
        await issueRunControlClaimFor(ROOT);
        const evidence = runControlEvidence(ROOT);
        if (evidence.kind !== 'claim_bearer') throw new Error('expected bearer evidence');
        const claimKey = claimKeyFromBearer(evidence.claimId);
        const session = await manager.loadSession();
        const claim = session.claims[claimKey];
        await patchPersistedClaim(manager.cwd, claimKey, {
          grants: claim.grants.filter((grant) => grant.action !== 'mutate-run'),
          lastSeenAt: '2020-01-01T00:00:00.000Z',
        });
        installResolvedPlan(root, [root]);

        const out = await seam.runTerminal({
          command: 'stop',
          callerEvidence: evidence,
          targetSelector: { kind: 'default' },
        });

        expect(out).toEqual({
          kind: 'claim_grant_required',
          claimId: evidence.claimId,
          runId: ROOT,
        });
        expect((await manager.loadSession()).claims[claimKey].lastSeenAt).toBe(
          '2020-01-01T00:00:00.000Z',
        );
      });

      it('refuses a bare direct-CLI stop on a collection-pending (delegating) root — ambient trust removed (#460)', async () => {
        const root = collectionPendingState(ROOT);
        installResolvedPlan(root, [root]);
        const out = await seam.runTerminal({
          command: 'stop',
          callerEvidence: DIRECT_CLI,
          targetSelector: { kind: 'default' },
        });
        expect(out).toEqual({ kind: 'actor_context_required' });
      });

      it('refuses bare direct-CLI terminal force when the resolved root has open delegated claims', async () => {
        loadStepsImpl = () => [
          { kind: 'base', name: '1', description: 'one', transitions: tx('COMPLETE', 'STOP') },
        ];
        const childRunId = assertRunId('rd_33333333333333333333333333333333');
        const root = baseState({ id: ROOT });
        const child = baseState({
          id: childRunId,
          parentLinkage: linkageFor(ROOT, 'a'),
        });
        await manager.save(root);
        await manager.save(child);
        assertClaimed(
          await claimLiveDelegation(sessionService, manager, childRunId, linkageFor(ROOT, 'a')),
        );
        installResolvedPlan(root, [root]);

        const out = await seam.runTerminal({
          command: 'complete',
          callerEvidence: DIRECT_CLI,
          targetSelector: { kind: 'default' },
        });

        expect(out).toEqual({ kind: 'actor_context_required' });
      });

      it('bare complete atomically forces and releases the chain descendant-to-root', async () => {
        const childState = baseState({
          id: CHILD,
          parentLinkage: {
            kind: 'inline',
            parentRunId: ROOT,
            parentStep: '1',
            parentStepId: '1',
            parentFrameKey: buildFrameKey('1'),
            parentEntry: 1,
          },
        });
        const rootState = baseState({ id: ROOT });
        await manager.save(childState);
        await manager.save(rootState);
        await issueRunControlClaimFor(CHILD);
        await issueRunControlClaimFor(ROOT);
        loadStepsImpl = () => [
          { kind: 'base', name: '1', description: 'one', transitions: tx('COMPLETE', 'STOP') },
        ];
        installResolvedPlan(rootState, [childState, rootState]);

        const prepared: RunId[] = [];
        const realPrepare = actorService.prepareActorMutation.bind(actorService);
        jest.spyOn(actorService, 'prepareActorMutation').mockImplementation(async (...args) => {
          prepared.push(assertRunId(args[0]));
          return realPrepare(...args);
        });
        const aggregate = jest.spyOn(actorMutationRunner, 'runAll');
        const releaseDescendantsSpy = jest.spyOn(sessionService, 'releaseRunbooks');
        const releaseRootSpy = jest.spyOn(sessionService, 'releaseRunbook');

        const out = await seam.runTerminal({
          command: 'complete',
          callerEvidence: runControlEvidence(ROOT),
          targetSelector: { kind: 'default' },
        });
        expect(out).toMatchObject({ kind: 'applied_bare', rootRunId: ROOT, status: 'completed' });
        expect(prepared).toEqual([CHILD, ROOT]);
        expect(aggregate).toHaveBeenCalledTimes(1);
        expect((await manager.load(CHILD))?.lifecycle).toBe('completed');
        expect((await manager.load(ROOT))?.lifecycle).toBe('completed');
        expect(releaseRootSpy).not.toHaveBeenCalled();
        expect(releaseDescendantsSpy).not.toHaveBeenCalled();
      });

      it.each([
        ['complete', 'PASS'],
        ['stop', 'FAIL'],
      ] as const)(
        'projects a bare force-%s onto a %s transition result',
        async (command, expected) => {
          // The bare cascade derives its result from the command exactly as the
          // claim path does, and its own copy of that mapping is separately
          // mutable — pinning one does not pin the other.
          const root = baseState({ id: ROOT });
          await manager.save(root);
          await issueRunControlClaimFor(ROOT);
          loadStepsImpl = () => [
            { kind: 'base', name: '1', description: 'one', transitions: tx('COMPLETE', 'STOP') },
          ];
          installResolvedPlan(root, [root]);

          const out = await seam.runTerminal({
            command,
            callerEvidence: runControlEvidence(ROOT),
            targetSelector: { kind: 'default' },
          });

          expect(out).toMatchObject({ kind: 'applied_bare' });
          expect(stepTransition(bareEvents(out))?.payload).toMatchObject({ result: expected });
        },
      );

      it('threads computeActionResult into the bare-path observation', async () => {
        // As on the claim path: a force-stop's fallback is FAIL, so PASS here can
        // only come from the supplied callback actually reaching the projection.
        const root = baseState({ id: ROOT });
        await manager.save(root);
        await issueRunControlClaimFor(ROOT);
        loadStepsImpl = () => [
          { kind: 'base', name: '1', description: 'one', transitions: tx('COMPLETE', 'STOP') },
        ];
        installResolvedPlan(root, [root]);

        const out = await seam.runTerminal({
          command: 'stop',
          callerEvidence: runControlEvidence(ROOT),
          targetSelector: { kind: 'default' },
          computeActionResult: () => true,
        });

        expect(stepTransition(bareEvents(out))?.payload).toMatchObject({ result: 'PASS' });
      });

      it('keys the bare cascade capture to the run the presented claim controls', async () => {
        // The bare cascade captures a whole chain, and only ONE member is the run
        // the presented bearer controls — the key goes on that member and nowhere
        // else. Mis-routing it (or dropping it) turns the root's capture into a
        // bare one that resolves whatever claim currently controls the run.
        //
        // Same fence point as the top-level and substep witnesses: retiring from
        // inside `captureAuthorityState` both opens the race and proves the keyed
        // arm ran at all.
        const root = baseState({ id: ROOT });
        await manager.save(root);
        await issueRunControlClaimFor(ROOT);
        loadStepsImpl = () => [
          { kind: 'base', name: '1', description: 'one', transitions: tx('COMPLETE', 'STOP') },
        ];
        installResolvedPlan(root, [root]);

        const capturedRunIds = retireDuringCapture(
          await getRunbookStore(tmp),
          new SessionService(new RunbookStateManager(tmp)),
          ROOT,
        );

        const out = await seam.runTerminal({
          command: 'complete',
          callerEvidence: runControlEvidence(ROOT),
          targetSelector: { kind: 'default' },
        });

        // The key landed on the bearer's own run, and only there.
        expect(capturedRunIds()).toEqual([ROOT]);
        expect(out.kind).toBe('claim_superseded');
        expect((await manager.load(ROOT))?.lifecycle).toBe('running');
      });

      it('reports the forced root to a delegating parent outside the force order', async () => {
        // The bare cascade's own opportunistic-parent arm, twin to the claim
        // path's — and the one nothing drove: no existing bare test gives the
        // resolved root a delegation linkage at all, so `externalParentRunId`
        // was always undefined and the whole spread was dead code under test.
        // Read off `reported`, never off the parent's `resolvedCompletions`:
        // `seedLiveDelegation` writes a substep on the parent, so a count-based
        // assertion is satisfied by setup and stays green while the report
        // never happens.
        const linkage = linkageFor(EXTERNAL_PARENT, 'a');
        await manager.save(baseState({ id: EXTERNAL_PARENT, runbookPath: 'parent.md' }));
        await issueRunControlClaimFor(EXTERNAL_PARENT);
        await seedLiveDelegation(manager, linkage);
        const root = baseState({ id: ROOT, parentLinkage: linkage });
        await manager.save(root);
        await issueRunControlClaimFor(ROOT);
        loadStepsImpl = () => [
          { kind: 'base', name: '1', description: 'one', transitions: tx('COMPLETE', 'STOP') },
        ];
        installResolvedPlan(root, [root]);

        const out = await seam.runTerminal({
          command: 'complete',
          callerEvidence: runControlEvidence(ROOT),
          targetSelector: { kind: 'default' },
        });

        expect(out).toMatchObject({
          kind: 'applied_bare',
          rootRunId: ROOT,
          reported: 'recorded',
        });
      });

      it('drops a delegating parent it cannot capture instead of vetoing the root close', async () => {
        // Why that target is `optional`. A delegating parent holding no
        // controlling claim of its own is ordinary — its run-control bearer may
        // have been released or pruned while the delegation is still live — and
        // `captureRunAuthorityState` refuses `claim_superseded` for exactly that
        // run. Made hard, the whole aggregate takes that refusal and the root it
        // was forcing never closes. Twin of the claim path's "still closes a
        // claimed child when the delegating parent holds no controlling claim".
        const linkage = linkageFor(EXTERNAL_PARENT, 'a');
        // Saved with a live delegation but never claimed: a run row with no
        // active controlling claim is what the bare capture refuses.
        await manager.save(baseState({ id: EXTERNAL_PARENT, runbookPath: 'parent.md' }));
        await seedLiveDelegation(manager, linkage);
        const root = baseState({ id: ROOT, parentLinkage: linkage });
        await manager.save(root);
        await issueRunControlClaimFor(ROOT);
        loadStepsImpl = () => [
          { kind: 'base', name: '1', description: 'one', transitions: tx('COMPLETE', 'STOP') },
        ];
        installResolvedPlan(root, [root]);

        const out = await seam.runTerminal({
          command: 'complete',
          callerEvidence: runControlEvidence(ROOT),
          targetSelector: { kind: 'default' },
        });

        expect(out).toMatchObject({ kind: 'applied_bare', rootRunId: ROOT, status: 'completed' });
        // Dropped from the aggregate, not captured and failed — so no report was
        // attempted, and `reported` is the field that says which of the two
        // happened. Paired with the `recorded` case above this pins the spread.
        expect(out).toMatchObject({ reported: 'not-applicable' });
        expect((await manager.load(ROOT))?.lifecycle).toBe('completed');
      });

      it('does not repeat an aggregate target when the delegating parent is already forced', async () => {
        // The dedup arm, and it is crash-avoidance rather than a tidy-up:
        // `runAll` rejects a repeated target outright, because an aggregate that
        // claims to own one run twice cannot be committed. The topology needs a
        // delegation edge running back into the forcing run's own inline chain,
        // which the plan resolver's cycle check does not cover (it walks inline
        // linkage only) — the synthetic plan is what makes it constructible.
        const childState = baseState({
          id: CHILD,
          parentLinkage: {
            kind: 'inline',
            parentRunId: ROOT,
            parentStep: '1',
            parentStepId: '1',
            parentFrameKey: buildFrameKey('1'),
            parentEntry: 1,
          },
        });
        const rootState = baseState({ id: ROOT, parentLinkage: linkageFor(CHILD, 'a') });
        await manager.save(childState);
        await manager.save(rootState);
        await issueRunControlClaimFor(CHILD);
        await issueRunControlClaimFor(ROOT);
        loadStepsImpl = () => [
          { kind: 'base', name: '1', description: 'one', transitions: tx('COMPLETE', 'STOP') },
        ];
        installResolvedPlan(rootState, [childState, rootState]);

        const aggregateTargets: RunId[][] = [];
        const realRunAll = actorMutationRunner.runAll.bind(actorMutationRunner);
        jest.spyOn(actorMutationRunner, 'runAll').mockImplementation(async (input) => {
          aggregateTargets.push(input.targets.map(({ runId: id }) => id));
          return await realRunAll(input);
        });

        const out = await seam.runTerminal({
          command: 'complete',
          callerEvidence: runControlEvidence(ROOT),
          targetSelector: { kind: 'default' },
        });

        expect(out).toMatchObject({ kind: 'applied_bare', rootRunId: ROOT });
        // The force order exactly, with no second entry for CHILD appended.
        expect(aggregateTargets).toEqual([[CHILD, ROOT]]);
      });

      it('bare stop maps a non-running resolved root to already_terminal', async () => {
        const root = baseState({ id: ROOT, lifecycle: 'completed' });
        await manager.save(root);
        await issueRunControlClaimFor(ROOT);
        installResolvedPlan(root, [root]);
        const releaseSpy = jest.spyOn(sessionService, 'releaseRunbooks');
        const out = await seam.runTerminal({
          command: 'stop',
          callerEvidence: runControlEvidence(ROOT),
          targetSelector: { kind: 'default' },
        });
        expect(out).toEqual({
          kind: 'already_terminal',
          targetRunId: ROOT,
          lifecycle: 'completed',
        });
        expect(releaseSpy).toHaveBeenCalled();
      });

      it('returns already_terminal before the effect boundary when the captured root became terminal', async () => {
        const root = baseState({ id: ROOT });
        await manager.save(root);
        await issueRunControlClaimFor(ROOT);
        installResolvedPlan(root, [root]);
        const runAll = actorMutationRunner.runAll.bind(actorMutationRunner);
        jest.spyOn(actorMutationRunner, 'runAll').mockImplementationOnce(async (input) => {
          await manager.updateWithState(ROOT, () => ({ lifecycle: 'completed' as const }));
          return await runAll(input);
        });
        const prepare = jest.spyOn(actorService, 'prepareActorMutation');
        const release = jest.spyOn(sessionService, 'releaseRunbooks');

        const out = await seam.runTerminal({
          command: 'stop',
          callerEvidence: runControlEvidence(ROOT),
          targetSelector: { kind: 'default' },
        });

        expect(out).toEqual({
          kind: 'already_terminal',
          targetRunId: ROOT,
          lifecycle: 'completed',
        });
        expect(prepare).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledWith([ROOT], {
          retainClaimsAsTerminalRunId: ROOT,
        });
        const attempts = await (await getRunbookStore(tmp)).read((txn) =>
          txn.tx
            .prepare('SELECT COUNT(*) AS count FROM execution_attempts WHERE run_id = :runId')
            .get<{ readonly count: number }>({ runId: ROOT }),
        );
        expect(attempts?.count).toBe(0);
      });

      it('preserves already_terminal without releasing for a foreign run-control bearer', async () => {
        const root = baseState({ id: ROOT, lifecycle: 'completed' });
        await manager.save(root);
        await sessionService.pushRunbook(ROOT);
        await manager.save(baseState({ id: CHILD }));
        await issueRunControlClaimFor(CHILD);
        installResolvedPlan(root, [root]);
        const releaseSpy = jest.spyOn(sessionService, 'releaseRunbooks');

        const out = await seam.runTerminal({
          command: 'stop',
          callerEvidence: runControlEvidence(CHILD),
          targetSelector: { kind: 'default' },
        });

        expect(out).toEqual({
          kind: 'already_terminal',
          targetRunId: ROOT,
          lifecycle: 'completed',
        });
        expect((await sessionService.getActive())?.id).toBe(ROOT);
        expect(releaseSpy).not.toHaveBeenCalled();
      });

      it('bare stop maps an already-stopped resolved root to already_terminal (stopped)', async () => {
        // Pins the `lifecycle === 'stopped' ? 'stopped' : 'completed'` arm that the
        // completed-root test above never reaches.
        const root = baseState({ id: ROOT, lifecycle: 'stopped' });
        await manager.save(root);
        await issueRunControlClaimFor(ROOT);
        installResolvedPlan(root, [root]);
        const out = await seam.runTerminal({
          command: 'stop',
          callerEvidence: runControlEvidence(ROOT),
          targetSelector: { kind: 'default' },
        });
        expect(out).toEqual({ kind: 'already_terminal', targetRunId: ROOT, lifecycle: 'stopped' });
      });

      it('skips a non-running descendant in the force loop but still forces the root', async () => {
        // A descendant already terminal (lifecycle !== 'running') is skipped by the
        // in-loop guard; pins `if (state.lifecycle !== 'running') continue;`.
        const childState = baseState({
          id: CHILD,
          lifecycle: 'completed',
          parentLinkage: {
            kind: 'inline',
            parentRunId: ROOT,
            parentStep: '1',
            parentStepId: '1',
            parentFrameKey: buildFrameKey('1'),
            parentEntry: 1,
          },
        });
        const rootState = baseState({ id: ROOT });
        await manager.save(childState);
        await manager.save(rootState);
        await issueRunControlClaimFor(CHILD);
        await issueRunControlClaimFor(ROOT);
        loadStepsImpl = () => [
          { kind: 'base', name: '1', description: 'one', transitions: tx('COMPLETE', 'STOP') },
        ];
        installResolvedPlan(rootState, [childState, rootState]);

        const forced: string[] = [];
        const realPrepare = actorService.prepareActorMutation.bind(actorService);
        jest.spyOn(actorService, 'prepareActorMutation').mockImplementation(async (id, ...args) => {
          forced.push(id === ROOT ? 'ROOT' : 'CHILD');
          return realPrepare(id, ...args);
        });

        const out = await seam.runTerminal({
          command: 'complete',
          callerEvidence: runControlEvidence(ROOT),
          targetSelector: { kind: 'default' },
        });

        if (out.kind !== 'applied_bare') {
          throw new Error(`expected applied_bare, got ${out.kind}`);
        }
        // The non-running child was never dispatched; only the root was forced.
        expect(forced).toEqual(['ROOT']);
        expect(out.forcedRunIds).toEqual([ROOT]);
      });

      it('bare complete maps plan status none to outcome none', async () => {
        await manager.save(baseState({ id: ROOT }));
        await issueRunControlClaimFor(ROOT);
        jest
          .spyOn(sessionService, 'resolveActiveInlineForceTerminalPlan')
          .mockResolvedValue({ status: 'none', kind: 'complete' });
        const out = await seam.runTerminal({
          command: 'complete',
          callerEvidence: runControlEvidence(ROOT),
          targetSelector: { kind: 'default' },
        });
        expect(out.kind).toBe('none');
      });

      it('bare complete maps missing-inline-parent to inline_plan_unavailable', async () => {
        await manager.save(baseState({ id: ROOT }));
        await issueRunControlClaimFor(ROOT);
        jest.spyOn(sessionService, 'resolveActiveInlineForceTerminalPlan').mockResolvedValue({
          status: 'missing-inline-parent',
          kind: 'complete',
          activeState: baseState({ id: CHILD }),
          missingParentRunId: ROOT,
        });
        const out = await seam.runTerminal({
          command: 'complete',
          callerEvidence: runControlEvidence(ROOT),
          targetSelector: { kind: 'default' },
        });
        expect(out).toMatchObject({
          kind: 'inline_plan_unavailable',
          reason: 'missing-inline-parent',
          code: 'INLINE_PARENT_UNAVAILABLE',
        });
      });

      it('bare complete maps inline-cycle to inline_plan_unavailable', async () => {
        await manager.save(baseState({ id: ROOT }));
        await issueRunControlClaimFor(ROOT);
        jest.spyOn(sessionService, 'resolveActiveInlineForceTerminalPlan').mockResolvedValue({
          status: 'inline-cycle',
          kind: 'complete',
          activeState: baseState({ id: CHILD }),
          repeatedRunId: ROOT,
        });
        const out = await seam.runTerminal({
          command: 'complete',
          callerEvidence: runControlEvidence(ROOT),
          targetSelector: { kind: 'default' },
        });
        expect(out).toMatchObject({
          kind: 'inline_plan_unavailable',
          reason: 'inline-cycle',
          code: 'INLINE_PARENT_CYCLE',
        });
      });

      it('bare complete surfaces a typed missing refusal when aggregate capture loses the root', async () => {
        const rootState = baseState({ id: ROOT });
        await manager.save(rootState);
        await issueRunControlClaimFor(ROOT);
        loadStepsImpl = () => [
          { kind: 'base', name: '1', description: 'one', transitions: tx('COMPLETE', 'STOP') },
        ];
        installResolvedPlan(rootState, [rootState]);
        jest.spyOn(actorMutationRunner, 'runAll').mockResolvedValue({
          kind: 'missing',
          runId: ROOT,
          message: `Run ${ROOT} does not exist.`,
        });
        const out = await seam.runTerminal({
          command: 'complete',
          callerEvidence: runControlEvidence(ROOT),
          targetSelector: { kind: 'default' },
        });
        expect(out).toEqual({
          kind: 'missing',
          runId: ROOT,
          message: `Run ${ROOT} does not exist.`,
        });
      });

      it('writes no root state when aggregate capture loses a descendant', async () => {
        const childState = baseState({ id: CHILD });
        const rootState = baseState({ id: ROOT });
        await manager.save(childState);
        await manager.save(rootState);
        await issueRunControlClaimFor(ROOT);
        loadStepsImpl = () => [
          { kind: 'base', name: '1', description: 'one', transitions: tx('COMPLETE', 'STOP') },
        ];
        installResolvedPlan(rootState, [childState, rootState]);

        jest.spyOn(actorMutationRunner, 'runAll').mockResolvedValue({
          kind: 'missing',
          runId: CHILD,
          message: `Run ${CHILD} does not exist.`,
        });

        const out = await seam.runTerminal({
          command: 'complete',
          callerEvidence: runControlEvidence(ROOT),
          targetSelector: { kind: 'default' },
        });

        expect(out).toEqual({
          kind: 'missing',
          runId: CHILD,
          message: `Run ${CHILD} does not exist.`,
        });
        expect((await manager.load(ROOT))?.lifecycle).toBe('running');
      });
    });
  });
});
