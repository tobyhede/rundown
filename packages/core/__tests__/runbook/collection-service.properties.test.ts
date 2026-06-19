import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
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
  activeFrame,
  assertRunId,
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
  trustedRunControllerContext,
  type RunbookState,
} from '../../src/runbook/index.js';
import { brandStoredOutputsForTest } from '../../src/testing/effective-vars.js';

// The missing-outcome gate reads only from the passed `targetState` (no disk,
// no drain), so these properties are pure: the service is wired with a real
// manager for construction, but the gate path never touches it.

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

/** Build resolved-completion entries for `ids` in the given frame iteration. */
function completionsFor(ids: readonly string[], iteration?: number) {
  const frameKey = buildFrameKey('1', iteration);
  const frame = activeFrame(frameKey, iteration ?? 1);
  const entries: Record<string, ReturnType<typeof buildResolvedCompletion>> = {};
  for (const id of ids) {
    entries[buildCompletionKey(frame, id)] = buildResolvedCompletion({
      agentId: `delegated-${id}`,
      result: 'pass',
      targetStep: '1',
      targetSubstep: id,
      targetFrame: frame,
      completedAt: '2026-06-17T00:00:00.000Z',
    });
  }
  return entries;
}

describe('RunbookCollectionService properties', () => {
  let tmp: string;
  let collectionService: RunbookCollectionService;

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'collection-props-'));
    const manager = new RunbookStateManager(tmp);
    const actorService = new RunbookActorService(manager);
    const lifecycleService = new ExecutionLifecycleService(manager);
    const completionService = new RunbookCompletionService(manager, lifecycleService, actorService);
    collectionService = new RunbookCollectionService({
      manager,
      actorService,
      lifecycleService,
      completionService,
    });
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const subsetArb = fc.subarray([...allSubstepIds]);

  it('missing_outcomes lists exactly the delegate substeps without a frame-matching outcome', async () => {
    await fc.assert(
      fc.asyncProperty(subsetArb, async (resolvedInFrame) => {
        // Restrict to a proper subset so at least one substep is missing — the
        // full set would pass the gate and reach the (machine-backed) drain.
        fc.pre(resolvedInFrame.length < allSubstepIds.length);

        const outcome = await collectionService.collectDelegationOutcomes({
          targetState: state({ resolvedCompletions: completionsFor(resolvedInFrame) }),
          steps,
          actorContext: trustedRunControllerContext(runId, 'direct-cli'),
          frame: activeFrame(buildFrameKey('1'), 1),
        });

        const expectedMissing = allSubstepIds
          .filter((id) => !resolvedInFrame.includes(id))
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

  it('completions in a different FOR iteration never reduce the missing set (frame-aware)', async () => {
    await fc.assert(
      fc.asyncProperty(subsetArb, async (resolvedInOtherFrame) => {
        // All outcomes live in iteration 2; collection targets iteration 1, so
        // none of them count — every delegate substep stays missing.
        const outcome = await collectionService.collectDelegationOutcomes({
          targetState: state({ resolvedCompletions: completionsFor(resolvedInOtherFrame, 2) }),
          steps,
          actorContext: trustedRunControllerContext(runId, 'direct-cli'),
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
