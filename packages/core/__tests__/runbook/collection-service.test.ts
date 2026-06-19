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
  const claimId = 'claim-collection-middle';
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
});
