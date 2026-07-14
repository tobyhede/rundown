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
  InvalidRunbookStateError,
  assertClaimId,
  assertClaimLookupKey,
  assertDelegationTokenHash,
  assertRunId,
  type CallerEvidence,
  type RunbookState,
  type RunId,
  type ReleaseRunbookResult,
} from '../../src/runbook/index.js';
import type { CollectionSessionService } from '../../src/runbook/collection-service.js';
import type { ExecutionObservationEffect } from '../../src/events/execution-observation.js';
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
import { brandStoredOutputsForTest } from '../../src/testing/effective-vars.js';

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
  // Held separately from the fake so assertions reference the spy directly —
  // `sessionService.releaseRunbook` is a declared method, and passing that
  // reference to `expect()` trips `@typescript-eslint/unbound-method`.
  let releaseRunbookSpy: jest.Mock<
    (
      runbookId: RunId,
      options?: { readonly retainClaimsAsTerminal?: boolean },
    ) => Promise<ReleaseRunbookResult>
  >;

  const runId = assertRunId('rd_11111111111111111111111111111111');
  const controlledRunId = assertRunId('rd_22222222222222222222222222222222');
  const ancestorRunId = assertRunId('rd_33333333333333333333333333333333');
  const claimId = assertClaimId(
    'rdclm_11111111111111111111111111111111_abcdefghijklmnopqrstuvwxyzABCDE1234567890-_',
  );
  const claimKey = assertClaimLookupKey('rdclk_11111111111111111111111111111111');
  const tokenHash = assertDelegationTokenHash(
    'sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  );

  // Post-R1, collection targets author DELEGATE and therefore classify
  // `delegating`, so bare direct-CLI evidence no longer mints orchestrator
  // trust — the orchestrator supplies bearer claim evidence. The behavioural
  // suites below exercise the collection operation as that verified controller;
  // the refusal twin pinning direct_cli on these fixtures lives in the
  // policy-gate describe.
  const ORCHESTRATOR_EVIDENCE: CallerEvidence = { kind: 'claim_bearer', claimId };
  const DIRECT_CLI_EVIDENCE: CallerEvidence = { kind: 'direct_cli' };

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
      id: runId,
      runbook: { source: 'project', path: 'collection-test.md' },
      runbookPath: 'collection-test.md',
      step: '1',
      substep: '1',
      stepName: 'Delegate work',
      retryCount: 0,
      variables: brandStoredOutputsForTest({}),
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
      schemaVersion: 1,
      frontmatterOutputs: [],
      ...overrides,
    };
  }

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'collection-service-'));
    manager = new RunbookStateManager(tmp);
    actorService = new RunbookActorService(manager);
    lifecycleService = new ExecutionLifecycleService(manager);
    completionService = new RunbookCompletionService(manager, lifecycleService, actorService);
    releaseRunbookSpy = jest.fn(async (runbookId: RunId) => ({
      status: 'released' as const,
      runbookId,
      removedFromDefaultStack: true,
      nextDefaultRunbookId: null,
    }));
    sessionService = {
      async getActive() {
        return null;
      },
      async resolveRunningStackMember() {
        return { kind: 'not_on_stack' };
      },
      async getActiveForClaimId() {
        return { status: 'missing', claimId };
      },
      async verifyClaimId(presentedClaimId) {
        expect(presentedClaimId).toBe(claimId);
        return {
          status: 'verified',
          claim: {
            claimKey,
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
    };
    collectionService = new RunbookCollectionService({
      sessionService,
      manager,
      actorService,
      lifecycleService,
      completionService,
    });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it.each<[string, CallerEvidence]>([
    ['plugin', { kind: 'plugin', agentId: 'subagent-1' }],
    ['mcp', { kind: 'mcp', toolName: 'collect' }],
    ['unknown', { kind: 'unknown' }],
  ])('refuses collection with actor_context_required for %s caller evidence (no minted trust)', async (_kind, callerEvidence) => {
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
  });

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
  });

  it('applies reported delegation outcomes through the state machine', async () => {
    // The real machine cannot be reconstructed from a hand-built fixture at a
    // DELEGATE cursor (entering the substep auto-spawns a delegation issue actor
    // that needs a persisted xstate snapshot — see compiler.ts spawnChild input).
    // Genuine spawn→issue→drain→aggregate e2e is pinned at the CLI layer
    // (collect.test.ts). Here we spy the lowest actor seam (sendAndSync — the
    // established core idiom, completion-service.test.ts) so the REAL
    // drainResolvedCompletions orchestration and the REAL collection mapping run;
    // only the XState dispatch is faked. The drain itself is pinned independently
    // in completion-service.test.ts, so this asserts the outcome mapping, not
    // persisted-completion deletion.
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
      .spyOn(actorService, 'sendAndSync')
      .mockResolvedValueOnce({
        state: state({ substep: '2', resolvedCompletions: target.resolvedCompletions }),
        snapshot: {},
        effects: [],
      })
      .mockResolvedValueOnce({
        state: state({ step: '2', substep: undefined, lifecycle: 'running' }),
        snapshot: {},
        effects: [],
      });

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
    const retryState = state({
      step: '1',
      substep: '1',
      retryCount: 1,
      resolvedCompletions: target.resolvedCompletions,
      snapshot: {
        context: {
          delegateFrontier: [
            { id: '1.1', runbook: 'child-a.md', token: 'rdtk_retry_a' },
            { id: '1.2', runbook: 'child-b.md', token: 'rdtk_retry_b' },
          ],
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
            delegateFrontier: [
              { id: '1.1', runbook: 'child-a.md', token: 'rdtk_retry_a' },
              { id: '1.2', runbook: 'child-b.md', token: 'rdtk_retry_b' },
            ],
          },
        },
      },
    ];

    jest.spyOn(completionService, 'drainResolvedCompletions').mockResolvedValue({
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

    const sendAndSyncSpy = jest.spyOn(actorService, 'sendAndSync').mockResolvedValueOnce({
      state: state({ ...retryState, snapshot: { context: {} } }),
      snapshot: { context: {} },
      effects: [],
    });
    const observeEntrySpy = jest
      .spyOn(actorService, 'observeExecutionUnitEntry')
      .mockResolvedValue(frontierEffects);

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
    expect(observeEntrySpy).toHaveBeenCalledTimes(1);
    expect(sendAndSyncSpy).toHaveBeenLastCalledWith(runId, steps, {
      type: 'DELEGATE_FRONTIER_CONSUMED',
    });
  });

  it('returns collection_failed without frontier observations when retry frontier consume fails', async () => {
    const frameKey = buildFrameKey('1');
    const target = state({
      resolvedCompletions: {
        [buildCompletionKey(activeFrame(frameKey, 1), '1')]: buildResolvedCompletion({
          agentId: 'delegated-a',
          result: 'fail',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: activeFrame(frameKey, 1),
          completedAt: '2026-06-17T00:01:00.000Z',
        }),
      },
    });
    await manager.save(target);

    jest.spyOn(completionService, 'drainResolvedCompletions').mockResolvedValue({
      status: 'continue',
      state: state({ retryCount: 1 }),
      unresolved: 1,
      applied: [
        {
          key: buildCompletionKey(activeFrame(frameKey, 1), '1'),
          completion: buildCurrentCursorResolvedCompletionForTest({
            agentId: 'delegated-a',
            result: 'fail',
            targetStep: '1',
            targetSubstep: '1',
            targetFrame: activeFrame(frameKey, 1),
            completedAt: '2026-06-17T00:01:00.000Z',
          }),
          stateBefore: target,
          stateAfter: state({ retryCount: 1 }),
          snapshot: { context: { lastAction: { type: 'RETRY', origin: 'aggregation' } } },
        },
      ],
    });
    await manager.save(
      state({
        retryCount: 1,
        snapshot: {
          context: {
            delegateFrontier: [{ id: '1.1', runbook: 'child-a.md', token: 'rdtk_retry_a' }],
          },
        },
      }),
    );
    jest.spyOn(actorService, 'observeExecutionUnitEntry').mockResolvedValue([
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
            delegateFrontier: [{ id: '1.1', runbook: 'child-a.md', token: 'rdtk_retry_a' }],
          },
        },
      },
    ]);
    jest.spyOn(actorService, 'sendAndSync').mockResolvedValue(null);

    const outcome = await collectionService.collectDelegationOutcomes({
      targetState: target,
      steps,
      callerEvidence: ORCHESTRATOR_EVIDENCE,
      frame: activeFrame(frameKey, 1),
    });

    expect(outcome).toEqual({
      kind: 'collection_failed',
      targetRunId: runId,
      reason: 'frontier_consume_failed',
      code: 'COLLECT_OPERATION_FAILED',
      message: 'Failed to consume delegation frontier after collect re-entry; retry collect',
    });
  });

  it('re-projects and consumes a pending retry frontier on a later no-op collect', async () => {
    // Retryable-frontier regression: a PRIOR collect applied outcomes but failed to
    // consume the retry frontier (transient sendAndSync race), so the frontier
    // stays persisted. A later collect drains nothing new (applied:0) but MUST
    // still re-project + consume the pending frontier and surface its
    // observations — not strand it behind a terminal `already_collected` no-op.
    const frameKey = buildFrameKey('1');
    const target = state({
      retryCount: 1,
      snapshot: {
        context: {
          delegateFrontier: [{ id: '1.1', runbook: 'child-a.md', token: 'rdtk_retry_a' }],
        },
      },
    });
    await manager.save(target);

    // Drain finds no unapplied outcomes for the scope (the earlier collect
    // already applied them): status 'continue' with applied: [].
    jest.spyOn(completionService, 'drainResolvedCompletions').mockResolvedValue({
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
            delegateFrontier: [{ id: '1.1', runbook: 'child-a.md', token: 'rdtk_retry_a' }],
          },
        },
      },
    ];
    const observeEntrySpy = jest
      .spyOn(actorService, 'observeExecutionUnitEntry')
      .mockResolvedValue(reEntryEffects);
    // Frontier consume succeeds this time, so the projection is surfaced.
    const sendAndSyncSpy = jest.spyOn(actorService, 'sendAndSync').mockResolvedValue({
      state: target,
      snapshot: { context: {} },
      effects: [],
    });

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
    expect(observeEntrySpy).toHaveBeenCalledTimes(1);
    expect(sendAndSyncSpy).toHaveBeenLastCalledWith(runId, steps, {
      type: 'DELEGATE_FRONTIER_CONSUMED',
    });
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
    // sendAndSync is spied so the real machine is never reconstructed; the live
    // row is the authoritative outcome signal, so readiness must not refuse.
    jest.spyOn(actorService, 'sendAndSync').mockResolvedValue({
      state: state({ id: runId, step: '1', substep: undefined, lifecycle: 'running' }),
      snapshot: {},
      effects: [],
    });
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
    // sendAndSync is spied so the real machine is never reconstructed; it returns
    // the terminal state the drain observes (status derived from lifecycle).
    jest.spyOn(actorService, 'sendAndSync').mockResolvedValue({
      state: state({ id: controlledRunId, step: '1', substep: undefined, lifecycle, ...overrides }),
      snapshot: {},
      effects: [],
    });
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
    const ancestor = state({ id: ancestorRunId, resolvedCompletions: {} });
    await manager.save(ancestor);
    const { controlled } = await seedTerminalControlled('completed', 'pass', {
      parentLinkage: delegationLinkage,
    });

    await collectionService.collectDelegationOutcomes({
      targetState: controlled,
      steps: oneSubstepSteps,
      callerEvidence: ORCHESTRATOR_EVIDENCE,
      frame: activeFrame(buildFrameKey('1'), 1),
    });

    expect(releaseRunbookSpy).toHaveBeenCalledWith(controlledRunId, {
      retainClaimsAsTerminal: true,
    });
  });

  it('does NOT release the target when collection leaves it running', async () => {
    // Mirror "reports the active-run lifecycle from the drained state, not the
    // caller input" (:1504-1535): a 'continue' drain leaves the run running, so
    // the CLI execution loop — not the collection seam — owns release.
    const frameKey = buildFrameKey('1');
    const drainedState = state({ id: runId, lifecycle: 'running' });
    jest.spyOn(completionService, 'drainResolvedCompletions').mockResolvedValue({
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
    // #556: a collect that drives the target STOPPED-terminal releases it too.
    expect(releaseRunbookSpy).toHaveBeenCalledWith(controlledRunId, {
      retainClaimsAsTerminal: true,
    });
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
        claimKey,
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

  it('does not report terminal collected inline children through delegation reporting', async () => {
    const ancestor = state({ id: ancestorRunId, resolvedCompletions: {} });
    await manager.save(ancestor);
    const { controlled } = await seedTerminalControlled('completed', 'pass', {
      parentLinkage: inlineLinkage,
    });

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
      reportedTerminalOutcome: false,
      transitionObservations: expect.any(Array),
    });
    const freshAncestor = await manager.load(ancestorRunId);
    // Assert the ancestor actually loaded before inspecting it: the `?? {}`
    // fallback below would otherwise let a null load silently pass as "0 rows".
    expect(freshAncestor).toBeDefined();
    expect(Object.keys(freshAncestor?.resolvedCompletions ?? {})).toHaveLength(0);
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

    jest.spyOn(completionService, 'drainResolvedCompletions').mockResolvedValue({
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
      unresolved: 1,
      applied: [],
    });

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
    });
  });

  it('reports upward using the reloaded terminal lifecycle, not a stale in-memory target', async () => {
    // The in-memory `targetState` passed by the caller is stale (`running`),
    // but the drain advanced and persisted the run to `completed`. The terminal
    // branch reloads the committed state via `manager.load` so the upward report
    // observes `completed` → records a pass → `reportedTerminalOutcome: true`.
    // The `&&` mutant of the reload `??`-chain would fall back to the stale
    // `running` target, whose non-terminal lifecycle yields no outcome → false.
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

  it('does not report upward when the reloaded state is not actually terminal', async () => {
    // Defensive guard: the drain reports a terminal status, but the reloaded
    // state is still `running` (e.g. a racing writer). `reportTerminalOutcome`
    // must short-circuit on the non-terminal lifecycle (`lifecycleToDelegationOutcome`
    // returns undefined → `if (!result) return false`) and never call
    // `recordChildCompletion`. The `if (false)` mutant would proceed to record;
    // the `return true` mutant would claim a report was made.
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
    // Drain reports terminal, but the persisted (reloaded) state above stays
    // `running` — the inconsistency the guard exists to absorb.
    jest
      .spyOn(completionService, 'drainResolvedCompletions')
      .mockResolvedValue({ status: 'done', unresolved: 0, applied: [] });
    const recordSpy = jest.spyOn(completionService, 'recordChildCompletion');

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
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('reports reportedTerminalOutcome:false when the ancestor already recorded the completion', async () => {
    // The reloaded run is genuinely terminal and has a delegating ancestor, so
    // the outcome is recorded upward — but the ancestor already holds that row,
    // so `recordChildCompletion` returns 'duplicate'. Only a literal 'recorded'
    // status counts as a fresh upward report, so `reportedTerminalOutcome` is
    // false. The `return true` mutant of `recorded === 'recorded'` would
    // mis-claim a duplicate as a fresh report.
    const ancestor = state({ id: ancestorRunId, resolvedCompletions: {} });
    await manager.save(ancestor);
    const { controlled } = await seedTerminalControlled('completed', 'pass', {
      parentLinkage: delegationLinkage,
    });
    jest.spyOn(completionService, 'recordChildCompletion').mockResolvedValue('duplicate');

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

  it('reports upward from the freshly reloaded run, not the drained applied state', async () => {
    // Terminal branch: the reloaded run is the terminal source of truth. Drain
    // reports `done` but its last applied state is a stale, non-terminal snapshot.
    // The reload (`manager.load`) returns the committed `completed` run with a
    // delegating ancestor, so the outcome is recorded upward. Collapsing the
    // FIRST `??` of the reload chain to `&&` would use the drained applied state
    // (no parent linkage, non-terminal) instead → no upward report.
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
    // Drained applied state is a non-terminal, parent-less snapshot — distinct
    // from the reloaded `completed` run, so the two reload operands diverge.
    const staleApplied = state({ id: controlledRunId, lifecycle: 'running' });
    jest
      .spyOn(completionService, 'drainResolvedCompletions')
      .mockResolvedValue({ status: 'done', unresolved: 0, applied: [appliedRecord(staleApplied)] });

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
    // `lifecycle` must come from the last drained applied state, not the caller's
    // (possibly stale) `targetState`. Here the drained state is `running` while
    // the caller passes a stale `completed` input; collapsing the `?? targetState`
    // fallback to `&& targetState` would surface the stale `completed`.
    const frameKey = buildFrameKey('1');
    const drainedState = state({ id: runId, lifecycle: 'running' });
    jest.spyOn(completionService, 'drainResolvedCompletions').mockResolvedValue({
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
    jest.spyOn(completionService, 'drainResolvedCompletions').mockResolvedValue({
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
  // The scaffold mirrors the line-509 "later no-op collect" test: drain reports
  // `continue` with `applied: []`, and `manager.load` reloads the persisted
  // target whose snapshot carries the (malformed) frontier.
  // ---------------------------------------------------------------------------

  /** Run a no-op collect whose reloaded target snapshot carries the given frontier. */
  async function collectWithPersistedFrontier(delegateFrontier: unknown) {
    const frameKey = buildFrameKey('1');
    const target = state({
      retryCount: 1,
      snapshot: { context: { delegateFrontier } },
    });
    await manager.save(target);
    jest.spyOn(completionService, 'drainResolvedCompletions').mockResolvedValue({
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
    await expect(
      collectWithPersistedFrontier([{ runbook: 'child.md', token: 'rdtk_x' }]),
    ).rejects.toBeInstanceOf(InvalidRunbookStateError);
  });

  it('rejects a frontier entry missing a string runbook', async () => {
    // L287 `typeof entry.runbook === 'string'`: runbook absent → false → throw.
    await expect(
      collectWithPersistedFrontier([{ id: '1.1', token: 'rdtk_x' }]),
    ).rejects.toBeInstanceOf(InvalidRunbookStateError);
  });

  it('rejects a frontier entry missing a string token', async () => {
    // L288 `typeof entry.token === 'string'`: token absent → false → throw.
    await expect(
      collectWithPersistedFrontier([{ id: '1.1', runbook: 'child.md' }]),
    ).rejects.toBeInstanceOf(InvalidRunbookStateError);
  });

  it('treats an empty-array delegateFrontier as no re-entry (no observations surfaced)', async () => {
    // L313 `frontier.length === 0`: an empty (but valid) array short-circuits
    // to `status: 'none'`, so the collect maps to the idempotent `already_collected`
    // no-op with NO `reEntryObservations`. The `false`/`&&` mutants of L313 would
    // fall through to the observation path. `observeExecutionUnitEntry` is spied to
    // prove it is never reached.
    const observeEntrySpy = jest.spyOn(actorService, 'observeExecutionUnitEntry');
    const outcome = await collectWithPersistedFrontier([]);

    expect(outcome).toMatchObject({
      kind: 'already_collected',
      targetRunId: runId,
      step: '1',
    });
    expect(outcome).not.toHaveProperty('reEntryObservations');
    expect(observeEntrySpy).not.toHaveBeenCalled();
  });

  it('treats a present frontier with an undefined cursor substep as no re-entry', async () => {
    // L313 `advanced.substep === undefined`: a valid non-empty frontier but a
    // cursor that has advanced off the substeps (substep undefined) short-circuits
    // to `status: 'none'`. Kills the L313 substep-clause mutants and confirms the
    // observation path is skipped.
    const frameKey = buildFrameKey('1');
    const target = state({
      substep: undefined,
      retryCount: 1,
      snapshot: {
        context: {
          delegateFrontier: [{ id: '1.1', runbook: 'child.md', token: 'rdtk_x' }],
        },
      },
    });
    await manager.save(target);
    jest.spyOn(completionService, 'drainResolvedCompletions').mockResolvedValue({
      status: 'continue',
      state: target,
      unresolved: 1,
      applied: [],
    });
    const observeEntrySpy = jest.spyOn(actorService, 'observeExecutionUnitEntry');

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
    expect(observeEntrySpy).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Region 4 — observation input wiring + result spread
  // (collection-service.ts L323-335, L469).
  //
  // Assert the exact `entry` object passed to `observeExecutionUnitEntry`, plus
  // the conditional `reEntryObservations` spread on the result.
  // ---------------------------------------------------------------------------

  /** Capture-and-assert helper: run a no-op collect that projects a valid frontier. */
  async function projectFrontierAndCapture(overrides: Partial<RunbookState>) {
    const frameKey = buildFrameKey('1');
    const frontier = [{ id: '1.1', runbook: 'child-a.md', token: 'rdtk_retry_a' }];
    const target = state({
      retryCount: 1,
      snapshot: { context: { delegateFrontier: frontier } },
      ...overrides,
    });
    await manager.save(target);
    jest.spyOn(completionService, 'drainResolvedCompletions').mockResolvedValue({
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
    const observeEntrySpy = jest
      .spyOn(actorService, 'observeExecutionUnitEntry')
      .mockResolvedValue(reEntryEffects);
    jest.spyOn(actorService, 'sendAndSync').mockResolvedValue({
      state: target,
      snapshot: { context: {} },
      effects: [],
    });
    const outcome = await collectionService.collectDelegationOutcomes({
      targetState: target,
      steps,
      callerEvidence: ORCHESTRATOR_EVIDENCE,
      frame: activeFrame(frameKey, 1),
    });
    return { outcome, observeEntrySpy, frontier, reEntryEffects };
  }

  it('passes a non-empty steps array and a fully-populated substep entry to observeExecutionUnitEntry', async () => {
    // Region 4 input wiring:
    //   * L325 `[...input.steps]` → `[]`: assert the steps arg is non-empty and
    //     equals the runbook steps.
    //   * L326 object literal → `{}`: assert the entry carries its populated fields.
    //   * L331 `isSubstep: true` → `false`: assert `isSubstep === true`.
    //   * frontier wiring: assert `delegateFrontier` equals the projected frontier.
    const { observeEntrySpy, frontier } = await projectFrontierAndCapture({});

    expect(observeEntrySpy).toHaveBeenCalledTimes(1);
    const [idArg, stepsArg, entry] = observeEntrySpy.mock.calls[0];
    expect(idArg).toBe(runId);
    expect(stepsArg).toEqual(steps);
    expect(stepsArg.length).toBeGreaterThan(0);
    expect(entry).toMatchObject({
      stepId: '1',
      substepId: '1',
      stepName: '1',
      isSubstep: true,
      delegateFrontier: frontier,
    });
    expect(entry).toHaveProperty('position');
  });

  it('forwards prompted:true to observeExecutionUnitEntry when the reloaded cursor was prompted', async () => {
    // L332 `!!advanced.prompted` (mutant `advanced.prompted` collapse): with a
    // truthy `prompted` on the reloaded state, the entry's `prompted` must be the
    // boolean `true`. (`!!` and the bare value coincide for an already-boolean
    // input, so the contrast that fixes this is the falsy test below.)
    const { observeEntrySpy } = await projectFrontierAndCapture({ prompted: true });
    const entry = observeEntrySpy.mock.calls[0][2];
    expect(entry.prompted).toBe(true);
  });

  it('forwards prompted:false to observeExecutionUnitEntry when the reloaded cursor was not prompted', async () => {
    // L332 `!!advanced.prompted` (mutant `!advanced.prompted`): with `prompted`
    // undefined/falsy, the coerced value must be the boolean `false`. The
    // `!advanced.prompted` mutant would forward `true` here, so this kills it; the
    // pair with the prompted:true test above pins both L332 BooleanLiteral mutants.
    const { observeEntrySpy } = await projectFrontierAndCapture({ prompted: undefined });
    const entry = observeEntrySpy.mock.calls[0][2];
    expect(entry.prompted).toBe(false);
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
});
