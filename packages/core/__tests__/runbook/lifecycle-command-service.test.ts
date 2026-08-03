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
  type SubstepState,
} from '../../src/runbook/index.js';
import { buildContextSnapshot } from '../../src/runbook/delegation-context.js';
import {
  assertDelegationTokenHash,
  DELEGATION_CLAIM_MARKER,
  TOKEN_PREFIX,
} from '../../src/runbook/delegation-token.js';
import { claimKeyFromBearer } from '../../src/runbook/claim-id.js';
import { findSubstepState } from '../../src/runbook/targeting.js';
import { getRunbookStore } from '../../src/runbook/storage/store-registry.js';
import { RunbookStore } from '../../src/runbook/storage/runbook-store.js';
import { SqliteExecutionLeaseService } from '../../src/runbook/storage/execution-lease.js';
import { brandStoredOutputsForTest } from '../../src/testing/effective-vars.js';
import {
  assertClaimed,
  linkageFor,
  claimLiveDelegation,
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
      lifecycleService,
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
      findDelegationByToken: async () => undefined,
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
      lifecycleService,
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
      findDelegationByToken: async (token) =>
        (await new DelegationScanService(manager).findByToken(token)) ?? undefined,
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
      const persisted = await mgr.load(state.id);
      const entry = persisted?.substepStates?.find((s) => s.id === '1');
      expect(entry?.delegation?.childRunId).toBeNull();
      expect(entry?.delegation?.tokenHash).not.toBe(first.tokenHash);
      await expect(
        deps.lifecycleService.getResolvedCompletion(state.id, keyForSubstep('1')),
      ).resolves.toBeNull();
      await expect(
        deps.lifecycleService.getResolvedCompletion(state.id, keyForSubstep('2')),
      ).resolves.not.toBeNull();

      const terminalChild = await mgr.load(childRunId);
      if (!terminalChild) throw new Error('expected terminal child to remain for diagnostics');
      await expect(
        deps.completionService.recordChildCompletion({ childState: terminalChild }),
      ).resolves.toBe('not-applicable');
      await expect(
        deps.lifecycleService.getResolvedCompletion(state.id, keyForSubstep('1')),
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
        deps.lifecycleService.getResolvedCompletion(state.id, keyForSubstep('1')),
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
      // snapshot. `findDelegationByToken` is a readonly dep, so swap it by
      // constructing a fresh seam over the same deps rather than mutating.
      const realScan = await new DelegationScanService(manager).findByToken(first.token);
      if (!realScan) throw new Error('expected scan');
      const { at: _at, ...snapshotWithoutAt } = realScan.delegation.contextSnapshot;
      const localSeamStale = new RunbookLifecycleCommandService({
        ...deps,
        findDelegationByToken: async () => ({
          ...realScan,
          delegation: { ...realScan.delegation, contextSnapshot: snapshotWithoutAt },
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
  });

  describe('abortDelegation', () => {
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
      const scan = deps.findDelegationByToken;
      const abortingSeam = new RunbookLifecycleCommandService({
        ...deps,
        findDelegationByToken: async (token) => {
          const found = await scan(token);
          if (found) {
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
      // The claim commits after the cheap pre-check and inside the fenced
      // preparation, so only the in-transaction guard can catch it. That guard
      // aborts the commit transaction before its first UPDATE, so the run is
      // provably untouched: the caller gets the actionable refusal and the run
      // is NOT parked in recovery for a race that changed nothing.
      loadStepsImpl = () => twoSteps;
      const childRunId = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac');
      const linkage = linkageFor(namedRunId, 'a');
      await activate(baseState({ id: namedRunId }));
      await manager.save(
        baseState({ id: childRunId, runbookPath: 'child.md', parentLinkage: linkage }),
      );
      await seedLiveDelegation(manager, linkage);

      const claimant = new SessionService(new RunbookStateManager(tmp));
      const realPrepare = actorService.prepareActorMutation.bind(actorService);
      let claimResult: Awaited<ReturnType<SessionService['claimRunbook']>> | undefined;
      jest.spyOn(actorService, 'prepareActorMutation').mockImplementation(async (...args) => {
        claimResult ??= await claimant.claimRunbook(childRunId, linkage);
        return realPrepare(...args);
      });

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: runControlEvidence(namedRunId),
        targetSelector: { kind: 'run', runId: namedRunId },
        terminalPolicy: RELEASE_POLICY,
      });

      expect(outcome.kind).toBe('open_delegated_children');
      expect(claimResult?.kind).toBe('committed');
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

  describe('resolveRunNavigation (goto seam)', () => {
    const twoSteps: ResolvedStep[] = [
      { kind: 'base', name: '1', description: 'one', transitions: tx('CONTINUE', 'STOP') },
      { kind: 'base', name: '2', description: 'two', transitions: tx('COMPLETE', 'STOP') },
    ];

    it('does not bump the active entry for a navigation within the same frame', async () => {
      // The fenced GOTO commits active-entry metadata, and the execution loop it
      // hands off to derives that metadata again. If the fence also scored the
      // navigation as a frame re-entry, one `rd goto` would advance the entry
      // twice. `activeEntry` is what an inline launch intent pins its
      // `parentEntry` to, so an extra bump makes a recovered intent stop
      // matching its own child's linkage (RD inline-child recovery).
      loadStepsImpl = () => twoSteps;
      await activate(baseState({ id: runId }));
      const before = await manager.load(runId);

      const outcome = await seam.runNavigationMutation({
        runId,
        callerEvidence: runControlEvidence(runId),
        steps: twoSteps,
        target: { step: '1' },
        terminalReleaseMode: 'stack-pop',
      });

      expect(outcome.kind).toBe('applied');
      const after = await manager.load(runId);
      expect(after?.activeEntry).toBe(before?.activeEntry ?? 1);
      expect(after?.frameEntryCounts).toEqual(before?.frameEntryCounts ?? { '1|': 1 });
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
      expect(outcome.issueDelegationCredential).toBeDefined();
      expect(outcome.deriveDelegationToken).toBeDefined();
      const issued = outcome.issueDelegationCredential!({
        parentRunId: runId,
        parentStepId: '1.1',
        parentFrameKey: buildFrameKey('1'),
        parentEntry: 1,
      });
      expect(outcome.deriveDelegationToken!(issued.credential)).toBe(issued.token);
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
      expect(outcome.issueDelegationCredential).toBeDefined();
      expect(outcome.deriveDelegationToken).toBeDefined();
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
      expect(outcome.issueDelegationCredential).toBeUndefined();
      expect(outcome.deriveDelegationToken).toBeUndefined();
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
      expect(outcome.issueDelegationCredential).toBeDefined();
      expect(outcome.deriveDelegationToken).toBeDefined();
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
      expect(outcome.issueDelegationCredential).toBeUndefined();
      expect(outcome.deriveDelegationToken).toBeUndefined();
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
        await manager.save(baseState({ id: claimParentRunId }));
        await sessionService.pushRunbook(claimParentRunId);
        await issueRunControlClaimFor(claimParentRunId);
        const childBase = {
          id: claimChildRunId,
          runbook: { source: 'project', path: 'claim-child.md' } as const,
          runbookPath: 'claim-child.md',
          parentLinkage: linkageFor(claimParentRunId, 'a'),
        };
        await manager.save(baseState(childBase));
        const claimed = assertClaimed(
          await claimLiveDelegation(
            sessionService,
            manager,
            claimChildRunId,
            linkageFor(claimParentRunId, 'a'),
          ),
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
