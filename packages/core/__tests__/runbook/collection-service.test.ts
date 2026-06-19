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
  assertClaimId,
  assertDelegationTokenHash,
  assertRunId,
  claimControllerContext,
  trustedRunControllerContext,
  UNKNOWN_ACTOR_CONTEXT,
  type RunbookState,
} from '../../src/runbook/index.js';
import { ExecutionLifecycleService } from '../../src/runbook/execution-lifecycle-service.js';
import {
  activeFrame,
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
  exactFrame,
} from '../../src/runbook/targeting.js';
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

describe('RunbookCollectionService', () => {
  let tmp: string;
  let manager: RunbookStateManager;
  let actorService: RunbookActorService;
  let lifecycleService: ExecutionLifecycleService;
  let completionService: RunbookCompletionService;
  let collectionService: RunbookCollectionService;

  const runId = assertRunId('rd_11111111111111111111111111111111');
  const controlledRunId = assertRunId('rd_22222222222222222222222222222222');
  const ancestorRunId = assertRunId('rd_33333333333333333333333333333333');
  const claimId = assertClaimId('rdclm_abcdefghijklmnopqrstu1');
  const tokenHash = assertDelegationTokenHash(
    'sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  );

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
    collectionService = new RunbookCollectionService({
      manager,
      actorService,
      lifecycleService,
      completionService,
    });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('rejects unknown actor context before inspecting outcomes', async () => {
    await manager.save(state());

    await expect(
      collectionService.collectDelegationOutcomes({
        targetState: state(),
        steps,
        actorContext: UNKNOWN_ACTOR_CONTEXT,
      }),
    ).resolves.toEqual({
      kind: 'actor_context_required',
      intent: 'delegation-collection',
    });
  });

  it('reports missing outcomes for delegate substeps without recorded outcomes', async () => {
    const target = state();
    await manager.save(target);

    await expect(
      collectionService.collectDelegationOutcomes({
        targetState: target,
        steps,
        actorContext: trustedRunControllerContext(runId, 'direct-cli'),
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
        actorContext: trustedRunControllerContext(runId, 'direct-cli'),
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
      actorContext: trustedRunControllerContext(runId, 'direct-cli'),
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
        actorContext: trustedRunControllerContext(runId, 'direct-cli'),
        frame: activeFrame(frameKey, 1),
      }),
    ).resolves.toMatchObject({
      kind: 'already_collected',
      targetRunId: runId,
      step: '1',
    });
  });

  it('allows a claim controller to collect outcomes for delegations issued by its controlled run', async () => {
    const controlled = state({ id: controlledRunId });
    await manager.save(controlled);

    await expect(
      collectionService.collectDelegationOutcomes({
        targetState: controlled,
        steps,
        actorContext: claimControllerContext({ claimId, tokenHash, controlledRunId }),
      }),
    ).resolves.toMatchObject({
      kind: 'missing_outcomes',
      targetRunId: controlledRunId,
      step: '1',
      missingSubsteps: ['1.1', '1.2'],
    });
  });

  it('rejects a claim controller collecting into its delegating ancestor', async () => {
    const ancestor = state({ id: ancestorRunId });
    await manager.save(ancestor);

    await expect(
      collectionService.collectDelegationOutcomes({
        targetState: ancestor,
        steps,
        actorContext: claimControllerContext({ claimId, tokenHash, controlledRunId }),
      }),
    ).resolves.toEqual({
      kind: 'collect_requires_orchestrator',
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
        actorContext: trustedRunControllerContext(runId, 'direct-cli'),
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
        actorContext: trustedRunControllerContext(runId, 'direct-cli'),
      }),
    ).resolves.toMatchObject({
      kind: 'collection_failed',
      targetRunId: runId,
      reason: 'not_delegate_step',
      code: 'NOT_DELEGATE_STEP',
    });
  });

  it('reports missing_outcomes for a partial collection (only one of two delegate substeps resolved)', async () => {
    // Substep 1 has a frame-matching outcome; substep 2 does not. The missing
    // gate fires before any drain, listing exactly the unresolved substep.
    const frameKey = buildFrameKey('1');
    const target = state({
      resolvedCompletions: {
        [buildCompletionKey(activeFrame(frameKey, 1), '1')]: buildResolvedCompletion({
          agentId: 'delegated-a',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: activeFrame(frameKey, 1),
          completedAt: '2026-06-17T00:07:00.000Z',
        }),
      },
    });
    await manager.save(target);

    await expect(
      collectionService.collectDelegationOutcomes({
        targetState: target,
        steps,
        actorContext: trustedRunControllerContext(runId, 'direct-cli'),
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

  const delegationLinkage = {
    kind: 'delegation' as const,
    parentRunId: ancestorRunId,
    parentStepId: '1.1',
    parentStep: '1',
    parentFrameKey: buildFrameKey('1'),
    parentEntry: 1,
    tokenHash,
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
      actorContext: claimControllerContext({ claimId, tokenHash, controlledRunId }),
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
    });
    // Single-level: one outcome recorded upward; the ancestor is NOT collected.
    const freshAncestor = await manager.load(ancestorRunId);
    expect(Object.keys(freshAncestor?.resolvedCompletions ?? {})).toHaveLength(1);
    expect(freshAncestor?.step).toBe('1');
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
      actorContext: claimControllerContext({ claimId, tokenHash, controlledRunId }),
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
    });
  });

  it('reports reportedTerminalOutcome:false for a terminal ROOT run (no parentLinkage)', async () => {
    const { controlled } = await seedTerminalControlled('completed', 'pass');

    const outcome = await collectionService.collectDelegationOutcomes({
      targetState: controlled,
      steps: oneSubstepSteps,
      actorContext: trustedRunControllerContext(controlledRunId, 'direct-cli'),
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
      actorContext: trustedRunControllerContext(runId, 'direct-cli'),
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
        actorContext: trustedRunControllerContext(runId, 'direct-cli'),
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
});
