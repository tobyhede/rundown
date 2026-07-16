import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import type { ResolvedStep } from '@rundown-org/parser';
import {
  ExecutionLifecycleService,
  RunbookActorService,
  RunbookCollectionService,
  RunbookCompletionService,
  RunbookStateManager,
  SessionService,
  activeFrame,
  assertRunId,
  buildFrameKey,
  type AdvanceInlineParent,
  type ClaimId,
  type RunbookState,
} from '../../src/runbook/index.js';
import { brandStoredOutputsForTest } from '../../src/testing/effective-vars.js';
import type { SubstepState } from '../../src/runbook/types.js';

// The missing-outcome gate reads only from the passed `targetState` (no disk,
// no drain), so these properties are pure: the service is wired with a real
// manager for construction, but the gate path never touches it. The gate is the
// per-frame `status === 'done'` contract (frame-aware via `findSubstepState`).

const runId = assertRunId('rd_11111111111111111111111111111111');

function tx(pass: 'CONTINUE' | 'STOP', fail: 'CONTINUE' | 'STOP') {
  return {
    pass: { kind: 'pass', retry: 0, action: { type: pass } },
    fail: { kind: 'fail', retry: 0, action: { type: fail } },
  } as const;
}

const allSubstepIds = ['1', '2', '3'] as const;

const steps: ResolvedStep[] = [
  {
    kind: 'substeps',
    name: '1',
    description: 'Delegate work',
    aggregation: { strategy: 'ALL' },
    substeps: allSubstepIds.map((id) => ({
      id,
      description: id,
      delegate: true as const,
      transitions: tx('CONTINUE', 'STOP'),
    })),
    transitions: tx('CONTINUE', 'STOP'),
  },
];

function state(overrides: Partial<RunbookState> = {}): RunbookState {
  const frameKey = buildFrameKey('1');
  return {
    id: runId,
    runbook: { source: 'project', path: 'p.md' },
    runbookPath: 'p.md',
    step: '1',
    substep: '1',
    stepName: 'Delegate work',
    retryCount: 0,
    variables: brandStoredOutputsForTest({}),
    steps: [],
    lifecycle: 'running',
    startedAt: '2026-06-17T00:00:00.000Z',
    updatedAt: '2026-06-17T00:00:00.000Z',
    activeFrameKey: frameKey,
    activeEntry: 1,
    frameEntryCounts: { [frameKey]: 1 },
    substepStates: allSubstepIds.map((id) => ({ id, frameKey, status: 'done' as const })),
    resolvedCompletions: {},
    schemaVersion: 1,
    frontmatterOutputs: [],
    ...overrides,
  };
}

/** Build `done` substep-state entries for `ids` in the given frame iteration. */
function doneSubstepStates(ids: readonly string[], iteration?: number): SubstepState[] {
  const frameKey = buildFrameKey('1', iteration);
  return ids.map((id) => ({ id, frameKey, status: 'done' as const }));
}

describe('RunbookCollectionService properties', () => {
  let tmp: string;
  let collectionService: RunbookCollectionService;
  let claimId: ClaimId;

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'collection-props-'));
    const manager = new RunbookStateManager(tmp);
    const actorService = new RunbookActorService(manager);
    const lifecycleService = new ExecutionLifecycleService(manager);
    const completionService = new RunbookCompletionService(manager, lifecycleService, actorService);
    const sessionService = new SessionService(manager);
    claimId = (await sessionService.issueRunControlClaim(runId)).claimId;
    collectionService = new RunbookCollectionService({
      sessionService,
      manager,
      actorService,
      lifecycleService,
      completionService,
      // Properties here never drive a target terminal (they assert missing/gate
      // behaviour before the drain), so a never-called fake satisfies the type.
      advanceInlineParent: jest.fn<AdvanceInlineParent>(),
    });
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const subsetArb = fc.subarray([...allSubstepIds]);

  it('missing_outcomes lists exactly the delegate substeps not done in the frame', async () => {
    await fc.assert(
      fc.asyncProperty(subsetArb, async (doneInFrame) => {
        // Restrict to a proper subset so at least one substep is missing — the
        // full set would pass the gate and reach the (machine-backed) drain.
        fc.pre(doneInFrame.length < allSubstepIds.length);

        const outcome = await collectionService.collectDelegationOutcomes({
          targetState: state({ substepStates: doneSubstepStates(doneInFrame) }),
          steps,
          // Post-R1 the delegating fixture refuses bare direct-CLI evidence;
          // the orchestrator names its run explicitly.
          callerEvidence: { kind: 'claim_bearer', claimId },
          frame: activeFrame(buildFrameKey('1'), 1),
        });

        const expectedMissing = allSubstepIds
          .filter((id) => !doneInFrame.includes(id))
          .map((id) => `1.${id}`);

        expect(outcome).toEqual({
          kind: 'missing_outcomes',
          targetRunId: runId,
          step: '1',
          missingSubsteps: expectedMissing,
        });
      }),
      { numRuns: 40 },
    );
  });

  it('substeps done in a different FOR iteration never reduce the missing set (frame-aware)', async () => {
    await fc.assert(
      fc.asyncProperty(subsetArb, async (doneInOtherFrame) => {
        // All `done` markers live in iteration 2; collection targets iteration 1,
        // so the per-frame lookup credits none of them — every substep stays
        // missing. This pins that `findSubstepState` is keyed by `(id, frameKey)`.
        const outcome = await collectionService.collectDelegationOutcomes({
          targetState: state({ substepStates: doneSubstepStates(doneInOtherFrame, 2) }),
          steps,
          // Post-R1 the delegating fixture refuses bare direct-CLI evidence;
          // the orchestrator names its run explicitly.
          callerEvidence: { kind: 'claim_bearer', claimId },
          frame: activeFrame(buildFrameKey('1'), 1),
        });

        expect(outcome).toEqual({
          kind: 'missing_outcomes',
          targetRunId: runId,
          step: '1',
          missingSubsteps: ['1.1', '1.2', '1.3'],
        });
      }),
      { numRuns: 40 },
    );
  });
});
