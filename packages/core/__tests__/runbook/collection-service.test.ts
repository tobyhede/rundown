import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ResolvedStep } from '@rundown-org/parser';
import {
  RunbookActorService,
  RunbookCollectionService,
  RunbookCompletionService,
  RunbookStateManager,
  SessionService,
  InvalidRunbookStateError,
  assertClaimLookupKey,
  assertDelegationTokenHash,
  assertRunId,
  createEffectfulActorMutationRunner,
  type AdvanceInlineParent,
  type CallerEvidence,
  type ClaimLookupKey,
  type EffectfulActorMutationRunner,
  type EffectfulActorMutationSetRunnerInput,
  type InlineUpwardPropagationResult,
  type RunbookState,
  type RunId,
  type TerminalUpwardPropagationResult,
  type ClaimId,
  type ClaimSeenRecordResult,
  type ReleaseRunbookResult,
  type SessionMutationResult,
} from '../../src/runbook/index.js';
import { ErrorCodes } from '../../src/errors/codes.js';
import { logger } from '../../src/logger.js';
import { RundownError } from '../../src/errors/rundown-error.js';
import { getErrorMessage } from '../../src/errors.js';
import {
  createDelegationCredentialIssuer,
  createDelegationTokenDeriver,
} from '../../src/runbook/delegation-credential.js';
import {
  prepareReEntryFrontierConsume,
  readPersistedReEntryFrontier,
} from '../../src/runbook/re-entry-frontier.js';
import { assertDelegationIssuanceNonce } from '../../src/runbook/delegation-token.js';
import { claimCanReportDelegationResult } from '../../src/runbook/claim-id.js';
import { narrowInlineUpwardPropagation } from '../../src/runbook/collection-service.js';
import { COMPLETION_TARGET_MISMATCH_CODE } from '../../src/runbook/completion-service.js';
import type {
  CollectionSessionService,
  RunbookCollectionServiceDependencies,
} from '../../src/runbook/collection-service.js';
import type { ExecutionObservationEffect } from '../../src/events/execution-observation.js';
import type { RecoveryActor } from '../../src/runbook/execution-recovery-service.js';
import { ExecutionLifecycleService } from '../../src/runbook/execution-lifecycle-service.js';
import { brandCurrentCursorResolvedCompletionForTest } from '../../src/runbook/completion-service.js';
import {
  activeFrame,
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
  exactFrame,
} from '../../src/runbook/targeting.js';
import type { ResolvedCompletion } from '../../src/runbook/types.js';
import {
  brandInitialTemplateVarsForTest,
  brandStoredOutputsForTest,
} from '../../src/testing/effective-vars.js';

import { CURRENT_SCHEMA_VERSION } from '../../src/runbook/index.js';

// NOTE: there is no `createTempRunbookStateManager` helper in this repo. Core
// runbook tests build the manager inline with `mkdtemp` + `new
// RunbookStateManager(tmp)` (see completion-service.test.ts). Fixtures mirror the
// proven `ResolvedStep` / `RunbookState` shapes from that suite, with
// `delegate: true` substeps for the collection scenarios.

/** Build a pass/fail transition pair for a substep or step. */
function tx(pass: 'CONTINUE' | 'COMPLETE' | 'STOP', fail: 'CONTINUE' | 'COMPLETE' | 'STOP') {
  return {
    pass: { kind: 'pass', retry: 0, action: { type: pass } },
    fail: { kind: 'fail', retry: 0, action: { type: fail } },
  } as const;
}

/** A real minted claim, as the fixtures present it. */
interface PresentedClaimFixture {
  /** Bearer id the caller presents as `claim_bearer` evidence. */
  readonly claimId: ClaimId;
  /** Lookup key the fence captures and re-checks at commit. */
  readonly claimKey: ClaimLookupKey;
}

/**
 * Build a faked {@link RunbookActorService.prepareActorMutation} return.
 *
 * The transactional drain and the fenced frontier consume both derive through
 * `prepareActorMutation` and read only `nextState` (chained into the next
 * iteration) and `snapshot` (projected into transition observations).
 *
 * @param nextState - The derived state the faked transition produces.
 * @param snapshot - Optional raw machine snapshot for observation projection.
 * @returns A prepared-mutation shaped double.
 */
function preparedMutation(nextState: RunbookState, snapshot: unknown = {}) {
  return { previousState: nextState, nextState, snapshot, effects: [] };
}

function buildCurrentCursorResolvedCompletionForTest(
  input: Parameters<typeof buildResolvedCompletion>[0] & { readonly targetSubstep: string },
) {
  return brandCurrentCursorResolvedCompletionForTest(
    buildResolvedCompletion(input) as ResolvedCompletion & { readonly targetSubstep: string },
  );
}

describe('RunbookCollectionService', () => {
  let tmp: string;
  let manager: RunbookStateManager;
  let actorService: RunbookActorService;
  let lifecycleService: ExecutionLifecycleService;
  let completionService: RunbookCompletionService;
  let sessionService: CollectionSessionService;
  let collectionService: RunbookCollectionService;
  // The REAL project-bound fence. Collect now derives its whole workflow in
  // memory and commits once through `runAll`, so a seam double would make every
  // assertion below about persistence vacuous: capture, commit-time authority
  // revalidation, the owned-set write and the folded session release are exactly
  // what these tests exist to pin. The suite already builds a real store over a
  // tmpdir, so the only thing standing between it and the real fence was a real
  // controlling claim per fixture run — minted in `beforeEach` (see `controlRun`).
  let actorMutationRunner: EffectfulActorMutationRunner;
  // Real session writer used ONLY for fixture setup (mint claims, push runs) and
  // for observing committed session state. The collection seam itself still reads
  // through the `sessionService` fake below, so its policy inputs stay explicit.
  let realSession: SessionService;
  /** Claim key the fake `verifyClaimId` presents; must control the collect target. */
  let presentedClaimKey: ClaimLookupKey;
  /** Bearer id the caller presents; encodes `presentedClaimKey`. */
  let bearerClaimId: ClaimId;
  /** Real claim controlling `controlledRunId`, presented by the terminal fixtures. */
  let controlledClaim: PresentedClaimFixture;
  // Held separately from the fake so assertions reference the spy directly —
  // `sessionService.releaseRunbook` is a declared method, and passing that
  // reference to `expect()` trips `@typescript-eslint/unbound-method`.
  let releaseRunbookSpy: jest.Mock<
    (
      runbookId: RunId,
      options?: { readonly retainClaimsAsTerminal?: boolean },
    ) => Promise<SessionMutationResult<ReleaseRunbookResult>>
  >;
  // Held separately from the fake for the same unbound-method reason as
  // `releaseRunbookSpy` above.
  let recordClaimSeenSpy: jest.Mock<(claimId: ClaimId) => Promise<ClaimSeenRecordResult>>;

  const runId = assertRunId('rd_11111111111111111111111111111111');
  const controlledRunId = assertRunId('rd_22222222222222222222222222222222');
  const ancestorRunId = assertRunId('rd_33333333333333333333333333333333');
  /** A fourth run, used only to give the ancestor a delegating parent of its own. */
  const greatGrandRunId = assertRunId('rd_44444444444444444444444444444444');
  const tokenHash = assertDelegationTokenHash(
    'sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  );

  // Post-R1, collection targets author DELEGATE and therefore classify
  // `delegating`, so bare direct-CLI evidence no longer mints orchestrator
  // trust — the orchestrator supplies bearer claim evidence. The behavioural
  // suites below exercise the collection operation as that verified controller;
  // the refusal twin pinning direct_cli on these fixtures lives in the
  // policy-gate describe.
  //
  // Rebound by `presentClaim` whenever the collect target changes: a bearer id
  // ENCODES its own lookup key (`createDelegationTokenDeriver` refuses a pair that
  // does not agree), so the presented id and the key the fence captures cannot be
  // chosen independently.
  let ORCHESTRATOR_EVIDENCE: CallerEvidence;
  const DIRECT_CLI_EVIDENCE: CallerEvidence = { kind: 'direct_cli' };

  /** Present a minted claim as the collecting orchestrator's bearer. */
  function presentClaim(claim: PresentedClaimFixture): void {
    bearerClaimId = claim.claimId;
    presentedClaimKey = claim.claimKey;
    ORCHESTRATOR_EVIDENCE = { kind: 'claim_bearer', claimId: claim.claimId };
  }

  function frontierEntry(id = '1.1', runbook = 'child-a.md', nonce = 'A') {
    const issued = createDelegationCredentialIssuer(
      { kind: 'bearer', claimId: bearerClaimId, claimKey: presentedClaimKey },
      () => assertDelegationIssuanceNonce(`${nonce.repeat(42)}A`),
    )({
      parentRunId: runId,
      parentStepId: id,
      parentFrameKey: buildFrameKey('1'),
      parentEntry: 1,
    });
    return {
      persisted: {
        id,
        runbook,
        credential: issued.credential,
        tokenHash: issued.tokenHash,
      },
      public: { id, runbook, token: issued.token },
    };
  }

  // Default runbook: step 1 delegates two substeps (PASS CONTINUE so a full
  // drain advances the run to step 2 while staying `running`); step 2 is a
  // plain post-aggregation step.
  const steps: ResolvedStep[] = [
    {
      kind: 'substeps',
      name: '1',
      description: 'Delegate work',
      aggregation: { strategy: 'ALL' },
      substeps: [
        { id: '1', description: 'A', delegate: true, transitions: tx('CONTINUE', 'STOP') },
        { id: '2', description: 'B', delegate: true, transitions: tx('CONTINUE', 'STOP') },
      ],
      transitions: tx('CONTINUE', 'STOP'),
    },
    {
      kind: 'base',
      name: '2',
      description: 'After collection',
      transitions: tx('CONTINUE', 'STOP'),
    },
  ];

  function state(overrides: Partial<RunbookState> = {}): RunbookState {
    return {
      prompted: false,
      id: runId,
      runbook: { source: 'project', path: 'collection-test.md' },
      runbookPath: 'collection-test.md',
      step: '1',
      substep: '1',
      stepName: 'Delegate work',
      retryCount: 0,
      variables: brandStoredOutputsForTest({}),
      templateVars: brandInitialTemplateVarsForTest({
        ContextId: 'ctx',
        WorkPath: '.rundown/work',
      }),
      steps: [],
      lifecycle: 'running',
      startedAt: '2026-06-17T00:00:00.000Z',
      updatedAt: '2026-06-17T00:00:00.000Z',
      activeFrameKey: buildFrameKey('1'),
      activeEntry: 1,
      frameEntryCounts: { [buildFrameKey('1')]: 1 },
      substepStates: [
        { id: '1', frameKey: buildFrameKey('1'), status: 'done' },
        { id: '2', frameKey: buildFrameKey('1'), status: 'done' },
      ],
      resolvedCompletions: {},
      schemaVersion: CURRENT_SCHEMA_VERSION,
      frontmatterOutputs: [],
      ...overrides,
    };
  }

  /**
   * Give a fixture run its REAL controlling claim and put it on the default stack.
   *
   * The fence captures `(run, claim)` from the store, so a run with no active
   * controlling claim is refused `claim_superseded` before any preparation runs.
   * Pushing onto the default stack is what makes the transaction's folded session
   * release observable (a released run leaves the stack).
   *
   * @param target - Fixture run to claim.
   * @returns The persisted claim's lookup key.
   */
  async function controlRun(target: RunId): Promise<PresentedClaimFixture> {
    const issued = await realSession.pushRunbookWithRunControlClaim(target);
    if (issued.kind !== 'committed') {
      throw new Error(`fixture could not mint a controlling claim for ${target}: ${issued.kind}`);
    }
    return { claimId: issued.value.claimId, claimKey: issued.value.claim.claimKey };
  }

  /** Rotate a run's controlling claim, invalidating the captured one. */
  async function rotateControllingClaim(target: RunId): Promise<void> {
    const rotated = await realSession.issueRunControlClaim(target);
    if (rotated.kind !== 'committed') {
      throw new Error(`fixture could not rotate the claim for ${target}: ${rotated.kind}`);
    }
  }

  /** Read the committed session default stack. */
  async function defaultStack(): Promise<readonly RunId[]> {
    return (await manager.loadSession()).defaultStack;
  }

  /**
   * Read a run's committed re-entry frontier through the canonical reader.
   *
   * `readPersistedReEntryFrontier` is the single validating reader for that blob
   * (the same one the seam uses), so an assertion built on it cannot drift from
   * what the seam would see.
   *
   * @param target - Run whose committed snapshot is read.
   * @returns The validated frontier entries; empty when none is persisted.
   */
  async function persistedFrontier(target: RunId) {
    const loaded = await manager.load(target);
    if (!loaded) throw new Error(`run ${target} must exist`);
    return readPersistedReEntryFrontier(loaded);
  }

  /**
   * Wrap the real runner so `effect` lands AFTER capture and preparation but
   * strictly BEFORE the fence acquires and commits.
   *
   * The same shape as `runnerWithFenceEntryHook` in
   * `lifecycle-command-service.test.ts`, moved one stage later: hooking
   * `beforeEffect`'s return is the only point that is provably after the
   * collection has captured its state and derived its whole workflow, and still
   * before a single byte is written. That window is exactly where the old
   * per-write design was blind — it had already committed applies by then.
   *
   * @param effect - Concurrent mutation to commit inside the window.
   * @returns A runner that fires `effect` once per aggregate invocation.
   */
  function runnerWithPreCommitEffect(effect: () => Promise<void>): EffectfulActorMutationRunner {
    return {
      run: (input) => actorMutationRunner.run(input),
      async runAll<TResult>(input: EffectfulActorMutationSetRunnerInput<TResult>) {
        return await actorMutationRunner.runAll<TResult>({
          ...input,
          beforeEffect: async (captured) => {
            const decision = (await input.beforeEffect?.(captured)) ?? {
              kind: 'continue' as const,
            };
            await effect();
            return decision;
          },
        });
      },
    };
  }

  /** Build a collection service over the standard fixture dependencies. */
  function makeCollectionService(
    overrides: Partial<RunbookCollectionServiceDependencies> = {},
  ): RunbookCollectionService {
    return new RunbookCollectionService({
      sessionService,
      manager,
      actorService,
      lifecycleService,
      completionService,
      actorMutationRunner,
      // Default fake: pre-existing tests never drive a target terminal that
      // carries INLINE linkage, so a never-resolving-terminal fake satisfies the
      // required dep. Inline-advance tests below construct their own spy.
      advanceInlineParent: jest
        .fn<AdvanceInlineParent>()
        .mockRejectedValue(new Error('advanceInlineParent must not be called by this test')),
      // Default loader for aggregate members other than the collect target.
      // Most fixtures here seed the parent from the SAME step graph, so the
      // shared fixture is the honest default; the recovery-wiring tests below
      // override it with a spy that returns the parent's own steps.
      loadSteps: () => steps,
      ...overrides,
    });
  }

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'collection-service-'));
    manager = new RunbookStateManager(tmp);
    actorService = new RunbookActorService(manager);
    lifecycleService = new ExecutionLifecycleService(manager);
    completionService = new RunbookCompletionService(manager, actorService);
    realSession = new SessionService(manager);
    actorMutationRunner = createEffectfulActorMutationRunner(tmp);
    releaseRunbookSpy = jest.fn(async (runbookId: RunId) => ({
      kind: 'committed' as const,
      value: {
        status: 'released' as const,
        runbookId,
        removedFromDefaultStack: true,
        nextDefaultRunbookId: null,
      },
    }));
    recordClaimSeenSpy = jest.fn(async () => ({
      kind: 'recorded' as const,
      claimKey: presentedClaimKey,
      lastSeenAt: '2026-06-28T00:00:00.000Z',
    }));
    sessionService = {
      async getActive() {
        return null;
      },
      async resolveRunningStackMember() {
        return { kind: 'not_on_stack' };
      },
      async getActiveForClaimId() {
        return { status: 'missing', claimId: bearerClaimId };
      },
      async verifyClaimId(presentedClaimId) {
        expect(presentedClaimId).toBe(bearerClaimId);
        return {
          status: 'verified',
          claim: {
            // The REAL key of the claim controlling the run under collection: the
            // fence captures and re-checks it, so a synthesized key would be
            // refused `claim_superseded` before any preparation ran.
            claimKey: presentedClaimKey,
            controlledRunId: runId,
            grants: [
              { action: 'collect-for-run', runId },
              { action: 'collect-for-run', runId: controlledRunId },
              {
                action: 'report-delegation-result',
                childRunId: controlledRunId,
                tokenHash,
                parentRunId: ancestorRunId,
                parentStepId: '1.1',
                parentStep: '1',
                parentFrameKey: buildFrameKey('1'),
                parentEntry: 1,
              },
            ],
          },
        };
      },
      async listOpenClaimsForParent() {
        return [];
      },
      releaseRunbook: releaseRunbookSpy,
      recordClaimSeen: recordClaimSeenSpy,
    };
    // Seed the three fixture runs and their REAL controlling claims up front:
    // `frontierEntry()` binds credentials to the presented claim key and is called
    // by tests before they save their own target, so the key has to exist from the
    // first line of every test. Tests overwrite these rows with `manager.save`.
    await manager.save(state());
    await manager.save(state({ id: controlledRunId }));
    await manager.save(state({ id: ancestorRunId, resolvedCompletions: {} }));
    presentClaim(await controlRun(runId));
    controlledClaim = await controlRun(controlledRunId);
    await controlRun(ancestorRunId);
    collectionService = makeCollectionService();
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it.each<[string, CallerEvidence]>([
    ['plugin', { kind: 'plugin', agentId: 'subagent-1' }],
    ['mcp', { kind: 'mcp', toolName: 'collect' }],
    ['unknown', { kind: 'unknown' }],
  ])(
    'refuses collection with actor_context_required for %s caller evidence (no minted trust)',
    async (_kind, callerEvidence) => {
      await manager.save(state());

      // The seam maps evidence to trust in core: plugin/mcp/unknown evidence maps
      // to UNKNOWN_ACTOR_CONTEXT regardless of metadata, so the existing policy
      // gate refuses before inspecting any outcome state.
      await expect(
        collectionService.collectDelegationOutcomes({
          targetState: state(),
          steps,
          callerEvidence,
        }),
      ).resolves.toEqual({
        kind: 'actor_context_required',
        intent: 'delegation-collection',
      });
    },
  );

  it('refuses bare direct-CLI collection on a delegating target — ambient trust removed (#460)', async () => {
    // The collection target authors DELEGATE substeps, so it classifies
    // `delegating`; bare direct_cli evidence maps to the unknown context and
    // the orchestrator gate refuses before inspecting any outcome state. The
    // orchestrator authorizes with its run-control bearer claim; the child lane
    // is its own claim.
    await manager.save(state());

    await expect(
      collectionService.collectDelegationOutcomes({
        targetState: state(),
        steps,
        callerEvidence: DIRECT_CLI_EVIDENCE,
      }),
    ).resolves.toEqual({
      kind: 'actor_context_required',
      intent: 'delegation-collection',
    });
  });

  it('reports missing outcomes for delegate substeps not yet resolved in the frame', async () => {
    // Neither delegate substep is `done` in the target frame, so both are
    // pending (the gate is per-frame `status === 'done'`, matching collect.ts).
    const target = state({ substepStates: [] });
    await manager.save(target);

    await expect(
      collectionService.collectDelegationOutcomes({
        targetState: target,
        steps,
        callerEvidence: ORCHESTRATOR_EVIDENCE,
      }),
    ).resolves.toEqual({
      kind: 'missing_outcomes',
      targetRunId: runId,
      step: '1',
      missingSubsteps: ['1.1', '1.2'],
      supersededSubsteps: [],
    });
  });

  it('returns already_collected when no unapplied outcomes remain on a post-delegate cursor', async () => {
    const target = state({
      step: '2',
      substep: undefined,
      activeFrameKey: buildFrameKey('2'),
      activeEntry: 1,
      // Both delegate substeps of step 1 are done in their frame — the
      // post-aggregation cursor evidence isPostDelegateAggregationCursor needs.
      substepStates: [
        { id: '1', frameKey: buildFrameKey('1'), status: 'done' },
        { id: '2', frameKey: buildFrameKey('1'), status: 'done' },
      ],
      resolvedCompletions: {},
    });
    await manager.save(target);

    await expect(
      collectionService.collectDelegationOutcomes({
        targetState: target,
        steps,
        callerEvidence: ORCHESTRATOR_EVIDENCE,
      }),
    ).resolves.toMatchObject({
      kind: 'already_collected',
      targetRunId: runId,
      step: '2',
    });
    // Authorization established orchestrator liveness before this idempotent
    // no-op was discovered.
    expect(recordClaimSeenSpy).toHaveBeenCalledWith(bearerClaimId);
  });

  it('applies reported delegation outcomes through the state machine', async () => {
    // The real machine cannot be reconstructed from a hand-built fixture at a
    // DELEGATE cursor (entering the substep auto-spawns a delegation issue actor
    // that needs a persisted xstate snapshot — see compiler.ts spawnChild input).
    // Genuine spawn→issue→drain→aggregate e2e is pinned at the CLI layer
    // (collect.test.ts). Here we spy the lowest actor seam so the REAL
    // `prepareResolvedCompletionDrain` orchestration and the REAL collection
    // mapping run; only the XState dispatch is faked. That seam is now
    // `prepareActorMutation`, not `sendAndSync`: the transactional drain DERIVES
    // each transition and chains the next iteration off the derived state instead
    // of committing one transaction per completion.
    const frameKey = buildFrameKey('1');
    const target = state({
      resolvedCompletions: {
        [buildCompletionKey(activeFrame(frameKey, 1), '1')]: buildResolvedCompletion({
          agentId: 'delegated-a',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: activeFrame(frameKey, 1),
          completedAt: '2026-06-17T00:01:00.000Z',
        }),
        [buildCompletionKey(activeFrame(frameKey, 1), '2')]: buildResolvedCompletion({
          agentId: 'delegated-b',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '2',
          targetFrame: activeFrame(frameKey, 1),
          completedAt: '2026-06-17T00:02:00.000Z',
        }),
      },
    });
    await manager.save(target);

    // Apply substep 1 (cursor → substep 2), then substep 2 (cursor → step 2),
    // both keeping the run `running`; drain then exits at the non-substep step.
    jest
      .spyOn(actorService, 'prepareActorMutation')
      .mockResolvedValueOnce(
        preparedMutation(state({ substep: '2', resolvedCompletions: target.resolvedCompletions })),
      )
      .mockResolvedValueOnce(
        preparedMutation(state({ step: '2', substep: undefined, lifecycle: 'running' })),
      );

    const outcome = await collectionService.collectDelegationOutcomes({
      targetState: target,
      steps,
      callerEvidence: ORCHESTRATOR_EVIDENCE,
      frame: activeFrame(frameKey, 1),
    });

    expect(outcome).toMatchObject({
      kind: 'collection_applied',
      targetRunId: runId,
      step: '1',
      applied: 2,
      unresolved: 0,
      lifecycle: 'running',
      reportedTerminalOutcome: false,
    });
    expect(outcome.kind).toBe('collection_applied');
    if (outcome.kind !== 'collection_applied') throw new Error('expected collection_applied');
    expect(outcome.transitionObservations).toMatchObject([
      {
        type: 'STEP_TRANSITIONED',
        payload: {
          action: 'CONTINUE',
          from: '1.1',
          at: '1.2',
          result: 'PASS',
        },
      },
      {
        type: 'STEP_TRANSITIONED',
        payload: {
          action: 'CONTINUE',
          from: '1.2',
          at: '2',
          result: 'PASS',
        },
      },
    ]);
  });

  it('carries collector-bound delegation capabilities on a still-running collection', async () => {
    // A running collection leaves the frontend a continuation to drive, and that
    // continuation can step INTO a DELEGATE step. Machine-owned issuance needs a
    // verified issuer at that moment and the next turn needs the same-issuer
    // deriver, so both travel out on the outcome — bound to the authority core
    // verified for `collect-for-run` on this target, never minted by the caller.
    const frameKey = buildFrameKey('1');
    const target = state({
      resolvedCompletions: {
        [buildCompletionKey(activeFrame(frameKey, 1), '1')]: buildResolvedCompletion({
          agentId: 'delegated-a',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: activeFrame(frameKey, 1),
          completedAt: '2026-06-17T00:01:00.000Z',
        }),
        [buildCompletionKey(activeFrame(frameKey, 1), '2')]: buildResolvedCompletion({
          agentId: 'delegated-b',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '2',
          targetFrame: activeFrame(frameKey, 1),
          completedAt: '2026-06-17T00:02:00.000Z',
        }),
      },
    });
    await manager.save(target);
    jest
      .spyOn(actorService, 'prepareActorMutation')
      .mockResolvedValueOnce(
        preparedMutation(state({ substep: '2', resolvedCompletions: target.resolvedCompletions })),
      )
      .mockResolvedValueOnce(
        preparedMutation(state({ step: '2', substep: undefined, lifecycle: 'running' })),
      );

    const outcome = await collectionService.collectDelegationOutcomes({
      targetState: target,
      steps,
      callerEvidence: ORCHESTRATOR_EVIDENCE,
      frame: activeFrame(frameKey, 1),
    });

    if (outcome.kind !== 'collection_applied') throw new Error('expected collection_applied');
    // One BRANDED pair, not two independently optional fields: issuance and
    // derivation are two halves of one verified authority, so the outcome either
    // carries both or neither.
    const runtime = outcome.delegationRuntime;
    if (!runtime) throw new Error('expected delegation capabilities on a running collect');
    const issue = runtime.issueDelegationCredential;
    const derive = runtime.deriveDelegationToken;

    const issued = issue({
      parentRunId: runId,
      parentStepId: '2.1',
      parentFrameKey: buildFrameKey('2'),
      parentEntry: 1,
    });
    // Bound to the VERIFIED COLLECTOR: the claim key core proved holds
    // `collect-for-run` on this target — and therefore, being a run-control
    // claim, `delegate-from-run` on it too.
    expect(issued.credential.issuerClaimKey).toBe(presentedClaimKey);
    // Same-issuer pair: the deriver reproduces exactly what the issuer minted,
    // which is what the continuation's next turn needs to project the frontier.
    expect(derive(issued.credential)).toBe(issued.token);
    // ...and only that issuer's credentials (RD-821). The pair cannot be turned
    // on descriptors another claim owns.
    expect(() =>
      derive({
        ...issued.credential,
        issuerClaimKey: assertClaimLookupKey('rdclk_99999999999999999999999999999999'),
      }),
    ).toThrow('Delegation credential belongs to a different issuer claim');
  });

  it('projects retry re-entry observations through the collection outcome and consumes the frontier', async () => {
    const frameKey = buildFrameKey('1');
    const target = state({
      resolvedCompletions: {
        [buildCompletionKey(activeFrame(frameKey, 1), '1')]: buildResolvedCompletion({
          agentId: 'delegated-a',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: activeFrame(frameKey, 1),
          completedAt: '2026-06-17T00:01:00.000Z',
        }),
        [buildCompletionKey(activeFrame(frameKey, 1), '2')]: buildResolvedCompletion({
          agentId: 'delegated-b',
          result: 'fail',
          targetStep: '1',
          targetSubstep: '2',
          targetFrame: activeFrame(frameKey, 1),
          completedAt: '2026-06-17T00:02:00.000Z',
        }),
      },
    });
    await manager.save(target);

    const firstAfter = state({
      substep: '2',
      resolvedCompletions: target.resolvedCompletions,
    });
    const retryA = frontierEntry('1.1', 'child-a.md', 'A');
    const retryB = frontierEntry('1.2', 'child-b.md', 'B');
    const retryState = state({
      step: '1',
      substep: '1',
      retryCount: 1,
      resolvedCompletions: target.resolvedCompletions,
      snapshot: {
        context: {
          delegateFrontier: [retryA.persisted, retryB.persisted],
        },
      },
    });
    const frontierEffects: readonly ExecutionObservationEffect[] = [
      {
        kind: 'execution_observation',
        event: {
          type: 'STEP_ENTERED',
          payload: {
            position: { current: '1', total: 2, substep: '1' },
            stepName: '1',
            hasCommand: false,
            isSubstep: true,
            prompted: false,
            artifacts: {},
            delegateFrontier: [retryA.public, retryB.public],
          },
        },
      },
    ];

    jest.spyOn(completionService, 'prepareResolvedCompletionDrain').mockResolvedValue({
      status: 'continue',
      state: retryState,
      unresolved: 2,
      applied: [
        {
          key: buildCompletionKey(activeFrame(frameKey, 1), '1'),
          completion: buildCurrentCursorResolvedCompletionForTest({
            agentId: 'delegated-a',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '1',
            targetFrame: activeFrame(frameKey, 1),
            completedAt: '2026-06-17T00:01:00.000Z',
          }),
          stateBefore: target,
          stateAfter: firstAfter,
          snapshot: { context: { lastAction: { type: 'CONTINUE', origin: 'direct' } } },
        },
        {
          key: buildCompletionKey(activeFrame(frameKey, 1), '2'),
          completion: buildCurrentCursorResolvedCompletionForTest({
            agentId: 'delegated-b',
            result: 'fail',
            targetStep: '1',
            targetSubstep: '2',
            targetFrame: activeFrame(frameKey, 1),
            completedAt: '2026-06-17T00:02:00.000Z',
          }),
          stateBefore: firstAfter,
          stateAfter: retryState,
          snapshot: { context: { lastAction: { type: 'RETRY', origin: 'aggregation' } } },
        },
      ],
    });
    await manager.save(retryState);

    const consumedState = state({ ...retryState, snapshot: { context: {} } });
    const consumeSpy = jest
      .spyOn(actorService, 'prepareActorMutation')
      .mockResolvedValueOnce(preparedMutation(consumedState, { context: {} }));
    const enterEntrySpy = jest
      .spyOn(actorService, 'enterExecutionUnit')
      .mockResolvedValue({ kind: 'awaiting', effects: frontierEffects });

    const outcome = await collectionService.collectDelegationOutcomes({
      targetState: target,
      steps,
      callerEvidence: ORCHESTRATOR_EVIDENCE,
      frame: activeFrame(frameKey, 1),
    });

    expect(outcome.kind).toBe('collection_applied');
    if (outcome.kind !== 'collection_applied') throw new Error('expected collection_applied');
    expect(outcome.transitionObservations.at(-1)).toMatchObject({
      type: 'STEP_TRANSITIONED',
      payload: {
        action: 'RETRY',
        from: '1.2',
        at: '1.1',
        result: 'FAIL',
        aggregated: true,
      },
    });
    expect(outcome.reEntryObservations).toEqual(frontierEffects);
    expect(enterEntrySpy).toHaveBeenCalledTimes(1);
    // Asserted on the captured call rather than through `toHaveBeenCalledWith`:
    // jest's recursive `AsymmetricMatcher` mapped type expands over `RunbookState`
    // in this signature and trips TS2589 ("type instantiation is excessively
    // deep"). Reading the arguments keeps every fact the matcher pinned.
    const consumeCall = consumeSpy.mock.calls.at(-1);
    expect(consumeCall?.[0]).toBe(runId);
    expect(consumeCall?.[1]).toEqual(retryState);
    expect(consumeCall?.[2]).toEqual(steps);
    expect(consumeCall?.[3]).toEqual({ type: 'DELEGATE_FRONTIER_CONSUMED' });
    // The consume is DERIVED, not committed on its own: it reaches the store only
    // through the collection's single owned-set commit, which is what leaves the
    // frontier consumed exactly when the applies it accompanies are.
    expect(await persistedFrontier(runId)).toEqual([]);
  });

  it('discloses no bearers and consumes no frontier when the enclosing commit refuses', async () => {
    // REPLACES "returns collection_failed without frontier observations when
    // retry frontier consume fails" and its F6 twin. `consume_failed` is no longer
    // reachable from collect: the consume is derived, not committed, so it cannot
    // half-land — the only way it does not reach the store is that the whole
    // transaction refused. `prepareReEntryFrontierConsume`'s union omits the arm
    // for exactly that reason. The operator-visible condition the old test named
    // (projection succeeded, consume did not land, nothing disclosed) survives and
    // is pinned here against the transactional refusal that now covers it.
    const frameKey = buildFrameKey('1');
    const retry = frontierEntry();
    const target = state({
      retryCount: 1,
      snapshot: { context: { delegateFrontier: [retry.persisted] } },
    });
    await manager.save(target);
    jest.spyOn(completionService, 'prepareResolvedCompletionDrain').mockResolvedValue({
      status: 'continue',
      state: target,
      unresolved: 1,
      applied: [],
    });
    // The consume DERIVES cleanly — the projection half succeeds, exactly as in
    // the old `consume_failed` scenario. What differs is that the derived state
    // reaches the store only through the collection's one commit.
    jest
      .spyOn(actorService, 'prepareActorMutation')
      .mockResolvedValue(preparedMutation(state({ ...target, snapshot: { context: {} } })));
    const enterEntrySpy = jest.spyOn(actorService, 'enterExecutionUnit');
    const svc = makeCollectionService({
      actorMutationRunner: runnerWithPreCommitEffect(async () => {
        await manager.save({ ...target, retryCount: 2 });
      }),
    });

    const outcome = await svc.collectDelegationOutcomes({
      targetState: target,
      steps,
      callerEvidence: ORCHESTRATOR_EVIDENCE,
      frame: activeFrame(frameKey, 1),
    });

    expect(outcome).toMatchObject({ kind: 'concurrent_modification', runId });
    // No disclosure: observation is strictly post-commit, so a refused commit
    // reconstructs no bearers at all.
    expect(enterEntrySpy).not.toHaveBeenCalled();
    // ...and the frontier is still persisted, so the next collect re-projects it.
    expect(await persistedFrontier(runId)).toEqual([retry.persisted]);
  });

  it('re-projects and consumes a pending retry frontier on a later no-op collect', async () => {
    // Retryable-frontier regression: a PRIOR collect projected a retry frontier
    // whose transaction refused, so the frontier stays persisted. A later collect
    // drains nothing new (applied:0) but MUST still re-project + consume the
    // pending frontier and surface its observations — not strand it behind a
    // terminal `already_collected` no-op.
    const frameKey = buildFrameKey('1');
    const retry = frontierEntry();
    const target = state({
      retryCount: 1,
      snapshot: {
        context: {
          delegateFrontier: [retry.persisted],
        },
      },
    });
    await manager.save(target);

    // Drain finds no unapplied outcomes for the scope (the earlier collect
    // already applied them): status 'continue' with applied: [].
    jest.spyOn(completionService, 'prepareResolvedCompletionDrain').mockResolvedValue({
      status: 'continue',
      state: target,
      unresolved: 1,
      applied: [],
    });
    const reEntryEffects: readonly ExecutionObservationEffect[] = [
      {
        kind: 'execution_observation',
        event: {
          type: 'STEP_ENTERED',
          payload: {
            position: { current: '1', total: 2, substep: '1' },
            stepName: '1',
            hasCommand: false,
            isSubstep: true,
            prompted: false,
            artifacts: {},
            delegateFrontier: [retry.public],
          },
        },
      },
    ];
    const enterEntrySpy = jest
      .spyOn(actorService, 'enterExecutionUnit')
      .mockResolvedValue({ kind: 'awaiting', effects: reEntryEffects });
    // Frontier consume derives cleanly this time, so the projection is surfaced.
    const consumeSpy = jest
      .spyOn(actorService, 'prepareActorMutation')
      .mockResolvedValue(preparedMutation(target, { context: {} }));

    const outcome = await collectionService.collectDelegationOutcomes({
      targetState: target,
      steps,
      callerEvidence: ORCHESTRATOR_EVIDENCE,
      frame: activeFrame(frameKey, 1),
    });

    expect(outcome).toMatchObject({
      kind: 'collection_applied',
      targetRunId: runId,
      applied: 0,
      reEntryObservations: reEntryEffects,
    });
    expect(enterEntrySpy).toHaveBeenCalledTimes(1);
    // Read the captured call rather than matching it: see the TS2589 note above.
    const consumeCall = consumeSpy.mock.calls.at(-1);
    expect(consumeCall?.[0]).toBe(runId);
    expect(consumeCall?.[1]).toEqual(target);
    expect(consumeCall?.[2]).toEqual(steps);
    expect(consumeCall?.[3]).toEqual({ type: 'DELEGATE_FRONTIER_CONSUMED' });
  });

  it('returns already_collected when the scope has no unapplied outcomes to drain', async () => {
    // Idempotent no-op: every delegate substep is done and carries a reported
    // outcome (gate passes), but the cursor has advanced off the substeps
    // (`substep` undefined), so the real drain applies nothing and reports
    // status:'continue' with applied:0 — collection maps that to already_collected.
    const frameKey = buildFrameKey('1');
    const target = state({
      substep: undefined,
      resolvedCompletions: {
        [buildCompletionKey(activeFrame(frameKey, 1), '1')]: buildResolvedCompletion({
          agentId: 'delegated-a',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: activeFrame(frameKey, 1),
          completedAt: '2026-06-17T00:01:00.000Z',
        }),
        [buildCompletionKey(activeFrame(frameKey, 1), '2')]: buildResolvedCompletion({
          agentId: 'delegated-b',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '2',
          targetFrame: activeFrame(frameKey, 1),
          completedAt: '2026-06-17T00:02:00.000Z',
        }),
      },
    });
    await manager.save(target);

    await expect(
      collectionService.collectDelegationOutcomes({
        targetState: target,
        steps,
        callerEvidence: ORCHESTRATOR_EVIDENCE,
        frame: activeFrame(frameKey, 1),
      }),
    ).resolves.toMatchObject({
      kind: 'already_collected',
      targetRunId: runId,
      step: '1',
    });
  });

  it('allows a claim controller to collect outcomes for delegations issued by its controlled run', async () => {
    // substepStates empty → both substeps pending → reaches the missing-outcome
    // gate (proving the claim controller passed the orchestrator role check).
    const controlled = state({ id: controlledRunId, substepStates: [] });
    await manager.save(controlled);

    await expect(
      collectionService.collectDelegationOutcomes({
        targetState: controlled,
        steps,
        callerEvidence: ORCHESTRATOR_EVIDENCE,
      }),
    ).resolves.toMatchObject({
      kind: 'missing_outcomes',
      targetRunId: controlledRunId,
      step: '1',
      missingSubsteps: ['1.1', '1.2'],
      supersededSubsteps: [],
    });
  });

  it('rejects a bearer collecting into an ancestor without collect-for-run on that ancestor', async () => {
    const ancestor = state({ id: ancestorRunId });
    await manager.save(ancestor);

    await expect(
      collectionService.collectDelegationOutcomes({
        targetState: ancestor,
        steps,
        callerEvidence: ORCHESTRATOR_EVIDENCE,
      }),
    ).resolves.toEqual({
      kind: 'claim_grant_required',
      intent: 'delegation-collection',
      targetRunId: ancestorRunId,
    });
  });

  it('fails with STEP_NOT_FOUND when the selected step is absent from the loaded runbook', async () => {
    const target = state();
    await manager.save(target);

    await expect(
      collectionService.collectDelegationOutcomes({
        targetState: target,
        steps,
        callerEvidence: ORCHESTRATOR_EVIDENCE,
        stepName: 'does-not-exist',
      }),
    ).resolves.toEqual({
      kind: 'collection_failed',
      targetRunId: runId,
      reason: 'step_not_found',
      code: 'STEP_NOT_FOUND',
      message: expect.stringContaining('does-not-exist'),
    });
  });

  it('fails with NOT_DELEGATE_STEP for a non-DELEGATE step that is not a post-aggregation cursor', async () => {
    // Cursor on step 2 (a plain step) with no prior aggregation evidence — a bare
    // collect here is misuse, surfaced as NOT_DELEGATE_STEP.
    const target = state({
      step: '2',
      substep: undefined,
      activeFrameKey: buildFrameKey('2'),
      substepStates: [],
      resolvedCompletions: {},
    });
    await manager.save(target);

    await expect(
      collectionService.collectDelegationOutcomes({
        targetState: target,
        steps,
        callerEvidence: ORCHESTRATOR_EVIDENCE,
      }),
    ).resolves.toMatchObject({
      kind: 'collection_failed',
      targetRunId: runId,
      reason: 'not_delegate_step',
      code: 'NOT_DELEGATE_STEP',
      // Pin the diagnostic text, not just the code: the message names the step and
      // explains the misuse, so an emptied/garbled message is a regression.
      message: expect.stringContaining('is not a DELEGATE step'),
    });
  });

  it('reports missing_outcomes for a partial collection (only one of two delegate substeps resolved)', async () => {
    // Substep 1 is done in the frame; substep 2 is not. The per-frame status
    // gate fires before any drain, listing exactly the unresolved substep.
    const frameKey = buildFrameKey('1');
    const target = state({
      substepStates: [{ id: '1', frameKey, status: 'done' }],
    });
    await manager.save(target);

    await expect(
      collectionService.collectDelegationOutcomes({
        targetState: target,
        steps,
        callerEvidence: ORCHESTRATOR_EVIDENCE,
        frame: activeFrame(frameKey, 1),
      }),
    ).resolves.toEqual({
      kind: 'missing_outcomes',
      targetRunId: runId,
      step: '1',
      missingSubsteps: ['1.2'],
      supersededSubsteps: [],
    });
  });

  // A single-DELEGATE-substep runbook used by the terminal-reporting tests.
  const oneSubstepSteps: ResolvedStep[] = [
    {
      kind: 'substeps',
      name: '1',
      description: 'Delegate work',
      aggregation: { strategy: 'ALL' },
      substeps: [
        { id: '1', description: 'A', delegate: true, transitions: tx('COMPLETE', 'STOP') },
      ],
      transitions: tx('COMPLETE', 'STOP'),
    },
  ];

  it('treats a delegate substep with a live outcome row as ready even when status is not done', async () => {
    const frameKey = buildFrameKey('1');
    const target = state({
      id: runId,
      substep: '1',
      substepStates: [{ id: '1', frameKey, status: 'pending' }],
      resolvedCompletions: {
        [buildCompletionKey(activeFrame(frameKey, 1), '1')]: buildResolvedCompletion({
          agentId: 'delegation',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: activeFrame(frameKey, 1),
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    });
    await manager.save(target);
    // prepareActorMutation is spied so the real machine is never reconstructed;
    // the live row is the authoritative outcome signal, so readiness must not
    // refuse.
    jest
      .spyOn(actorService, 'prepareActorMutation')
      .mockResolvedValue(
        preparedMutation(state({ id: runId, step: '1', substep: undefined, lifecycle: 'running' })),
      );
    const result = await collectionService.collectDelegationOutcomes({
      targetState: target,
      steps: oneSubstepSteps,
      callerEvidence: ORCHESTRATOR_EVIDENCE,
      frame: activeFrame(frameKey, 1),
    });
    // Readiness must NOT refuse: the live row is the authoritative outcome signal,
    // so collection proceeds and drains the row (asserting the exact success kind
    // rather than merely `not missing_outcomes`, which unrelated refusals like
    // `collection_failed` would also satisfy).
    expect(result.kind).toBe('collection_applied');
  });

  it('does not treat a row left at a superseded entry as ready (#749)', async () => {
    // The mirror image of the test above, and the readiness half of #749: the
    // outcome was reported at entry 1, then a GOTO/RETRY re-entry bumped the
    // frame to entry 2. The drain resolves rows against the LIVE entry, so this
    // row is unreachable — counting it as ready would report every substep
    // resolved and then drain nothing.
    const frameKey = buildFrameKey('1');
    const target = state({
      id: runId,
      substep: '1',
      activeEntry: 2,
      frameEntryCounts: { [frameKey]: 2 },
      substepStates: [{ id: '1', frameKey, status: 'pending' }],
      resolvedCompletions: {
        [buildCompletionKey(exactFrame(frameKey, 1), '1')]: buildResolvedCompletion({
          agentId: 'delegation',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: exactFrame(frameKey, 1),
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    });
    await manager.save(target);

    await expect(
      collectionService.collectDelegationOutcomes({
        targetState: target,
        steps: oneSubstepSteps,
        callerEvidence: ORCHESTRATOR_EVIDENCE,
        frame: activeFrame(frameKey, 2),
      }),
    ).resolves.toEqual({
      kind: 'missing_outcomes',
      targetRunId: runId,
      step: '1',
      missingSubsteps: ['1.1'],
      // Reported, then stranded — so the refusal must name it as the case
      // `delegate --retry` fixes rather than leave the operator waiting on a
      // child that already finished.
      supersededSubsteps: ['1.1'],
    });
  });

  it('separates a never-reported substep from a superseded one (#749)', async () => {
    // Both substeps are missing, for different reasons: 1.1's outcome was
    // reported at the entry the re-entry superseded, while 1.2's only row
    // belongs to a different frame entirely (another FOR iteration) — that is
    // not this scope's work at all, so it carries no remedy. Only a row on THIS
    // frame at a superseded entry does.
    const frameKey = buildFrameKey('1');
    const otherFrameKey = buildFrameKey('1', 2);
    const target = state({
      id: runId,
      substep: '1',
      activeEntry: 2,
      frameEntryCounts: { [frameKey]: 2 },
      substepStates: [
        { id: '1', frameKey, status: 'pending' },
        { id: '2', frameKey, status: 'pending' },
      ],
      resolvedCompletions: {
        [buildCompletionKey(exactFrame(frameKey, 1), '1')]: buildResolvedCompletion({
          agentId: 'delegation',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: exactFrame(frameKey, 1),
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
        [buildCompletionKey(exactFrame(otherFrameKey, 3), '2')]: buildResolvedCompletion({
          agentId: 'delegation',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '2',
          targetIteration: 2,
          targetFrame: exactFrame(otherFrameKey, 3),
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    });
    await manager.save(target);

    await expect(
      collectionService.collectDelegationOutcomes({
        targetState: target,
        steps,
        callerEvidence: ORCHESTRATOR_EVIDENCE,
        frame: activeFrame(frameKey, 2),
      }),
    ).resolves.toEqual({
      kind: 'missing_outcomes',
      targetRunId: runId,
      step: '1',
      missingSubsteps: ['1.1', '1.2'],
      supersededSubsteps: ['1.1'],
    });
  });

  const delegationLinkage = {
    kind: 'delegation' as const,
    parentRunId: ancestorRunId,
    parentStepId: '1.1',
    parentStep: '1',
    parentFrameKey: buildFrameKey('1'),
    parentEntry: 1,
    tokenHash,
  };

  const inlineLinkage = {
    kind: 'inline' as const,
    parentRunId: ancestorRunId,
    parentStepId: '1.1',
    parentStep: '1',
    parentFrameKey: buildFrameKey('1'),
    parentEntry: 1,
  };

  /** Seed a terminal controlled run with one resolved DELEGATE substep + ancestor. */
  async function seedTerminalControlled(
    lifecycle: 'completed' | 'stopped',
    result: 'pass' | 'fail',
    overrides: Partial<RunbookState> = {},
  ): Promise<{ controlled: RunbookState }> {
    const frameKey = buildFrameKey('1');
    const controlled = state({
      id: controlledRunId,
      lifecycle,
      substepStates: [{ id: '1', frameKey, status: 'done' }],
      resolvedCompletions: {
        [buildCompletionKey(activeFrame(frameKey, 1), '1')]: buildResolvedCompletion({
          agentId: 'delegated-grandchild',
          result,
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: activeFrame(frameKey, 1),
          completedAt: '2026-06-17T00:03:00.000Z',
        }),
      },
      ...overrides,
    });
    await manager.save(controlled);
    // The collect target is the CONTROLLED run, so the presented bearer must be
    // the claim that actually controls it — the fence captures `(run, claim)` and
    // re-checks that pairing at commit.
    presentClaim(controlledClaim);
    // prepareActorMutation is spied so the real machine is never reconstructed; it
    // derives the terminal state the drain observes (status from lifecycle).
    jest
      .spyOn(actorService, 'prepareActorMutation')
      .mockResolvedValue(
        preparedMutation(
          state({ id: controlledRunId, step: '1', substep: undefined, lifecycle, ...overrides }),
        ),
      );
    return { controlled };
  }

  it('reports a terminal collected run upward without collecting the ancestor', async () => {
    const ancestor = state({ id: ancestorRunId, resolvedCompletions: {} });
    await manager.save(ancestor);
    const { controlled } = await seedTerminalControlled('completed', 'pass', {
      parentLinkage: delegationLinkage,
    });

    const outcome = await collectionService.collectDelegationOutcomes({
      targetState: controlled,
      steps: oneSubstepSteps,
      callerEvidence: ORCHESTRATOR_EVIDENCE,
      frame: activeFrame(buildFrameKey('1'), 1),
    });

    expect(outcome).toEqual({
      kind: 'collection_applied',
      targetRunId: controlledRunId,
      step: '1',
      applied: 1,
      unresolved: 0,
      lifecycle: 'completed',
      reportedTerminalOutcome: true,
      transitionObservations: expect.any(Array),
    });
    // Single-level: one outcome recorded upward; the ancestor is NOT collected.
    const freshAncestor = await manager.load(ancestorRunId);
    expect(Object.keys(freshAncestor?.resolvedCompletions ?? {})).toHaveLength(1);
    expect(freshAncestor?.step).toBe('1');
  });

  it('releases the target run from session targeting when collection drives it terminal', async () => {
    // BEHAVIOUR CHANGE: the release is no longer a post-lifecycle
    // `sessionService.releaseRunbook` call — it is a `when: 'terminal'` release
    // folded into the SAME owned-set commit as the terminal state (#556). So the
    // assertion moved from "the seam called the session writer" to "the committed
    // session no longer targets the run", and the seam's own session write must
    // never fire.
    const ancestor = state({ id: ancestorRunId, resolvedCompletions: {} });
    await manager.save(ancestor);
    const { controlled } = await seedTerminalControlled('completed', 'pass', {
      parentLinkage: delegationLinkage,
    });
    expect(await defaultStack()).toContain(controlledRunId);

    await collectionService.collectDelegationOutcomes({
      targetState: controlled,
      steps: oneSubstepSteps,
      callerEvidence: ORCHESTRATOR_EVIDENCE,
      frame: activeFrame(buildFrameKey('1'), 1),
    });

    expect(await defaultStack()).not.toContain(controlledRunId);
    expect(releaseRunbookSpy).not.toHaveBeenCalled();
    // `retainClaimsAsTerminal: true` — the claim tombstone survives so a later
    // `--claim-id` confirm/conflict still resolves `terminal` rather than `missing`.
    expect((await manager.loadSession()).claims).toHaveProperty(controlledClaim.claimKey);
  });

  it('commits the terminal state, its release, and its parent report as one unit', async () => {
    // REPLACES "preserves the committed terminal result when the session release
    // rejects (best-effort cleanup, RD-102)". That test pinned a partial write
    // surviving a later failure: the drain had already committed the terminal
    // lifecycle, so a rejecting `releaseRunbook` could leave a completed run on
    // the session stack. Under the transaction that state is unrepresentable —
    // there is no separate release to reject — so the assertion is INVERTED into
    // its all-or-none twin: all three effects are observable together, and the
    // best-effort session writer is never reached.
    const ancestor = state({ id: ancestorRunId, resolvedCompletions: {} });
    await manager.save(ancestor);
    const { controlled } = await seedTerminalControlled('completed', 'pass', {
      parentLinkage: delegationLinkage,
    });
    releaseRunbookSpy.mockRejectedValue(new Error('the seam must not write the session directly'));

    const outcome = await collectionService.collectDelegationOutcomes({
      targetState: controlled,
      steps: oneSubstepSteps,
      callerEvidence: ORCHESTRATOR_EVIDENCE,
      frame: activeFrame(buildFrameKey('1'), 1),
    });

    expect(outcome.kind).toBe('collection_applied');
    if (outcome.kind !== 'collection_applied') throw new Error('expected collection_applied');
    expect(outcome.lifecycle).toBe('completed');
    expect(outcome.reportedTerminalOutcome).toBe(true);
    // 1. the child's terminal state, 2. the parent's outcome row, 3. the release.
    expect((await manager.load(controlledRunId))?.lifecycle).toBe('completed');
    expect(
      Object.keys((await manager.load(ancestorRunId))?.resolvedCompletions ?? {}),
    ).toHaveLength(1);
    expect(await defaultStack()).not.toContain(controlledRunId);
    expect(releaseRunbookSpy).not.toHaveBeenCalled();
  });

  it('does NOT release the target when collection leaves it running', async () => {
    // Mirror "reports the active-run lifecycle from the drained state, not the
    // caller input": a 'continue' drain leaves the run running, so the CLI
    // execution loop — not the collection seam — owns release. `when: 'terminal'`
    // is what makes this conditional: the drain inside `beforeEffect` decides the
    // lifecycle long after the release input is built, so an unconditional release
    // would drop a live run off session targeting on every ordinary collect.
    const frameKey = buildFrameKey('1');
    const drainedState = state({ id: runId, lifecycle: 'running' });
    jest.spyOn(completionService, 'prepareResolvedCompletionDrain').mockResolvedValue({
      status: 'continue',
      state: drainedState,
      unresolved: 0,
      applied: [appliedRecord(drainedState)],
    });
    const target = state({ lifecycle: 'completed' });
    await manager.save(target);

    await collectionService.collectDelegationOutcomes({
      targetState: target,
      steps,
      callerEvidence: ORCHESTRATOR_EVIDENCE,
      frame: activeFrame(frameKey, 1),
    });

    expect(await defaultStack()).toContain(runId);
    expect(releaseRunbookSpy).not.toHaveBeenCalled();
  });

  it('renders a stopped terminal collection with lifecycle stopped (fail polarity)', async () => {
    const ancestor = state({ id: ancestorRunId, resolvedCompletions: {} });
    await manager.save(ancestor);
    const { controlled } = await seedTerminalControlled('stopped', 'fail', {
      parentLinkage: delegationLinkage,
    });

    const outcome = await collectionService.collectDelegationOutcomes({
      targetState: controlled,
      steps: oneSubstepSteps,
      callerEvidence: ORCHESTRATOR_EVIDENCE,
      frame: activeFrame(buildFrameKey('1'), 1),
    });

    expect(outcome).toEqual({
      kind: 'collection_applied',
      targetRunId: controlledRunId,
      step: '1',
      applied: 1,
      unresolved: 0,
      lifecycle: 'stopped',
      reportedTerminalOutcome: true,
      transitionObservations: expect.any(Array),
    });
    // #556: a collect that drives the target STOPPED-terminal releases it too —
    // `when: 'terminal'` covers both terminal lifecycles, not just `completed`.
    expect(await defaultStack()).not.toContain(controlledRunId);
  });

  it('does not report a terminal child upward when the verified claim lacks report grant', async () => {
    const ancestor = state({ id: ancestorRunId, resolvedCompletions: {} });
    await manager.save(ancestor);
    const { controlled } = await seedTerminalControlled('completed', 'pass', {
      parentLinkage: delegationLinkage,
    });
    sessionService.verifyClaimId = async () => ({
      status: 'verified',
      claim: {
        claimKey: presentedClaimKey,
        controlledRunId: runId,
        grants: [
          { action: 'collect-for-run', runId },
          { action: 'collect-for-run', runId: controlledRunId },
        ],
      },
    });

    const outcome = await collectionService.collectDelegationOutcomes({
      targetState: controlled,
      steps: oneSubstepSteps,
      callerEvidence: ORCHESTRATOR_EVIDENCE,
      frame: activeFrame(buildFrameKey('1'), 1),
    });

    expect(outcome).toMatchObject({
      kind: 'collection_applied',
      reportedTerminalOutcome: false,
    });
    const freshAncestor = await manager.load(ancestorRunId);
    expect(Object.keys(freshAncestor?.resolvedCompletions ?? {})).toHaveLength(0);
  });

  it('does not report delegated fail for policy-denied terminal children', async () => {
    const ancestor = state({ id: ancestorRunId, resolvedCompletions: {} });
    await manager.save(ancestor);
    const { controlled } = await seedTerminalControlled('stopped', 'fail', {
      parentLinkage: delegationLinkage,
      lastAction: {
        type: 'POLICY_DENIED',
        origin: 'direct',
        message: 'blocked by policy',
      },
    });

    const recorded = await collectionService.collectDelegationOutcomes({
      targetState: controlled,
      steps: oneSubstepSteps,
      callerEvidence: ORCHESTRATOR_EVIDENCE,
      frame: activeFrame(buildFrameKey('1'), 1),
    });

    expect(recorded).toMatchObject({
      kind: 'collection_applied',
      reportedTerminalOutcome: false,
    });
    const expectedKey = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1.1');
    await expect(
      lifecycleService.getResolvedCompletion(ancestorRunId, expectedKey),
    ).resolves.toBeNull();
  });

  it('reports reportedTerminalOutcome:false for a terminal ROOT run (no parentLinkage)', async () => {
    const { controlled } = await seedTerminalControlled('completed', 'pass');

    const outcome = await collectionService.collectDelegationOutcomes({
      targetState: controlled,
      steps: oneSubstepSteps,
      // Orchestrator evidence must name the TARGET run (the controlled run).
      callerEvidence: ORCHESTRATOR_EVIDENCE,
      frame: activeFrame(buildFrameKey('1'), 1),
    });

    expect(outcome).toEqual({
      kind: 'collection_applied',
      targetRunId: controlledRunId,
      step: '1',
      applied: 1,
      unresolved: 0,
      lifecycle: 'completed',
      reportedTerminalOutcome: false, // root run has no delegating ancestor
      transitionObservations: expect.any(Array),
    });
  });

  describe('terminal branch — unified inline + delegation upward propagation (#598)', () => {
    it('invokes the inline-advance callable for an inline-linked terminal target', async () => {
      const ancestor = state({ id: ancestorRunId, resolvedCompletions: {} });
      await manager.save(ancestor);
      const { controlled } = await seedTerminalControlled('completed', 'pass', {
        parentLinkage: inlineLinkage,
      });
      const advanceInlineParent = jest
        .fn<AdvanceInlineParent>()
        .mockResolvedValue({ status: 'active' });
      const svc = makeCollectionService({ advanceInlineParent });

      const outcome = await svc.collectDelegationOutcomes({
        targetState: controlled,
        steps: oneSubstepSteps,
        callerEvidence: ORCHESTRATOR_EVIDENCE,
        frame: activeFrame(buildFrameKey('1'), 1),
      });

      expect(outcome.kind).toBe('collection_applied');
      if (outcome.kind === 'collection_applied') {
        // active -> handled: the inline parent is still running on siblings.
        expect(outcome.terminalInlineAdvance).toEqual({ kind: 'handled' });
        // Inline advance never reports a delegation outcome.
        expect(outcome.reportedTerminalOutcome).toBe(false);
      }
      expect(advanceInlineParent).toHaveBeenCalledTimes(1);
    });

    it('surfaces a self-linked (cyclic) inline target as a trip naming the run to prune (#602/#603)', async () => {
      // The target's inline linkage points at ITSELF — corrupt persisted state.
      // The seam's guard trips before any side effect, and collect passes the trip
      // out on `terminalInlineAdvance` rather than flattening it to 'blocked':
      // core no longer holds an emitter, so the run to prune has to reach the CLI
      // as data. The CLI does the fail-closed collapse (and renders the trip) at
      // its own boundary, exactly as the three delegation-completion adapters do.
      const { controlled } = await seedTerminalControlled('completed', 'pass', {
        parentLinkage: { ...inlineLinkage, parentRunId: controlledRunId },
      });
      const advanceInlineParent = jest.fn<AdvanceInlineParent>();
      const svc = makeCollectionService({ advanceInlineParent });

      const outcome = await svc.collectDelegationOutcomes({
        targetState: controlled,
        steps: oneSubstepSteps,
        callerEvidence: ORCHESTRATOR_EVIDENCE,
        frame: activeFrame(buildFrameKey('1'), 1),
      });

      expect(outcome.kind).toBe('collection_applied');
      if (outcome.kind === 'collection_applied') {
        expect(outcome.terminalInlineAdvance).toEqual({
          kind: 'linkage-cycle',
          trip: {
            cause: 'repeat',
            repeatedRunId: controlledRunId,
            code: 'INLINE_PARENT_CYCLE',
            message: `Parent linkage cycle detected at ${controlledRunId}`,
          },
        });
        expect(outcome.reportedTerminalOutcome).toBe(false);
      }
      expect(advanceInlineParent).not.toHaveBeenCalled();
    });

    it('claim gate refuses a self-linked DELEGATION target BEFORE the #602 guard is reached', async () => {
      // Why collect's delegation arm needs no linkage-cycle disposition of its
      // own: it is unreachable. `claimCanReportDelegationResult` runs first, and
      // `grantAllows`'s 'report-delegation-result' arm requires an EXACT match on
      // grant.parentRunId === request.parentRunId (claim-id.ts) with no
      // wildcards. Corrupting a linkage into a self-edge rewrites
      // request.parentRunId, which then cannot match the grant minted at
      // delegation time — so the gate denies and the seam never runs.
      //
      // Reaching the seam's delegation arm from collect would require forging the
      // claim's grant to agree with the corrupted linkage — not corrupt state, a
      // forged bearer. This test pins that ordering so nobody "fixes" the
      // unreachable arm on the strength of reading the seam alone.
      //
      // #603 removed the diagnostic sink this used to observe (an empty `trips`
      // array proved the guard never ran). Nothing downstream can distinguish
      // "gate denied" from "guard tripped" — collect's delegation arm returns the
      // same `reportedTerminalOutcome: false` either way, which is exactly WHY it
      // needs no linkage-cycle disposition. So the ordering claim is pinned where
      // it is actually decidable: on the gate predicate itself, against this same
      // corrupt state, with the healthy linkage as the control that proves the
      // denial comes from the corrupted `parentRunId` and nothing else.
      const { controlled } = await seedTerminalControlled('completed', 'pass', {
        parentLinkage: { ...delegationLinkage, parentRunId: controlledRunId },
      });
      const verified = await sessionService.verifyClaimId(bearerClaimId);
      if (verified.status !== 'verified') throw new Error('fixture claim must verify');
      expect(claimCanReportDelegationResult(verified.claim, controlled)).toBe(false);
      expect(
        claimCanReportDelegationResult(verified.claim, {
          ...controlled,
          parentLinkage: delegationLinkage,
        }),
      ).toBe(true);

      const svc = makeCollectionService({ advanceInlineParent: jest.fn<AdvanceInlineParent>() });
      // The report is now PREPARED into the same commit as the terminal state, so
      // the write the gate must skip is `prepareChildCompletion`, not the
      // standalone `recordChildCompletion` the old sequence used.
      const prepareSpy = jest.spyOn(completionService, 'prepareChildCompletion');

      const outcome = await svc.collectDelegationOutcomes({
        targetState: controlled,
        steps: oneSubstepSteps,
        callerEvidence: ORCHESTRATOR_EVIDENCE,
        frame: activeFrame(buildFrameKey('1'), 1),
      });

      expect(outcome.kind).toBe('collection_applied');
      if (outcome.kind === 'collection_applied') {
        expect(outcome.reportedTerminalOutcome).toBe(false);
        // No inline arm either: a delegation target never yields one, so there is
        // no channel on which a trip could have been silently dropped.
        expect(outcome.terminalInlineAdvance).toBeUndefined();
      }
      // The gate short-circuits before the seam, so nothing was prepared upward.
      expect(prepareSpy).not.toHaveBeenCalled();
    });

    it('reports report-only for a delegation-linked terminal target (claim gate honoured)', async () => {
      const ancestor = state({ id: ancestorRunId, resolvedCompletions: {} });
      await manager.save(ancestor);
      const { controlled } = await seedTerminalControlled('completed', 'pass', {
        parentLinkage: delegationLinkage,
      });
      const advanceInlineParent = jest.fn<AdvanceInlineParent>();
      const svc = makeCollectionService({ advanceInlineParent });

      const outcome = await svc.collectDelegationOutcomes({
        targetState: controlled,
        steps: oneSubstepSteps,
        callerEvidence: ORCHESTRATOR_EVIDENCE,
        frame: activeFrame(buildFrameKey('1'), 1),
      });

      expect(outcome.kind).toBe('collection_applied');
      if (outcome.kind === 'collection_applied') {
        expect(outcome.reportedTerminalOutcome).toBe(true);
        expect(outcome.terminalInlineAdvance).toBeUndefined();
      }
      // The inline callable never runs for a delegation target.
      expect(advanceInlineParent).not.toHaveBeenCalled();
    });

    it('does not report when the claim cannot report the delegation result', async () => {
      const ancestor = state({ id: ancestorRunId, resolvedCompletions: {} });
      await manager.save(ancestor);
      // A delegation linkage whose tokenHash does not match the report grant the
      // claim carries → claimCanReportDelegationResult denies the report.
      const unauthorizedLinkage = {
        ...delegationLinkage,
        tokenHash: assertDelegationTokenHash(`sha256:${'b'.repeat(64)}`),
      };
      const { controlled } = await seedTerminalControlled('completed', 'pass', {
        parentLinkage: unauthorizedLinkage,
      });
      const advanceInlineParent = jest.fn<AdvanceInlineParent>();
      const svc = makeCollectionService({ advanceInlineParent });
      const prepareSpy = jest.spyOn(completionService, 'prepareChildCompletion');

      const outcome = await svc.collectDelegationOutcomes({
        targetState: controlled,
        steps: oneSubstepSteps,
        callerEvidence: ORCHESTRATOR_EVIDENCE,
        frame: activeFrame(buildFrameKey('1'), 1),
      });

      expect(outcome.kind).toBe('collection_applied');
      if (outcome.kind === 'collection_applied') {
        expect(outcome.reportedTerminalOutcome).toBe(false);
      }
      // The authorization gate must skip the preparation entirely — a mere
      // `reportedTerminalOutcome: false` could also mean a duplicate/not-applicable
      // preparation, so prove no parent row was ever derived, and none committed.
      expect(prepareSpy).not.toHaveBeenCalled();
      expect(
        Object.keys((await manager.load(ancestorRunId))?.resolvedCompletions ?? {}),
      ).toHaveLength(0);
      expect(advanceInlineParent).not.toHaveBeenCalled();
    });
  });

  it('returns collection_frame_not_active when the requested frame is not the cursor frame', async () => {
    // Cursor sits on iteration 1 (frame `1`); the caller targets iteration 2,
    // whose substeps are done+resolved (so the gate passes), but the real drain
    // observes the cursor is elsewhere and short-circuits to not_active.
    const inactiveKey = buildFrameKey('1', 2);
    const target = state({
      step: '1',
      substep: '1',
      activeFrameKey: buildFrameKey('1'),
      activeEntry: 1,
      substepStates: [
        { id: '1', frameKey: inactiveKey, status: 'done' },
        { id: '2', frameKey: inactiveKey, status: 'done' },
      ],
      resolvedCompletions: {
        [buildCompletionKey(exactFrame(inactiveKey, 2), '1')]: buildResolvedCompletion({
          agentId: 'delegated-a',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: exactFrame(inactiveKey, 2),
          completedAt: '2026-06-17T00:08:00.000Z',
        }),
        [buildCompletionKey(exactFrame(inactiveKey, 2), '2')]: buildResolvedCompletion({
          agentId: 'delegated-b',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '2',
          targetFrame: exactFrame(inactiveKey, 2),
          completedAt: '2026-06-17T00:09:00.000Z',
        }),
      },
    });
    await manager.save(target);

    const outcome = await collectionService.collectDelegationOutcomes({
      targetState: target,
      steps,
      callerEvidence: ORCHESTRATOR_EVIDENCE,
      frame: exactFrame(inactiveKey, 2),
    });

    expect(outcome).toMatchObject({
      kind: 'collection_frame_not_active',
      targetRunId: runId,
      step: '1',
      frameKey: inactiveKey,
      activeFrameKey: buildFrameKey('1'),
    });
    expect(outcome).toHaveProperty('unresolved');
  });

  it('returns collection_failed with code COLLECT_OPERATION_FAILED on a drain target_mismatch', async () => {
    // The frame-aware missing-outcome gate (which mirrors the conditions that
    // would otherwise surface a mismatch) makes a real drain `target_mismatch`
    // unreachable through collectDelegationOutcomes — the only failure drain can
    // return. So this pins collection's mapping of that drain failure by spying
    // the drain seam directly (drain itself owns producing the failure; its
    // production is pinned in completion-service.test.ts).
    const frameKey = buildFrameKey('1');
    const target = state({
      resolvedCompletions: {
        [buildCompletionKey(activeFrame(frameKey, 1), '1')]: buildResolvedCompletion({
          agentId: 'delegated-a',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: activeFrame(frameKey, 1),
          completedAt: '2026-06-17T00:06:00.000Z',
        }),
        [buildCompletionKey(activeFrame(frameKey, 1), '2')]: buildResolvedCompletion({
          agentId: 'delegated-b',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '2',
          targetFrame: activeFrame(frameKey, 1),
          completedAt: '2026-06-17T00:06:30.000Z',
        }),
      },
    });
    await manager.save(target);

    jest.spyOn(completionService, 'prepareResolvedCompletionDrain').mockResolvedValue({
      status: 'failed',
      reason: 'target_mismatch',
      message: 'Resolved completion does not match the current cursor.',
      completion: buildResolvedCompletion({
        agentId: 'delegated-a',
        result: 'pass',
        targetStep: '1',
        targetSubstep: '1',
        targetFrame: activeFrame(frameKey, 1),
        completedAt: '2026-06-17T00:06:00.000Z',
      }),
      state: target,
      unresolved: 1,
      applied: [],
    });
    const enterEntrySpy = jest.spyOn(actorService, 'enterExecutionUnit');

    await expect(
      collectionService.collectDelegationOutcomes({
        targetState: target,
        steps,
        callerEvidence: ORCHESTRATOR_EVIDENCE,
        frame: activeFrame(frameKey, 1),
      }),
    ).resolves.toEqual({
      kind: 'collection_failed',
      targetRunId: runId,
      reason: 'target_mismatch',
      code: 'COLLECT_OPERATION_FAILED',
      message: expect.any(String),
    });
    expect(enterEntrySpy).not.toHaveBeenCalled();
  });

  it('counts only delegate substeps as required, ignoring plain substeps in the same step', async () => {
    // A step that mixes a DELEGATE substep ('1') with a plain non-delegate
    // substep ('2'). Only the delegate substep is a collection requirement, so
    // with neither resolved the missing set is exactly ['1.1'] — the plain
    // substep must NOT appear. Pins the `.filter(s => s.delegate)` in
    // `delegateSubstepIds`: dropping it would wrongly demand '1.2' as well.
    const frameKey = buildFrameKey('1');
    const mixedSteps: ResolvedStep[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Delegate work',
        aggregation: { strategy: 'ALL' },
        substeps: [
          { id: '1', description: 'A', delegate: true, transitions: tx('CONTINUE', 'STOP') },
          // Plain substep: `delegate` is omitted (the AST never writes `delegate: false`).
          { id: '2', description: 'B', transitions: tx('CONTINUE', 'STOP') },
        ],
        transitions: tx('CONTINUE', 'STOP'),
      },
      {
        kind: 'base',
        name: '2',
        description: 'After collection',
        transitions: tx('CONTINUE', 'STOP'),
      },
    ];
    const target = state({ substepStates: [] });
    await manager.save(target);

    await expect(
      collectionService.collectDelegationOutcomes({
        targetState: target,
        steps: mixedSteps,
        callerEvidence: ORCHESTRATOR_EVIDENCE,
        frame: activeFrame(frameKey, 1),
      }),
    ).resolves.toEqual({
      kind: 'missing_outcomes',
      targetRunId: runId,
      step: '1',
      missingSubsteps: ['1.1'],
      supersededSubsteps: [],
    });
  });

  it('uses the persisted active frame key (not the cursor-derived one) for the default collection frame', async () => {
    // The persisted `activeFrameKey` records a FOR iteration-2 frame, while
    // `deriveActiveFrame` (no live forStack) falls back to the base frame `1`.
    // With NO frame override, the default collection frame must prefer the
    // persisted key (`activeFrameKeyOf` = `activeFrameKey ?? derived`). The
    // delegate substeps are done only under the base frame `1`, so keying the
    // gate off the persisted `1#2` frame leaves both unresolved → missing.
    // Replacing `??` with `&&` would derive the base frame, find them done,
    // and skip the missing-outcome refusal.
    const iterationKey = buildFrameKey('1', 2);
    const baseKey = buildFrameKey('1');
    expect(iterationKey).not.toBe(baseKey);
    const target = state({
      step: '1',
      substep: '1',
      activeFrameKey: iterationKey,
      activeEntry: 2,
      substepStates: [
        { id: '1', frameKey: baseKey, status: 'done' },
        { id: '2', frameKey: baseKey, status: 'done' },
      ],
    });
    await manager.save(target);

    await expect(
      collectionService.collectDelegationOutcomes({
        targetState: target,
        steps,
        callerEvidence: ORCHESTRATOR_EVIDENCE,
      }),
    ).resolves.toEqual({
      kind: 'missing_outcomes',
      targetRunId: runId,
      step: '1',
      missingSubsteps: ['1.1', '1.2'],
      supersededSubsteps: [],
    });
  });

  it('reports upward from the CAPTURED run, not a stale in-memory target', async () => {
    // The in-memory `targetState` passed by the caller is stale (`running`), and
    // the transaction never trusts it: the drain runs against the state captured
    // under the lease, so the upward report observes the terminal lifecycle that
    // drain derived → records a pass → `reportedTerminalOutcome: true`. This used
    // to be a post-write `manager.load` reload; the capture is strictly stronger,
    // because the state it reads is the exact version the commit is guarded on.
    const ancestor = state({ id: ancestorRunId, resolvedCompletions: {} });
    await manager.save(ancestor);
    const { controlled } = await seedTerminalControlled('completed', 'pass', {
      parentLinkage: delegationLinkage,
    });

    const outcome = await collectionService.collectDelegationOutcomes({
      targetState: { ...controlled, lifecycle: 'running' },
      steps: oneSubstepSteps,
      callerEvidence: ORCHESTRATOR_EVIDENCE,
      frame: activeFrame(buildFrameKey('1'), 1),
    });

    expect(outcome).toMatchObject({
      kind: 'collection_applied',
      targetRunId: controlledRunId,
      lifecycle: 'completed',
      reportedTerminalOutcome: true,
    });
  });

  it('does not report upward when the prepared state is not actually terminal', async () => {
    // Defensive guard: the drain reports a terminal status, but the state it
    // prepared is still `running` (an inconsistent drain). The report must
    // short-circuit on the non-terminal lifecycle — the guard now lives inside
    // `prepareChildCompletion`, which returns `not-applicable` for a non-terminal
    // child, so `reportedTerminalOutcome` is false AND no parent row is prepared
    // or committed. Asserting the committed ancestor, not a call count, is what
    // keeps this honest now that preparation is unconditional.
    const frameKey = buildFrameKey('1');
    const controlled = state({
      id: controlledRunId,
      lifecycle: 'running',
      parentLinkage: delegationLinkage,
      substepStates: [{ id: '1', frameKey, status: 'done' }],
      resolvedCompletions: {
        [buildCompletionKey(activeFrame(frameKey, 1), '1')]: buildResolvedCompletion({
          agentId: 'delegated-a',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: activeFrame(frameKey, 1),
          completedAt: '2026-06-17T00:04:00.000Z',
        }),
      },
    });
    await manager.save(controlled);
    await manager.save(state({ id: ancestorRunId, resolvedCompletions: {} }));
    presentClaim(controlledClaim);
    // Drain reports terminal, but the state it prepared stays `running` — the
    // inconsistency the guard exists to absorb.
    jest
      .spyOn(completionService, 'prepareResolvedCompletionDrain')
      .mockResolvedValue({ status: 'done', state: controlled, unresolved: 0, applied: [] });

    const outcome = await collectionService.collectDelegationOutcomes({
      targetState: controlled,
      steps: oneSubstepSteps,
      callerEvidence: ORCHESTRATOR_EVIDENCE,
      frame: activeFrame(frameKey, 1),
    });

    expect(outcome).toMatchObject({
      kind: 'collection_applied',
      targetRunId: controlledRunId,
      reportedTerminalOutcome: false,
    });
    expect(
      Object.keys((await manager.load(ancestorRunId))?.resolvedCompletions ?? {}),
    ).toHaveLength(0);
    // A `running` prepared state is not terminal, so the conditional release
    // must not fire either — the run stays on session targeting.
    expect(await defaultStack()).toContain(controlledRunId);
  });

  it('reports reportedTerminalOutcome:false when the ancestor already recorded the completion', async () => {
    // The run is genuinely terminal and has a delegating ancestor, so the outcome
    // is prepared upward — but the ancestor already holds that row, so
    // `prepareChildCompletion` answers 'duplicate'. Only a literal 'recorded'
    // disposition counts as a fresh upward report, so `reportedTerminalOutcome` is
    // false. The `return true` mutant of `prepared?.kind === 'recorded'` would
    // mis-claim a duplicate as a fresh report.
    const ancestor = state({ id: ancestorRunId, resolvedCompletions: {} });
    await manager.save(ancestor);
    const { controlled } = await seedTerminalControlled('completed', 'pass', {
      parentLinkage: delegationLinkage,
    });
    jest.spyOn(completionService, 'prepareChildCompletion').mockReturnValue({ kind: 'duplicate' });

    const outcome = await collectionService.collectDelegationOutcomes({
      targetState: controlled,
      steps: oneSubstepSteps,
      callerEvidence: ORCHESTRATOR_EVIDENCE,
      frame: activeFrame(buildFrameKey('1'), 1),
    });

    expect(outcome).toMatchObject({
      kind: 'collection_applied',
      targetRunId: controlledRunId,
      lifecycle: 'completed',
      reportedTerminalOutcome: false,
    });
  });

  /** Build one applied-completion record carrying a given post-apply state. */
  function appliedRecord(stateAfter: RunbookState) {
    const frameKey = buildFrameKey('1');
    return {
      key: buildCompletionKey(activeFrame(frameKey, 1), '1'),
      completion: brandCurrentCursorResolvedCompletionForTest({
        // `buildResolvedCompletion` widens `targetSubstep` to `string | undefined`;
        // re-state it here so the value narrows to the `targetSubstep: string`
        // shape the brand helper requires.
        ...buildResolvedCompletion({
          agentId: 'delegated-a',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: activeFrame(frameKey, 1),
          completedAt: '2026-06-17T00:05:00.000Z',
        }),
        targetSubstep: '1',
      }),
      stateBefore: stateAfter,
      stateAfter,
      snapshot: {},
    };
  }

  it('resolves the default collection frame from the persisted active entry (no override)', async () => {
    // No frame override → `defaultCollectionFrame` builds the frame from
    // `activeFrameKeyOf(state)` and `state.activeEntry ?? 1`. With the delegate
    // substeps done under the persisted frame key and no outcomes left to drain,
    // the result is the idempotent `already_collected`.
    //   * `activeEntry` is undefined here, so the `?? 1` fallback must supply a
    //     positive entry — the `&& 1` mutant yields `undefined`, which
    //     `activeFrame`'s positive-entry assertion rejects (throws).
    //   * Emptying `activeFrameKeyOf` (→ undefined frame key) would make the
    //     done substeps invisible to the gate, flipping the result to
    //     `missing_outcomes`.
    const baseKey = buildFrameKey('1');
    const target = state({
      step: '1',
      substep: '1',
      activeFrameKey: baseKey,
      activeEntry: undefined,
      substepStates: [
        { id: '1', frameKey: baseKey, status: 'done' },
        { id: '2', frameKey: baseKey, status: 'done' },
      ],
      resolvedCompletions: {},
    });
    await manager.save(target);

    await expect(
      collectionService.collectDelegationOutcomes({
        targetState: target,
        steps,
        callerEvidence: ORCHESTRATOR_EVIDENCE,
      }),
    ).resolves.toMatchObject({
      kind: 'already_collected',
      targetRunId: runId,
      step: '1',
    });
  });

  it('reports upward from the PREPARED terminal state, not the last applied record', async () => {
    // Terminal branch: the drain's prepared `state` is the terminal source of
    // truth, and the post-write `manager.load` reload it replaced is gone — a
    // transaction cannot read back what it has not committed yet. Drain reports
    // `done` with a prepared `completed` state carrying the delegating linkage,
    // while its last applied record is a stale, parent-less, non-terminal
    // snapshot. Reading the applied record instead would yield no upward report.
    const ancestor = state({ id: ancestorRunId, resolvedCompletions: {} });
    await manager.save(ancestor);
    const frameKey = buildFrameKey('1');
    const controlled = state({
      id: controlledRunId,
      lifecycle: 'completed',
      parentLinkage: delegationLinkage,
      substepStates: [{ id: '1', frameKey, status: 'done' }],
      resolvedCompletions: {
        [buildCompletionKey(activeFrame(frameKey, 1), '1')]: buildResolvedCompletion({
          agentId: 'delegated-a',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: activeFrame(frameKey, 1),
          completedAt: '2026-06-17T00:05:00.000Z',
        }),
      },
    });
    await manager.save(controlled);
    presentClaim(controlledClaim);
    // The last applied record is a non-terminal, parent-less snapshot — distinct
    // from the prepared `completed` state, so the two operands diverge.
    const staleApplied = state({ id: controlledRunId, lifecycle: 'running' });
    jest.spyOn(completionService, 'prepareResolvedCompletionDrain').mockResolvedValue({
      status: 'done',
      state: controlled,
      unresolved: 0,
      applied: [appliedRecord(staleApplied)],
    });

    const outcome = await collectionService.collectDelegationOutcomes({
      targetState: controlled,
      steps: oneSubstepSteps,
      callerEvidence: ORCHESTRATOR_EVIDENCE,
      frame: activeFrame(frameKey, 1),
    });

    expect(outcome).toMatchObject({
      kind: 'collection_applied',
      targetRunId: controlledRunId,
      lifecycle: 'completed',
      reportedTerminalOutcome: true,
    });
  });

  it('reports the active-run lifecycle from the drained state, not the caller input', async () => {
    // Non-terminal (`continue`) branch with outcomes applied: the reported
    // `lifecycle` must come from the drain's prepared state, not the caller's
    // (possibly stale) `targetState`. Here the prepared state is `running` while
    // the caller passes a stale `completed` input.
    const frameKey = buildFrameKey('1');
    const drainedState = state({ id: runId, lifecycle: 'running' });
    jest.spyOn(completionService, 'prepareResolvedCompletionDrain').mockResolvedValue({
      status: 'continue',
      state: drainedState,
      unresolved: 0,
      applied: [appliedRecord(drainedState)],
    });
    const target = state({ lifecycle: 'completed' });
    await manager.save(target);

    const outcome = await collectionService.collectDelegationOutcomes({
      targetState: target,
      steps,
      callerEvidence: ORCHESTRATOR_EVIDENCE,
      frame: activeFrame(frameKey, 1),
    });

    expect(outcome).toMatchObject({
      kind: 'collection_applied',
      targetRunId: runId,
      applied: 1,
      lifecycle: 'running',
      reportedTerminalOutcome: false,
    });
  });

  // ---------------------------------------------------------------------------
  // Region 1 — `findStepOrThrow` (collection-service.ts L101-105)
  //
  // `deriveCollectionTransitionObservations` looks up `entry.stateBefore.step`
  // via `findStepOrThrow`. When the applied state's step name is absent from the
  // loaded runbook, the helper MUST throw `Step "<name>" not found`. This rejects
  // the whole collect (the throw is uncaught in `applyCollection`).
  // ---------------------------------------------------------------------------

  it('throws a named error when an applied state references a step missing from the loaded runbook', async () => {
    // Drain reports a single applied record whose `stateBefore.step` is a step
    // name that does NOT exist in `steps`. The real `findStepOrThrow` must throw
    // `Step "ghost" not found`:
    //   * L102 (find predicate forced `true`): the mutant returns `steps[0]`
    //     instead of throwing, so the collect resolves normally — this test's
    //     rejection expectation fails for the mutant, killing it.
    //   * L103 (error message blanked to ``): the mutant throws an empty-message
    //     error, so asserting the message names the missing step kills it.
    const frameKey = buildFrameKey('1');
    const target = state();
    await manager.save(target);

    const ghostBefore = state({ step: 'ghost', substep: undefined });
    jest.spyOn(completionService, 'prepareResolvedCompletionDrain').mockResolvedValue({
      status: 'continue',
      state: state({ substep: '2' }),
      unresolved: 0,
      applied: [
        {
          key: buildCompletionKey(activeFrame(frameKey, 1), '1'),
          completion: buildCurrentCursorResolvedCompletionForTest({
            agentId: 'delegated-a',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '1',
            targetFrame: activeFrame(frameKey, 1),
            completedAt: '2026-06-17T00:01:00.000Z',
          }),
          stateBefore: ghostBefore,
          stateAfter: state({ substep: '2' }),
          snapshot: { context: { lastAction: { type: 'CONTINUE', origin: 'direct' } } },
        },
      ],
    });

    await expect(
      collectionService.collectDelegationOutcomes({
        targetState: target,
        steps,
        callerEvidence: ORCHESTRATOR_EVIDENCE,
        frame: activeFrame(frameKey, 1),
      }),
    ).rejects.toThrow('Step "ghost" not found');
  });

  // ---------------------------------------------------------------------------
  // Regions 2 & 3 — `isDelegateFrontierEntry` + `projectAndConsumeReEntryFrontier`
  // malformed-snapshot guards (collection-service.ts L282-314).
  //
  // Each malformed shape drives the validation guard down a distinct branch.
  // The scaffold mirrors the "later no-op collect" test: the drain prepares
  // `continue` with `applied: []` over the target whose snapshot carries the
  // (malformed) frontier.
  // ---------------------------------------------------------------------------

  /** Run a no-op collect whose target snapshot carries the given frontier. */
  async function collectWithPersistedFrontier(delegateFrontier: unknown) {
    const frameKey = buildFrameKey('1');
    const target = state({
      retryCount: 1,
      snapshot: { context: { delegateFrontier } },
    });
    await manager.save(target);
    jest.spyOn(completionService, 'prepareResolvedCompletionDrain').mockResolvedValue({
      status: 'continue',
      state: target,
      unresolved: 1,
      applied: [],
    });
    return collectionService.collectDelegationOutcomes({
      targetState: target,
      steps,
      callerEvidence: ORCHESTRATOR_EVIDENCE,
      frame: activeFrame(frameKey, 1),
    });
  }

  it('rejects a non-array delegateFrontier in the persisted snapshot', async () => {
    // L307 `!Array.isArray(rawFrontier)`: a non-array (here a string) must throw
    // `InvalidRunbookStateError`. Covers the L307 block + the L309 message; the
    // `&&` LogicalOperator mutant of L307 would require BOTH the non-array AND a
    // failing `.every` (the latter throws on a string), so this also pins the
    // operator. `rawFrontier !== undefined`, so the no-frontier early-return is
    // not taken.
    await expect(collectWithPersistedFrontier('oops')).rejects.toBeInstanceOf(
      InvalidRunbookStateError,
    );
    // The refusal must name the offending run: the recovery path is explicit
    // operator action (finish/stop/prune/restart) on a specific run, so a
    // message that does not identify one is not actionable.
    await expect(collectWithPersistedFrontier('oops')).rejects.toThrow(
      `Run ${runId} carries a malformed delegateFrontier`,
    );
  });

  it('rejects an object (non-array) delegateFrontier in the persisted snapshot', async () => {
    // L307 `!Array.isArray`: an object that is not an array must also throw —
    // distinguishes "array-like" from genuine arrays so `.every` is never reached.
    await expect(collectWithPersistedFrontier({})).rejects.toBeInstanceOf(InvalidRunbookStateError);
  });

  it('rejects a frontier whose entry is not an object', async () => {
    // L283 `typeof value !== 'object' || value === null`: a primitive entry
    // (string) makes `isDelegateFrontierEntry` return false, so `.every` fails →
    // throw. Kills the L283 ConditionalExpression/LogicalOperator/BooleanLiteral
    // mutants (a `true`/short-circuit guard would wrongly accept the primitive).
    await expect(collectWithPersistedFrontier(['not-an-object'])).rejects.toBeInstanceOf(
      InvalidRunbookStateError,
    );
  });

  it('rejects a frontier whose entry is null', async () => {
    // L283 `value === null`: a null entry must be rejected (typeof null ===
    // 'object', so only the explicit null check excludes it). Kills the
    // `value === null` → false / `&&` mutants of L283.
    await expect(collectWithPersistedFrontier([null])).rejects.toBeInstanceOf(
      InvalidRunbookStateError,
    );
  });

  it('rejects a frontier entry missing a string id', async () => {
    // L286 `typeof entry.id === 'string'`: id absent → false → `.every` fails →
    // throw. Forcing this check `true` (or OR-ing it) would accept the entry.
    const { id: _id, ...missingId } = frontierEntry().persisted;
    await expect(collectWithPersistedFrontier([missingId])).rejects.toBeInstanceOf(
      InvalidRunbookStateError,
    );
  });

  it('rejects a frontier entry missing a string runbook', async () => {
    // L287 `typeof entry.runbook === 'string'`: runbook absent → false → throw.
    const { runbook: _runbook, ...missingRunbook } = frontierEntry().persisted;
    await expect(collectWithPersistedFrontier([missingRunbook])).rejects.toBeInstanceOf(
      InvalidRunbookStateError,
    );
  });

  it('rejects a frontier entry missing its credential descriptor', async () => {
    const { credential: _credential, ...missingCredential } = frontierEntry().persisted;
    await expect(collectWithPersistedFrontier([missingCredential])).rejects.toBeInstanceOf(
      InvalidRunbookStateError,
    );
  });

  it('rejects a frontier entry missing its token hash', async () => {
    const { tokenHash: _tokenHash, ...missingTokenHash } = frontierEntry().persisted;
    await expect(collectWithPersistedFrontier([missingTokenHash])).rejects.toBeInstanceOf(
      InvalidRunbookStateError,
    );
  });

  it('refuses projection when the verified collector is not the frontier issuer', async () => {
    const persisted = frontierEntry().persisted;
    const rotatedIssuer = {
      ...persisted,
      credential: {
        ...persisted.credential,
        issuerClaimKey: assertClaimLookupKey(`rdclk_${'9'.repeat(32)}`),
      },
    };
    const enterEntrySpy = jest.spyOn(actorService, 'enterExecutionUnit');
    const consumeSpy = jest.spyOn(actorService, 'prepareActorMutation');

    await expect(collectWithPersistedFrontier([rotatedIssuer])).resolves.toMatchObject({
      kind: 'collection_failed',
      reason: 'frontier_projection_refused',
      // Was `COLLECT_OPERATION_FAILED`. A rotated/foreign issuing claim is a
      // credential disclosure-boundary refusal, which RD-821 names — and which
      // the execution loop already reported under RD-821 for the same input.
      code: ErrorCodes.DELEGATION_INVARIANT_VIOLATED.code,
    });
    expect(enterEntrySpy).not.toHaveBeenCalled();
    expect(consumeSpy).not.toHaveBeenCalled();
  });

  it('refuses projection when a derived token does not match the persisted hash', async () => {
    const persisted = frontierEntry().persisted;
    const wrongHash = {
      ...persisted,
      tokenHash: assertDelegationTokenHash(`sha256:${'0'.repeat(64)}`),
    };
    const enterEntrySpy = jest.spyOn(actorService, 'enterExecutionUnit');
    const consumeSpy = jest.spyOn(actorService, 'prepareActorMutation');

    await expect(collectWithPersistedFrontier([wrongHash])).resolves.toMatchObject({
      kind: 'collection_failed',
      reason: 'frontier_projection_refused',
      // Was `COLLECT_OPERATION_FAILED` — see the rotated-issuer test above.
      code: ErrorCodes.DELEGATION_INVARIANT_VIOLATED.code,
    });
    expect(enterEntrySpy).not.toHaveBeenCalled();
    expect(consumeSpy).not.toHaveBeenCalled();
  });

  it('keeps the persisted re-entry frontier free of plaintext bearers', () => {
    const entry = frontierEntry();

    expect(entry.public.token).toMatch(/^rdtk_/);
    expect(JSON.stringify(entry.persisted)).not.toMatch(/rdtk_/);
    expect(entry.persisted).not.toHaveProperty('token');
  });

  it('treats an empty-array delegateFrontier as no re-entry (no observations surfaced)', async () => {
    // L313 `frontier.length === 0`: an empty (but valid) array short-circuits
    // to `status: 'none'`, so the collect maps to the idempotent `already_collected`
    // no-op with NO `reEntryObservations`. The `false`/`&&` mutants of L313 would
    // fall through to the observation path. `observeExecutionUnitEntry` is spied to
    // prove it is never reached.
    const enterEntrySpy = jest.spyOn(actorService, 'enterExecutionUnit');
    const outcome = await collectWithPersistedFrontier([]);

    expect(outcome).toMatchObject({
      kind: 'already_collected',
      targetRunId: runId,
      step: '1',
    });
    expect(outcome).not.toHaveProperty('reEntryObservations');
    expect(enterEntrySpy).not.toHaveBeenCalled();
  });

  it('treats a present frontier with an undefined cursor substep as no re-entry', async () => {
    // L313 `advanced.substep === undefined`: a valid non-empty frontier but a
    // cursor that has advanced off the substeps (substep undefined) short-circuits
    // to `status: 'none'`. Kills the L313 substep-clause mutants and confirms the
    // observation path is skipped.
    const frameKey = buildFrameKey('1');
    const retry = frontierEntry();
    const target = state({
      substep: undefined,
      retryCount: 1,
      snapshot: {
        context: {
          delegateFrontier: [retry.persisted],
        },
      },
    });
    await manager.save(target);
    jest.spyOn(completionService, 'prepareResolvedCompletionDrain').mockResolvedValue({
      status: 'continue',
      state: target,
      unresolved: 1,
      applied: [],
    });
    const enterEntrySpy = jest.spyOn(actorService, 'enterExecutionUnit');

    const outcome = await collectionService.collectDelegationOutcomes({
      targetState: target,
      steps,
      callerEvidence: ORCHESTRATOR_EVIDENCE,
      frame: activeFrame(frameKey, 1),
    });

    expect(outcome).toMatchObject({
      kind: 'already_collected',
      targetRunId: runId,
      step: '1',
    });
    expect(outcome).not.toHaveProperty('reEntryObservations');
    expect(enterEntrySpy).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Region 4 — entry input wiring + result spread.
  //
  // Assert the exact input passed to `enterExecutionUnit`, plus the conditional
  // `reEntryObservations` spread on the result. Since #820 the collect side
  // supplies only the committed state, the steps, and the projected bearers —
  // everything the entry carries is rendered by the seam from those, which is
  // why the per-field entry assertions that used to live here are now the
  // characterisation block further down (which reads the emitted payload).
  // ---------------------------------------------------------------------------

  /** Capture-and-assert helper: run a no-op collect that projects a valid frontier. */
  async function projectFrontierAndCapture(overrides: Partial<RunbookState>) {
    const frameKey = buildFrameKey('1');
    const retry = frontierEntry();
    const persistedFrontier = [retry.persisted];
    const frontier = [retry.public];
    const target = state({
      retryCount: 1,
      snapshot: { context: { delegateFrontier: persistedFrontier } },
      ...overrides,
    });
    await manager.save(target);
    jest.spyOn(completionService, 'prepareResolvedCompletionDrain').mockResolvedValue({
      status: 'continue',
      state: target,
      unresolved: 1,
      applied: [],
    });
    const reEntryEffects: readonly ExecutionObservationEffect[] = [
      {
        kind: 'execution_observation',
        event: {
          type: 'STEP_ENTERED',
          payload: {
            position: { current: '1', total: 2, substep: '1' },
            stepName: '1',
            hasCommand: false,
            isSubstep: true,
            prompted: false,
            artifacts: {},
            delegateFrontier: frontier,
          },
        },
      },
    ];
    const enterEntrySpy = jest
      .spyOn(actorService, 'enterExecutionUnit')
      .mockResolvedValue({ kind: 'awaiting', effects: reEntryEffects });
    jest
      .spyOn(actorService, 'prepareActorMutation')
      .mockResolvedValue(preparedMutation(target, { context: {} }));
    const outcome = await collectionService.collectDelegationOutcomes({
      targetState: target,
      steps,
      callerEvidence: ORCHESTRATOR_EVIDENCE,
      frame: activeFrame(frameKey, 1),
    });
    return { outcome, enterEntrySpy, frontier, reEntryEffects };
  }

  it('enters the COMMITTED target with the runbook steps and the projected bearers', async () => {
    // The three things the collect side still supplies, and the only three it
    // can get wrong: the state whose commit just landed, a non-empty steps array
    // (an emptied copy would make the entry unresolvable against the runbook),
    // and the bearers the projection reconstructed.
    const { enterEntrySpy, frontier } = await projectFrontierAndCapture({});

    expect(enterEntrySpy).toHaveBeenCalledTimes(1);
    const input = enterEntrySpy.mock.calls[0][0];
    expect(input.state.id).toBe(runId);
    expect(input.steps).toEqual(steps);
    expect(input.steps.length).toBeGreaterThan(0);
    expect(input.delegateFrontier).toEqual(frontier);
  });

  it('enters the state the transaction committed, not the pre-drain state it started from', async () => {
    // Post-commit by construction: the entry describes the run as it exists
    // after the consume, so a pre-commit state would announce a frontier the
    // commit has already retired.
    const { enterEntrySpy } = await projectFrontierAndCapture({});

    const input = enterEntrySpy.mock.calls[0][0];
    const committed = await manager.load(runId);
    expect(input.state).toEqual(committed);
  });

  it('includes reEntryObservations on the result only when the frontier projects', async () => {
    // L469 `reentry.status === 'projected' ? {...} : {}`: when a valid frontier
    // projects + consumes, the `collection_applied` result MUST carry
    // `reEntryObservations`. The mutant forcing the condition `true` is killed by
    // the empty-array / undefined-substep tests above (status 'none' → no
    // observations); this test pins the positive arm.
    const { outcome, reEntryEffects } = await projectFrontierAndCapture({});
    expect(outcome).toMatchObject({
      kind: 'collection_applied',
      targetRunId: runId,
      applied: 0,
      reEntryObservations: reEntryEffects,
    });
  });

  // ---------------------------------------------------------------------------
  // #816 characterisation — the COLLECT half of the STEP_ENTERED divergence,
  // FLIPPED by #820.
  //
  // These pinned a builder that no longer exists. `prepareCollectReEntryFrontier`
  // used to hand the frontier seam a hand-built `StepEntryMetadata` carrying ids,
  // position, name and flags and none of the four rendered fields, while the CLI
  // execution loop's builder filled all of them. Collect now enters through the
  // same core seam `rundown run` does, so there is one builder and nothing left
  // to disagree.
  //
  // The assertions below are the same three facts inverted: what was
  // `toBeUndefined()` is the rendered value, and what was `false` is the composed
  // one. They read the EMITTED payload rather than a captured argument, because
  // the argument they used to capture is core-private now. The end-to-end
  // contrast is in the CLI's
  // `integration/step-entered-run-collect-agreement.test.ts`.
  // ---------------------------------------------------------------------------
  describe('STEP_ENTERED entry metadata (#816 flip)', () => {
    /**
     * Run a no-op collect that projects a valid frontier, and return the
     * `STEP_ENTERED` payload it discloses.
     *
     * The real `enterExecutionUnit` runs here — that is the point. A local twin
     * of `projectFrontierAndCapture` above, which closes over the shared `steps`
     * fixture; this one takes the step graph, because the `prompted` case needs a
     * step KIND the shared fixture does not carry.
     *
     * @param collectSteps - Step graph the collect resolves its target step in.
     * @param overrides - Target-state overrides applied on top of the fixture.
     * @returns The single disclosed `STEP_ENTERED` payload.
     */
    async function collectStepEnteredPayload(
      collectSteps: ResolvedStep[],
      overrides: Partial<RunbookState> = {},
    ): Promise<Record<string, unknown>> {
      const frameKey = buildFrameKey('1');
      const retry = frontierEntry();
      const target = state({
        retryCount: 1,
        // A real `snapshot.value`, unlike the sibling fixtures above: entering
        // the unit runs the persisted-snapshot freshness guard, which the
        // spied-out seam never reached.
        snapshot: { value: 'step::1::1', context: { delegateFrontier: [retry.persisted] } },
        ...overrides,
      });
      await manager.save(target);
      jest.spyOn(completionService, 'prepareResolvedCompletionDrain').mockResolvedValue({
        status: 'continue',
        state: target,
        unresolved: 1,
        applied: [],
      });
      jest
        .spyOn(actorService, 'prepareActorMutation')
        .mockResolvedValue(preparedMutation(target, { context: {} }));

      const outcome = await collectionService.collectDelegationOutcomes({
        targetState: target,
        steps: collectSteps,
        callerEvidence: ORCHESTRATOR_EVIDENCE,
        frame: activeFrame(frameKey, 1),
      });

      if (outcome.kind !== 'collection_applied') {
        throw new Error(`expected collection_applied, got ${outcome.kind}`);
      }
      const effects = outcome.reEntryObservations ?? [];
      expect(effects).toHaveLength(1);
      const event = effects[0].event;
      if (event.type !== 'STEP_ENTERED')
        throw new Error(`expected STEP_ENTERED, got ${event.type}`);
      return event.payload as unknown as Record<string, unknown>;
    }

    it('carries the rendered description of the substep it names', async () => {
      // The shared fixture gives substep '1' a description, which the old
      // builder had and dropped.
      expect(steps[0]).toMatchObject({
        substeps: expect.arrayContaining([expect.objectContaining({ id: '1', description: 'A' })]),
      });

      const payload = await collectStepEnteredPayload(steps);

      // THE FLIP. `toBeUndefined()` on all four rendered fields before #820.
      // A substep's description does not depend on which command entered it.
      expect(payload.description).toBe('A');
      // The fixture substep declares no command, so `commandCode` is still
      // absent — but `hasCommand` now says so because the PARSED unit says so,
      // not because no rendering happened.
      expect(payload.commandCode).toBeUndefined();
      expect(payload.hasCommand).toBe(false);
      expect(payload).toMatchObject({ stepName: '1', isSubstep: true });
    });

    it('composes prompted from the persisted flag and the step kind', async () => {
      // The same two delegate substeps, hung off a step whose FOR bounds did
      // not resolve. `resolvedStepHasSubsteps` accepts `prompted-for`, so the
      // collect reaches its frontier exactly as it does for the shared fixture.
      const promptedForSteps: ResolvedStep[] = [
        {
          kind: 'prompted-for',
          name: '1',
          description: 'Delegate work',
          prompt: 'FOR item IN {{ items }}',
          substeps: [
            { id: '1', description: 'A', delegate: true, transitions: tx('CONTINUE', 'STOP') },
            { id: '2', description: 'B', delegate: true, transitions: tx('CONTINUE', 'STOP') },
          ],
          transitions: tx('CONTINUE', 'STOP'),
        },
        {
          kind: 'base',
          name: '2',
          description: 'After collection',
          transitions: tx('CONTINUE', 'STOP'),
        },
      ];

      // `false`, not absent: the run's own flag is off, which is what makes the
      // composition below about the step kind rather than about the run.
      const payload = await collectStepEnteredPayload(promptedForSteps, { prompted: false });

      // THE FLIP. `false` before #820, on the persisted flag alone. The field
      // documents whether execution is prompted rather than automatic, and a
      // prompted-FOR step IS prompted — the entry seam classifies it `awaiting`
      // on this same term.
      expect(payload.prompted).toBe(true);
      // The substep carries no prompt of its own, so the step-level FOR text is
      // what an orchestrator is shown — a field the old builder never carried.
      expect(payload.prompt).toBe('FOR item IN {{ items }}');
    });

    it('neither enters nor consumes the frontier for a cursor naming no live substep', async () => {
      // The third divergence, and the only one that never reached the payload:
      // `substepId` came off the raw cursor while `isSubstep` came off the
      // resolved unit. Both answer one question, and both come off the resolved
      // unit now — so a cursor naming no live substep is not a substep entry,
      // and the frontier it would have disclosed stays persisted.
      //
      // Named for what it asserts rather than for that origin: the payload is
      // never read here, so a title promising payload coverage would send a
      // reader looking for it in the wrong file. The `substepId` assertion
      // itself lives on the seam that renders the payload, in
      // `execution-unit-entry.test.ts`.
      const frameKey = buildFrameKey('1');
      const retry = frontierEntry();
      const target = state({
        substep: '9',
        retryCount: 1,
        snapshot: { context: { delegateFrontier: [retry.persisted] } },
      });
      await manager.save(target);
      jest.spyOn(completionService, 'prepareResolvedCompletionDrain').mockResolvedValue({
        status: 'continue',
        state: target,
        unresolved: 1,
        applied: [],
      });
      const enterEntrySpy = jest.spyOn(actorService, 'enterExecutionUnit');

      const outcome = await collectionService.collectDelegationOutcomes({
        targetState: target,
        steps,
        callerEvidence: ORCHESTRATOR_EVIDENCE,
        frame: activeFrame(frameKey, 1),
      });

      expect(outcome.kind).toBe('already_collected');
      expect(enterEntrySpy).not.toHaveBeenCalled();
      expect(await persistedFrontier(runId)).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // All-or-none: the transaction this change exists to create.
  //
  // Collect used to authorize, then commit one `sendAndSync` transaction per
  // completion, then release the session, then propagate upward — four or more
  // separately committed writes, none of which re-checked the collector's
  // captured `claim_generation`. Every test here fails against that design, and
  // each says how.
  // ---------------------------------------------------------------------------

  describe('all-or-none transactional collection', () => {
    /** Target carrying two reported outcomes, ready for a two-apply drain. */
    async function seedTwoReportedOutcomes(): Promise<RunbookState> {
      const frameKey = buildFrameKey('1');
      const target = state({
        resolvedCompletions: {
          [buildCompletionKey(activeFrame(frameKey, 1), '1')]: buildResolvedCompletion({
            agentId: 'delegated-a',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '1',
            targetFrame: activeFrame(frameKey, 1),
            completedAt: '2026-06-17T00:01:00.000Z',
          }),
          [buildCompletionKey(activeFrame(frameKey, 1), '2')]: buildResolvedCompletion({
            agentId: 'delegated-b',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '2',
            targetFrame: activeFrame(frameKey, 1),
            completedAt: '2026-06-17T00:02:00.000Z',
          }),
        },
      });
      await manager.save(target);
      return target;
    }

    /**
     * Fake the machine for a two-completion drain.
     *
     * @param target - The captured target whose completions are being applied.
     * @returns The `prepareActorMutation` spy, so a test can count the derivations.
     */
    function fakeTwoApplyMachine(target: RunbookState) {
      return jest
        .spyOn(actorService, 'prepareActorMutation')
        .mockResolvedValueOnce(
          preparedMutation(
            state({ substep: '2', resolvedCompletions: target.resolvedCompletions }),
          ),
        )
        .mockResolvedValueOnce(
          preparedMutation(state({ step: '2', substep: undefined, lifecycle: 'running' })),
        );
    }

    /** Assert that a refused collection left the target exactly as captured. */
    async function expectTargetUntouched(captured: RunbookState): Promise<void> {
      const persisted = await manager.load(runId);
      // No delegation outcome consumed: both reported rows are still collectable.
      expect(Object.keys(persisted?.resolvedCompletions ?? {})).toEqual(
        Object.keys(captured.resolvedCompletions ?? {}),
      );
      // No substep advanced: the cursor never left the first delegate substep.
      expect(persisted?.step).toBe('1');
      expect(persisted?.substep).toBe('1');
      // No session release: the run is still targetable.
      expect(await defaultStack()).toContain(runId);
      expect(releaseRunbookSpy).not.toHaveBeenCalled();
    }

    it('writes nothing when the collector bearer is REPLACED after authorization', async () => {
      // THE defect. `writeStateAtVersion` guards on `state_version` only, and its
      // own docstring warns that a `committed` result is not evidence the caller's
      // authority was still valid — the generation check lives in
      // `classifyCommitRow`, which the old per-write path never reached. So a
      // bearer rotated in the window after the authorization gate still landed
      // every apply, the release, and the upward report.
      //
      // The rotation is committed from inside `recordClaimSeen`, which is the
      // FIRST thing collect does after the grant is authorized — the same hook
      // `lifecycle-command-service.test.ts` uses to pin the identical window on
      // abort.
      const target = await seedTwoReportedOutcomes();
      fakeTwoApplyMachine(target);
      recordClaimSeenSpy.mockImplementationOnce(async () => {
        await rotateControllingClaim(runId);
        return {
          kind: 'recorded',
          claimKey: presentedClaimKey,
          lastSeenAt: '2026-06-28T00:00:00.000Z',
        };
      });

      const outcome = await collectionService.collectDelegationOutcomes({
        targetState: target,
        steps,
        callerEvidence: ORCHESTRATOR_EVIDENCE,
        frame: activeFrame(buildFrameKey('1'), 1),
      });

      expect(outcome).toMatchObject({ kind: 'claim_superseded', runId });
      await expectTargetUntouched(target);
    });

    it('writes nothing when the collector bearer is superseded after the whole workflow is PREPARED', async () => {
      // The narrower half of the same window, and the one only a commit-time
      // re-check can catch: the collection has already captured its state and
      // derived every apply, the frontier decision and the terminal decision. A
      // per-write design has committed applies by this point; here the derivation
      // is still entirely in memory, so the aggregate refuses and no byte lands.
      const target = await seedTwoReportedOutcomes();
      const prepareSpy = fakeTwoApplyMachine(target);
      const svc = makeCollectionService({
        actorMutationRunner: runnerWithPreCommitEffect(() => rotateControllingClaim(runId)),
      });

      const outcome = await svc.collectDelegationOutcomes({
        targetState: target,
        steps,
        callerEvidence: ORCHESTRATOR_EVIDENCE,
        frame: activeFrame(buildFrameKey('1'), 1),
      });

      expect(outcome).toMatchObject({ kind: 'claim_superseded', runId });
      // Both applies really were derived before the refusal — otherwise the test
      // would pass for the trivial reason that nothing was ever prepared.
      expect(prepareSpy).toHaveBeenCalledTimes(2);
      await expectTargetUntouched(target);
    });

    it('persists NO prepared completion when the commit fails after every apply is derived', async () => {
      // Same shape, different refusal: a concurrent writer moves the target's
      // `state_version` between capture and commit. Under per-write commits the
      // first apply would already be durable and the second would fail, leaving
      // the run mid-drain with one outcome consumed and one not — the stranded
      // prefix the aggregate exists to make unrepresentable.
      const target = await seedTwoReportedOutcomes();
      const prepareSpy = fakeTwoApplyMachine(target);
      const svc = makeCollectionService({
        actorMutationRunner: runnerWithPreCommitEffect(async () => {
          await manager.save({ ...target, retryCount: 9 });
        }),
      });

      const outcome = await svc.collectDelegationOutcomes({
        targetState: target,
        steps,
        callerEvidence: ORCHESTRATOR_EVIDENCE,
        frame: activeFrame(buildFrameKey('1'), 1),
      });

      expect(outcome).toMatchObject({ kind: 'concurrent_modification', runId });
      expect(prepareSpy).toHaveBeenCalledTimes(2);
      // The concurrent writer's own change is the only thing that landed.
      expect((await manager.load(runId))?.retryCount).toBe(9);
      await expectTargetUntouched(target);
    });

    /**
     * Seed a still-RUNNING delegated child whose drain derives a terminal state.
     *
     * Distinct from `seedTerminalControlled`, which persists the child already
     * terminal: here the terminal lifecycle is something the collection produces,
     * so "the child went terminal" is observable in the store rather than assumed.
     *
     * @returns The captured child state and the terminal state its drain derives.
     */
    async function seedRunningDelegatedChild(): Promise<{
      readonly child: RunbookState;
      readonly terminal: RunbookState;
    }> {
      const frameKey = buildFrameKey('1');
      await manager.save(state({ id: ancestorRunId, resolvedCompletions: {} }));
      const child = state({
        id: controlledRunId,
        lifecycle: 'running',
        parentLinkage: delegationLinkage,
        substepStates: [{ id: '1', frameKey, status: 'done' }],
        resolvedCompletions: {
          [buildCompletionKey(activeFrame(frameKey, 1), '1')]: buildResolvedCompletion({
            agentId: 'delegated-grandchild',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '1',
            targetFrame: activeFrame(frameKey, 1),
            completedAt: '2026-06-17T00:03:00.000Z',
          }),
        },
      });
      await manager.save(child);
      presentClaim(controlledClaim);
      const terminal = state({
        id: controlledRunId,
        step: '1',
        substep: undefined,
        lifecycle: 'completed',
        parentLinkage: delegationLinkage,
      });
      jest
        .spyOn(actorService, 'prepareActorMutation')
        .mockResolvedValue(preparedMutation(terminal));
      return { child, terminal };
    }

    it('commits the child terminal state, the parent report and the release together', async () => {
      // The positive control for the refusal below: all three effects of a
      // terminal collect are observable at once, from one commit.
      const { child } = await seedRunningDelegatedChild();

      const outcome = await collectionService.collectDelegationOutcomes({
        targetState: child,
        steps: oneSubstepSteps,
        callerEvidence: ORCHESTRATOR_EVIDENCE,
        frame: activeFrame(buildFrameKey('1'), 1),
      });

      expect(outcome).toMatchObject({
        kind: 'collection_applied',
        lifecycle: 'completed',
        reportedTerminalOutcome: true,
      });
      expect((await manager.load(controlledRunId))?.lifecycle).toBe('completed');
      expect(
        Object.keys((await manager.load(ancestorRunId))?.resolvedCompletions ?? {}),
      ).toHaveLength(1);
      expect(await defaultStack()).not.toContain(controlledRunId);
    });

    it('writes neither the child terminal state, the parent report nor the release when the parent commit refuses', async () => {
      // The delegating GRANDPARENT is the member that refuses: a concurrent
      // writer moves its `state_version` between capture and commit. The child is
      // not the refusing run, and under the old sequence its terminal lifecycle
      // and its session release had already committed before the upward report
      // was even attempted — the exact window where a child could be terminal,
      // released, and yet unknown to the parent that delegated it.
      //
      // Note the refusal is NOT a drop: the grandparent is only
      // `optionalWhenClaimSuperseded`, so anything other than a retired claim
      // refuses the whole set rather than silently proceeding without it.
      const { child } = await seedRunningDelegatedChild();
      const ancestor = await manager.load(ancestorRunId);
      if (!ancestor) throw new Error('fixture ancestor must exist');
      const svc = makeCollectionService({
        actorMutationRunner: runnerWithPreCommitEffect(async () => {
          await manager.save({ ...ancestor, retryCount: 4 });
        }),
      });

      const outcome = await svc.collectDelegationOutcomes({
        targetState: child,
        steps: oneSubstepSteps,
        callerEvidence: ORCHESTRATOR_EVIDENCE,
        frame: activeFrame(buildFrameKey('1'), 1),
      });

      expect(outcome).toMatchObject({
        kind: 'concurrent_modification',
        runId: ancestorRunId,
      });
      // 1. the child never went terminal...
      expect((await manager.load(controlledRunId))?.lifecycle).toBe('running');
      // 2. ...its outcome row never reached the delegating grandparent...
      expect(
        Object.keys((await manager.load(ancestorRunId))?.resolvedCompletions ?? {}),
      ).toHaveLength(0);
      // 3. ...and the run was not released from session targeting.
      expect(await defaultStack()).toContain(controlledRunId);
      expect(releaseRunbookSpy).not.toHaveBeenCalled();
      // The child's reported outcome is still there to collect on a retry.
      expect(
        Object.keys((await manager.load(controlledRunId))?.resolvedCompletions ?? {}),
      ).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // F6 — one condition, one code, across both entry points.
  //
  // `rundown collect` and `rundown run` reach the SAME re-entry frontier seam.
  // Before the consolidation each reported its outcomes under its own code: a
  // projection refusal was `COLLECT_OPERATION_FAILED` here and `RD-821` in the
  // execution loop, and a consume failure was `COLLECT_OPERATION_FAILED` here
  // and carried no code at all there. These pin the converged codes on the
  // collect side; the
  // execution-loop side is pinned in
  // `packages/cli/__tests__/services/execution-loop.test.ts`.
  //
  // Only the PROJECTION half of the pair survives on the collect side. Collect
  // now drives the FENCED twin of the seam, whose union has no `consume_failed`
  // arm at all (`prepareReEntryFrontierConsume`), so RD-829 is reachable from the
  // unfenced execution loop alone — see
  // "discloses no bearers and consumes no frontier when the enclosing commit
  // refuses" above for what covers the condition here now.
  // ---------------------------------------------------------------------------

  it('reports a refused frontier projection under RD-821, the credential-disclosure code', async () => {
    // A refused projection is a credential DISCLOSURE-boundary refusal, the
    // condition RD-821 names and describes ("presenting a claim that cannot
    // reconstruct an in-flight delegation credential"). The execution loop
    // already refuses the identical condition under RD-821; the command driving
    // it must not change the code.
    const persisted = frontierEntry().persisted;
    const rotatedIssuer = {
      ...persisted,
      credential: {
        ...persisted.credential,
        issuerClaimKey: assertClaimLookupKey(`rdclk_${'9'.repeat(32)}`),
      },
    };

    await expect(collectWithPersistedFrontier([rotatedIssuer])).resolves.toMatchObject({
      kind: 'collection_failed',
      reason: 'frontier_projection_refused',
      code: ErrorCodes.DELEGATION_INVARIANT_VIOLATED.code,
    });
  });

  it('cannot produce a standalone frontier-consume failure from a fenced collect', async () => {
    // REPLACES "reports a failed frontier consume under RD-829, not the
    // collect-operation bucket". The old test forced `sendAndSync` to return null
    // so the seam reported `consume_failed`; collect no longer calls it. The
    // fenced twin DERIVES the consume, and a derivation cannot half-commit, so
    // there is no state in which "projection succeeded but the consume did not
    // land" is a collect-local fact — it is either committed with everything else
    // or refused with everything else.
    //
    // Pinned structurally, on the union rather than on a scenario: the prepared
    // outcome's arms are exactly `none | projected | projection_refused`, so a
    // successful projection can only be `projected`, and `frontier_consume_failed`
    // has no producer on this path.
    const target = state({
      retryCount: 1,
      snapshot: { context: { delegateFrontier: [frontierEntry().persisted] } },
    });
    await manager.save(target);
    const consumed = state({ ...target, snapshot: { context: {} } });
    jest
      .spyOn(actorService, 'prepareActorMutation')
      .mockResolvedValue(preparedMutation(consumed, { context: {} }));

    const prepared = await prepareReEntryFrontierConsume({
      actorService,
      steps,
      state: target,
      deriveToken: createDelegationTokenDeriver({
        kind: 'bearer',
        claimId: bearerClaimId,
        claimKey: presentedClaimKey,
      }),
    });

    expect(prepared.status).toBe('projected');
    // The seam hands back a state to commit and bearers to disclose afterwards —
    // never a "the write did not land" arm, because it performs no write.
    expect(prepared).not.toHaveProperty('status', 'consume_failed');
    if (prepared.status !== 'projected') throw new Error('expected projected');
    expect(prepared.nextState).toEqual(consumed);
    // RD-829 keeps its producer on the UNFENCED path the execution loop drives
    // (`projectAndConsumeReEntryFrontier` → `consume_failed` →
    // `ErrorCodes.DELEGATION_FRONTIER_CONSUME_FAILED`), pinned in
    // `packages/cli/__tests__/services/execution-loop.test.ts`.
    expect(ErrorCodes.DELEGATION_FRONTIER_CONSUME_FAILED.code).toBe('RD-829');
  });

  // ---------------------------------------------------------------------------
  // The INLINE narrowing at the collect boundary.
  //
  // `advanceInlineParentAfterCommit` narrows the shared seam's union down to the
  // inline subset. It used to do that with
  // `outcome.kind === 'reported' || outcome.kind === 'duplicate' ? { kind:
  // 'not-applicable' } : outcome`, which silently remaps two DELEGATION
  // dispositions the seam documents as load-bearing onto a third meaning
  // ("there was nothing to propagate to"). CLAUDE.md forbids exactly that
  // collapse, and a `?:` cannot be made exhaustive: a new member added to
  // `TerminalUpwardPropagationResult` would fall into the pass-through arm and
  // silently widen the declared `InlineUpwardPropagationResult` return.
  // ---------------------------------------------------------------------------

  describe('inline upward-propagation narrowing', () => {
    const inlineArms: readonly [string, InlineUpwardPropagationResult][] = [
      ['handled', { kind: 'handled' }],
      ['stopped', { kind: 'stopped' }],
      ['blocked', { kind: 'blocked' }],
      ['not-applicable', { kind: 'not-applicable' }],
      [
        'linkage-cycle',
        {
          kind: 'linkage-cycle',
          trip: {
            cause: 'repeat',
            repeatedRunId: ancestorRunId,
            code: 'INLINE_PARENT_CYCLE',
            message: `Parent linkage cycle detected at ${ancestorRunId}`,
          },
        },
      ],
      [
        'advance-refused',
        {
          kind: 'advance-refused',
          refusal: {
            reason: 'target_mismatch',
            code: COMPLETION_TARGET_MISMATCH_CODE,
            message: 'Completion targets substep 2, cursor is on 1',
            runId: ancestorRunId,
          },
        },
      ],
    ];

    it.each(inlineArms)('passes the %s arm through by identity', (_name, arm) => {
      // By IDENTITY, not by equality: the `linkage-cycle` arm carries the trip
      // naming the run to prune, and rebuilding the arm here is precisely the
      // loss #603 removed from the seam. Nothing on this boundary may rebuild it.
      expect(narrowInlineUpwardPropagation(arm)).toBe(arm);
    });

    it.each<['reported' | 'duplicate']>([['reported'], ['duplicate']])(
      'refuses the delegation-only %s disposition instead of remapping it to not-applicable',
      (kind) => {
        // The two arms an inline-linked child can never produce (proved by the
        // scenario test below). Were one to arrive, it would mean the seam's
        // contract had changed — an invariant violation, not an expected
        // refusal, and never a `not-applicable`.
        const outcome: TerminalUpwardPropagationResult = { kind };
        expect(() => narrowInlineUpwardPropagation(outcome)).toThrow(
          `Inline upward propagation yielded the delegation-only disposition "${kind}"`,
        );
      },
    );

    it('collapses a delegation-linked grandparent report INSIDE the seam, not at this boundary', async () => {
      // The reachability question the narrowing turns on. `collect` only calls
      // the seam for an INLINE-linked target, but the seam recurses upward, so a
      // delegation boundary one level up DOES reach `recordChildCompletion` and
      // DOES produce `{ kind: 'reported' }` — inside the recursion.
      //
      // The seam's own severity collapse then discards it: only `linkage-cycle`
      // and `blocked` bubble out unchanged, `stopped` survives as `stopped`, and
      // everything else becomes `handled`. So the value that reaches the collect
      // boundary is `handled`, never `reported`. This test is the evidence for
      // that claim — it walks child → inline parent → delegating grandparent and
      // asserts BOTH halves: the grandparent's row was really written (so the
      // delegation arm really ran) and the boundary still saw `handled`.
      const greatGrand = state({ id: greatGrandRunId, resolvedCompletions: {} });
      await manager.save(greatGrand);
      // The inline parent, itself a delegated child of `greatGrandRunId`.
      await manager.save(
        state({
          id: ancestorRunId,
          lifecycle: 'completed',
          resolvedCompletions: {},
          parentLinkage: {
            kind: 'delegation',
            parentRunId: greatGrandRunId,
            parentStepId: '1',
            parentStep: '1',
            parentFrameKey: buildFrameKey('1'),
            parentEntry: 1,
            tokenHash,
          },
        }),
      );
      const { controlled } = await seedTerminalControlled('completed', 'pass', {
        parentLinkage: inlineLinkage,
      });
      // `done` drives the seam's release-and-recurse arm, which is the only way
      // to reach the delegation level above the inline parent.
      const advanceInlineParent = jest
        .fn<AdvanceInlineParent>()
        .mockResolvedValue({ status: 'done' });
      const svc = makeCollectionService({ advanceInlineParent });

      const outcome = await svc.collectDelegationOutcomes({
        targetState: controlled,
        steps: oneSubstepSteps,
        callerEvidence: ORCHESTRATOR_EVIDENCE,
        frame: activeFrame(buildFrameKey('1'), 1),
      });

      expect(outcome.kind).toBe('collection_applied');
      if (outcome.kind !== 'collection_applied') throw new Error('expected collection_applied');
      // The recursion really crossed the delegation boundary...
      expect(
        Object.keys((await manager.load(greatGrandRunId))?.resolvedCompletions ?? {}),
      ).toHaveLength(1);
      // ...and the seam still handed the collect boundary an INLINE arm.
      expect(outcome.terminalInlineAdvance).toEqual({ kind: 'handled' });
      expect(advanceInlineParent).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Aggregate recovery actors — one per OWNED member, not just the target.
  //
  // `runAll` records `recovery_pending` for EVERY attempt in the set when the
  // aggregate effect fails ambiguously, then asks `makeRecoveryActor` to
  // rehydrate each one. A member with no cached steps makes that factory throw,
  // and the runner downgrades the throw to `logger.warn('aggregate member
  // recovery failed; attempt left pending')` and continues — so the delegating
  // parent could never be recovered through the collect path, silently.
  // ---------------------------------------------------------------------------

  describe('aggregate recovery actors', () => {
    /** Inert stand-in so a factory call asserts wiring, not machine rehydration. */
    function stubRecoveryActor(): RecoveryActor {
      return {
        send: () => undefined,
        getPersistedSnapshot: () => ({}),
        isInRecoveryState: () => true,
        stop: () => undefined,
      };
    }

    /**
     * Capture the recovery factory the collection hands to the fence.
     *
     * @param overrides - Extra collection-service dependency overrides.
     * @returns The service and a reader for the captured factory.
     */
    function serviceCapturingRecoveryFactory(
      overrides: Partial<RunbookCollectionServiceDependencies> = {},
    ) {
      let captured: EffectfulActorMutationSetRunnerInput<unknown>['makeRecoveryActor'] | undefined;
      const svc = makeCollectionService({
        actorMutationRunner: {
          run: (input) => actorMutationRunner.run(input),
          async runAll<TResult>(input: EffectfulActorMutationSetRunnerInput<TResult>) {
            captured = input.makeRecoveryActor;
            return await actorMutationRunner.runAll<TResult>(input);
          },
        },
        ...overrides,
      });
      return {
        svc,
        /**
         * Read the factory the fence received.
         *
         * @returns The captured recovery-actor factory.
         */
        makeRecoveryActor: () => {
          if (!captured) throw new Error('the fence must receive a recovery factory');
          return captured;
        },
      };
    }

    /**
     * Seed a terminal delegated child whose collect names its parent in the set.
     *
     * @returns The child's captured state.
     */
    async function seedDelegatedChildWithParent(): Promise<RunbookState> {
      await manager.save(state({ id: ancestorRunId, resolvedCompletions: {} }));
      const { controlled } = await seedTerminalControlled('completed', 'pass', {
        parentLinkage: delegationLinkage,
      });
      return controlled;
    }

    it('rehydrates the delegating parent from that run own resolved steps', async () => {
      const controlled = await seedDelegatedChildWithParent();
      // The parent is a DIFFERENT runbook: answering with the collect target's
      // steps would rehydrate the wrong machine graph, so the loader is keyed on
      // the run it is asked about.
      const loadSteps = jest.fn(async (target: RunbookState) => {
        expect(target.id).toBe(ancestorRunId);
        return steps;
      });
      const createRecoveryActor = jest
        .spyOn(actorService, 'createRecoveryActor')
        .mockImplementation(stubRecoveryActor);
      const { svc, makeRecoveryActor } = serviceCapturingRecoveryFactory({ loadSteps });

      const outcome = await svc.collectDelegationOutcomes({
        targetState: controlled,
        steps: oneSubstepSteps,
        callerEvidence: ORCHESTRATOR_EVIDENCE,
        frame: activeFrame(buildFrameKey('1'), 1),
      });
      expect(outcome.kind).toBe('collection_applied');

      const parent = await manager.load(ancestorRunId);
      if (!parent) throw new Error('fixture ancestor must exist');
      // Before this fix the factory threw here, and `runAll` downgraded the
      // throw to a warn — so the parent could never be recovered by a collect.
      makeRecoveryActor()(ancestorRunId, parent);
      expect(loadSteps).toHaveBeenCalledTimes(1);
      // Read the call directly rather than `toHaveBeenCalledWith`: the matcher
      // instantiates `RunbookState` deeply enough to trip TS2589, and reference
      // identity is the stronger assertion here anyway — it pins that the
      // parent's OWN steps were handed over, not a structural look-alike.
      const [recoveredState, recoveredSteps] = createRecoveryActor.mock.calls[0] ?? [];
      expect(recoveredState).toBe(parent);
      expect(recoveredSteps).toBe(steps);
    });

    it('rehydrates the collect target from the steps the caller supplied', async () => {
      // The control: the target's own recovery already worked, and must keep
      // working — from `input.steps`, never from the parent loader's answer.
      const controlled = await seedDelegatedChildWithParent();
      const loadSteps = jest.fn(async () => steps);
      const createRecoveryActor = jest
        .spyOn(actorService, 'createRecoveryActor')
        .mockImplementation(stubRecoveryActor);
      const { svc, makeRecoveryActor } = serviceCapturingRecoveryFactory({ loadSteps });

      await svc.collectDelegationOutcomes({
        targetState: controlled,
        steps: oneSubstepSteps,
        callerEvidence: ORCHESTRATOR_EVIDENCE,
        frame: activeFrame(buildFrameKey('1'), 1),
      });

      const target = await manager.load(controlledRunId);
      if (!target) throw new Error('fixture target must exist');
      makeRecoveryActor()(controlledRunId, target);
      // Read the call directly: `toHaveBeenCalledWith` trips TS2589 on
      // `RunbookState`, and identity is the stronger assertion — the target must
      // rehydrate from the caller's own `steps`, not the loader's answer.
      const [recoveredState, recoveredSteps] = createRecoveryActor.mock.calls[0] ?? [];
      expect(recoveredState).toBe(target);
      expect(recoveredSteps).toBe(oneSubstepSteps);
    });

    it('never consults the parent loader when the target has no delegating parent', async () => {
      // A single-member aggregate owns exactly the run whose steps the caller
      // already supplied, so the loader must not be reached at all.
      const frameKey = buildFrameKey('1');
      const target = state({
        resolvedCompletions: {
          [buildCompletionKey(activeFrame(frameKey, 1), '1')]: buildResolvedCompletion({
            agentId: 'delegated-a',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '1',
            targetFrame: activeFrame(frameKey, 1),
            completedAt: '2026-06-17T00:01:00.000Z',
          }),
          [buildCompletionKey(activeFrame(frameKey, 1), '2')]: buildResolvedCompletion({
            agentId: 'delegated-b',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '2',
            targetFrame: activeFrame(frameKey, 1),
            completedAt: '2026-06-17T00:02:00.000Z',
          }),
        },
      });
      await manager.save(target);
      jest
        .spyOn(actorService, 'prepareActorMutation')
        .mockResolvedValueOnce(
          preparedMutation(
            state({ substep: '2', resolvedCompletions: target.resolvedCompletions }),
          ),
        )
        .mockResolvedValueOnce(
          preparedMutation(state({ step: '2', substep: undefined, lifecycle: 'running' })),
        );
      const loadSteps = jest.fn(async () => steps);
      const createRecoveryActor = jest
        .spyOn(actorService, 'createRecoveryActor')
        .mockImplementation(stubRecoveryActor);
      const { svc, makeRecoveryActor } = serviceCapturingRecoveryFactory({ loadSteps });

      const outcome = await svc.collectDelegationOutcomes({
        targetState: target,
        steps,
        callerEvidence: ORCHESTRATOR_EVIDENCE,
        frame: activeFrame(frameKey, 1),
      });

      expect(outcome.kind).toBe('collection_applied');
      expect(loadSteps).not.toHaveBeenCalled();
      const committed = await manager.load(runId);
      if (!committed) throw new Error('fixture target must exist');
      makeRecoveryActor()(runId, committed);
      // Read the call directly: `toHaveBeenCalledWith` trips TS2589 on
      // `RunbookState`, and identity pins that the sole member rehydrated from
      // the caller's own `steps` without the loader contributing anything.
      const [recoveredState, recoveredSteps] = createRecoveryActor.mock.calls[0] ?? [];
      expect(recoveredState).toBe(committed);
      expect(recoveredSteps).toBe(steps);
    });
  });

  // ---------------------------------------------------------------------------
  // Post-commit re-entry disclosure — the deliberate fail-loud boundary.
  // ---------------------------------------------------------------------------

  describe('post-commit re-entry disclosure', () => {
    /** Seed a collect whose one projected frontier is consumed by the commit. */
    async function seedFrontierReadyToProject() {
      const retry = frontierEntry();
      const target = state({
        retryCount: 1,
        snapshot: { context: { delegateFrontier: [retry.persisted] } },
      });
      await manager.save(target);
      const drainSpy = jest
        .spyOn(completionService, 'prepareResolvedCompletionDrain')
        .mockResolvedValue({ status: 'continue', state: target, unresolved: 1, applied: [] });
      jest
        .spyOn(actorService, 'prepareActorMutation')
        .mockResolvedValue(preparedMutation(state({ ...target, snapshot: { context: {} } })));
      return { target, drainSpy };
    }

    it('reports a post-commit render failure as RD-833 rather than a phantom success', async () => {
      // The alternative — swallowing and returning `reEntryObservations: []` —
      // would tell the orchestrator "collected, nothing to re-enter" while the
      // frontier's bearers had already been consumed and thrown away. That is
      // silent stranding; a rejection is at least an operator-visible fact.
      const { target } = await seedFrontierReadyToProject();
      const enterEntrySpy = jest
        .spyOn(actorService, 'enterExecutionUnit')
        .mockRejectedValue(new Error('entry rendering exploded'));

      const logged = jest.spyOn(logger, 'error').mockResolvedValue(undefined);

      const rejection = await collectionService
        .collectDelegationOutcomes({
          targetState: target,
          steps,
          callerEvidence: ORCHESTRATOR_EVIDENCE,
          frame: activeFrame(buildFrameKey('1'), 1),
        })
        .then(
          () => {
            throw new Error('expected the committed collect to reject');
          },
          (error: unknown) => error,
        );

      // The log line is not decoration. The rejection carries the render cause
      // but cannot say the collection COMMITTED — which is the fact that decides
      // whether an operator retries or re-delegates — so this is the only place
      // that fact is recorded, and it must name the run it is about.
      expect(logged).toHaveBeenCalledWith(
        'collection committed but its re-entry disclosure could not be rendered',
        { runId, error: 'entry rendering exploded' },
      );

      // Typed, not bare. #820 made rendering part of the collect path, so this
      // is a NEW way for a collect to fail — it used to emit a thinner event
      // that needed no rendering at all. A bare Error reaches the CLI wrapper's
      // fallback arm and prints RD-999 "Unknown error", an envelope that cannot
      // carry the recovery this condition has (fix the helper, then re-delegate:
      // a retry cannot recover the bearers).
      expect(rejection).toBeInstanceOf(RundownError);
      expect((rejection as RundownError).code).toBe('RD-833');
      // The cause is preserved rather than swallowed by the envelope, and the
      // run is named in context so an operator need not parse the message.
      expect(getErrorMessage(rejection)).toMatch(/entry rendering exploded/);
      expect((rejection as RundownError).context).toMatchObject({ runId });
      expect(enterEntrySpy).toHaveBeenCalledTimes(1);
      // The transaction COMMITTED before the disclosure was attempted: the
      // frontier is gone, which is exactly why the failure must not be silent.
      expect(await persistedFrontier(runId)).toEqual([]);
    });

    it('keeps a corrupt-state render refusal as InvalidRunbookStateError, not RD-833', async () => {
      // The two recoveries differ, so the two classes must. RD-309 prints
      // finish/stop/prune, which is right for a run that cannot describe itself;
      // RD-833 prints "fix the helper and re-delegate", which is not.
      const { target } = await seedFrontierReadyToProject();
      jest.spyOn(actorService, 'enterExecutionUnit').mockRejectedValue(
        new InvalidRunbookStateError(`Runbook state ${runId} is missing WorkPath.`, {
          runId,
          reason: 'missing_render_context',
        }),
      );

      await expect(
        collectionService.collectDelegationOutcomes({
          targetState: target,
          steps,
          callerEvidence: ORCHESTRATOR_EVIDENCE,
          frame: activeFrame(buildFrameKey('1'), 1),
        }),
      ).rejects.toBeInstanceOf(InvalidRunbookStateError);
    });

    it('keeps the REAL persisted-snapshot guards on the RD-309 path, through the unmocked seam', async () => {
      // The class check above is only as good as what the seam actually raises.
      // `enterExecutionUnit` runs `assertFreshSnapshotValue` and
      // `compileMachineFromState` BEFORE it renders anything, and both used to
      // throw a bare `Error` — which this catch would have relabelled RD-833,
      // telling an operator to fix a helper when the run's snapshot is corrupt
      // and the recovery is prune/restart. Driven through the real seam, with no
      // `enterExecutionUnit` spy, so the classification is pinned end to end.
      // The prepared consume this fixture commits carries `{ context: {} }` and
      // therefore no `snapshot.value`, which is exactly the shape the freshness
      // guard refuses — so the entry never reaches rendering at all.
      const { target } = await seedFrontierReadyToProject();

      const rejection = await collectionService
        .collectDelegationOutcomes({
          targetState: target,
          steps,
          callerEvidence: ORCHESTRATOR_EVIDENCE,
          frame: activeFrame(buildFrameKey('1'), 1),
        })
        .then(
          () => {
            throw new Error('expected the committed collect to reject');
          },
          (error: unknown) => error,
        );

      expect(rejection).toBeInstanceOf(InvalidRunbookStateError);
      // NOT the RD-833 envelope: the classes are disjoint, so a guard that
      // regressed to a bare `Error` would be caught here rather than quietly
      // relabelled with the wrong recovery.
      expect(rejection).not.toBeInstanceOf(RundownError);
      expect(getErrorMessage(rejection)).toMatch(/Unsupported snapshot\.value shape/);
    });

    it('answers a retry of that committed collection as an idempotent no-op', async () => {
      // What bounds the fail-loud choice: the caller who retries on the
      // rejection cannot double-apply. The collection already landed, so the
      // retry drains nothing and re-projects nothing.
      const { target, drainSpy } = await seedFrontierReadyToProject();
      const enterEntrySpy = jest
        .spyOn(actorService, 'enterExecutionUnit')
        .mockRejectedValue(new Error('entry rendering exploded'));
      await expect(
        collectionService.collectDelegationOutcomes({
          targetState: target,
          steps,
          callerEvidence: ORCHESTRATOR_EVIDENCE,
          frame: activeFrame(buildFrameKey('1'), 1),
        }),
      ).rejects.toThrow(/entry rendering exploded/);

      const committed = await manager.load(runId);
      if (!committed) throw new Error('the committed target must exist');
      drainSpy.mockResolvedValue({
        status: 'continue',
        state: committed,
        unresolved: 1,
        applied: [],
      });
      enterEntrySpy.mockResolvedValue({ kind: 'awaiting', effects: [] });

      await expect(
        collectionService.collectDelegationOutcomes({
          targetState: committed,
          steps,
          callerEvidence: ORCHESTRATOR_EVIDENCE,
          frame: activeFrame(buildFrameKey('1'), 1),
        }),
      ).resolves.toMatchObject({ kind: 'already_collected', targetRunId: runId });
      // No second disclosure attempt: there is no frontier left to project.
      expect(enterEntrySpy).toHaveBeenCalledTimes(1);
    });
  });
});
