import { describe, expect, it } from '@jest/globals';
import {
  readDelegationCollectionPending,
  readDelegationCollectionPendingForPolicy,
  readDelegationOutcomeReportedFacts,
  type RunbookState,
} from '../../src/runbook/index.js';
import {
  activeFrame,
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
  exactFrame,
  inactiveFrame,
} from '../../src/runbook/targeting.js';
import { brandRunIdForTest, brandStoredOutputsForTest } from '../../src/testing/effective-vars.js';

const runbookId = brandRunIdForTest('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

function state(overrides: Partial<RunbookState> = {}): RunbookState {
  return {
    id: runbookId,
    runbook: { source: 'project', path: 'parent.md' },
    runbookPath: 'parent.md',
    step: '1',
    stepName: 'Parent',
    substep: '1',
    retryCount: 0,
    variables: brandStoredOutputsForTest({}),
    steps: [],
    resolvedCompletions: {},
    frameEntryCounts: { [buildFrameKey('1')]: 1 },
    activeFrameKey: buildFrameKey('1'),
    activeEntry: 1,
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lifecycle: 'running',
    schemaVersion: 1,
    frontmatterOutputs: [],
    ...overrides,
  };
}

describe('readDelegationOutcomeReportedFacts', () => {
  it('maps delegation completion rows to outcome-reported facts', () => {
    const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
    const parent = state({
      resolvedCompletions: {
        [key]: buildResolvedCompletion({
          agentId: 'delegation',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: activeFrame(buildFrameKey('1'), 1),
          finalVars: { ChildValue: 'ready' },
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    });

    expect(readDelegationOutcomeReportedFacts(parent)).toEqual([
      {
        kind: 'delegation-outcome-reported',
        completionKey: key,
        parentRunId: runbookId,
        targetStep: '1',
        targetSubstep: '1',
        targetFrameKey: buildFrameKey('1'),
        targetEntry: 1,
        outcome: 'pass',
        reportedAt: '2026-01-01T00:00:00.000Z',
        finalVars: { ChildValue: 'ready' },
      },
    ]);
  });

  it('ignores manual and inline resolved completions', () => {
    const manualKey = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
    const inlineKey = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '2');
    const parent = state({
      resolvedCompletions: {
        [manualKey]: buildResolvedCompletion({
          agentId: 'manual',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: activeFrame(buildFrameKey('1'), 1),
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
        [inlineKey]: buildResolvedCompletion({
          agentId: 'inline',
          result: 'fail',
          targetStep: '1',
          targetSubstep: '2',
          targetFrame: activeFrame(buildFrameKey('1'), 1),
          completedAt: '2026-01-01T00:00:01.000Z',
        }),
      },
    });

    expect(readDelegationOutcomeReportedFacts(parent)).toEqual([]);
  });
});

describe('readDelegationCollectionPending', () => {
  it('derives pending state from active-frame delegation outcomes', () => {
    const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
    const parent = state({
      resolvedCompletions: {
        [key]: buildResolvedCompletion({
          agentId: 'delegation',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: activeFrame(buildFrameKey('1'), 1),
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    });

    expect(readDelegationCollectionPending(parent)).toEqual({
      kind: 'delegation-collection-pending',
      pending: true,
      parentRunId: runbookId,
      activeFrameKey: buildFrameKey('1'),
      activeEntry: 1,
      outcomes: [
        {
          kind: 'delegation-outcome-reported',
          completionKey: key,
          parentRunId: runbookId,
          targetStep: '1',
          targetSubstep: '1',
          targetFrameKey: buildFrameKey('1'),
          targetEntry: 1,
          outcome: 'pass',
          reportedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      message:
        'A delegated claim has reported an outcome that must be collected by the orchestrator.',
    });
  });

  it('treats sentinel delegation outcomes for the active frame as pending', () => {
    const key = buildCompletionKey(inactiveFrame(buildFrameKey('1')), '1');
    const parent = state({
      resolvedCompletions: {
        [key]: buildResolvedCompletion({
          agentId: 'delegation',
          result: 'fail',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: inactiveFrame(buildFrameKey('1')),
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    });

    const pending = readDelegationCollectionPending(parent);

    expect(pending.pending).toBe(true);
    expect(pending.outcomes).toEqual([
      expect.objectContaining({
        completionKey: key,
        targetEntry: 0,
        outcome: 'fail',
      }),
    ]);
  });

  it('does not mark collection pending for a different exact entry', () => {
    const key = buildCompletionKey(exactFrame(buildFrameKey('1'), 2), '1');
    const parent = state({
      resolvedCompletions: {
        [key]: buildResolvedCompletion({
          agentId: 'delegation',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: exactFrame(buildFrameKey('1'), 2),
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    });

    expect(readDelegationCollectionPending(parent)).toEqual({
      kind: 'delegation-collection-pending',
      pending: false,
      parentRunId: runbookId,
      activeFrameKey: buildFrameKey('1'),
      activeEntry: 1,
      outcomes: [],
    });
  });

  it('narrows the pending variant to expose operator guidance', () => {
    const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
    const parent = state({
      resolvedCompletions: {
        [key]: buildResolvedCompletion({
          agentId: 'delegation',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: activeFrame(buildFrameKey('1'), 1),
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    });

    const model = readDelegationCollectionPending(parent);

    if (!model.pending) {
      throw new Error('expected collection pending');
    }
    expect(model.message).toBe(
      'A delegated claim has reported an outcome that must be collected by the orchestrator.',
    );
    expect(model.outcomes[0]?.outcome).toBe('pass');
  });

  it('narrows the non-pending variant to an empty outcome list', () => {
    const model = readDelegationCollectionPending(state());

    if (model.pending) {
      throw new Error('expected no collection pending');
    }
    expect(model.outcomes).toEqual([]);
  });

  it('marks a reported outcome in a non-active still-open FOR frame as policy pending', () => {
    const targetFrameKey = buildFrameKey('1', 2);
    const key = buildCompletionKey(exactFrame(targetFrameKey, 2), '1');
    const parent = state({
      step: '2',
      substep: undefined,
      activeFrameKey: buildFrameKey('2'),
      activeEntry: 1,
      frameEntryCounts: {
        [buildFrameKey('2')]: 1,
        [targetFrameKey]: 2,
      },
      // Step 1's FOR loop is still live on the stack at iteration 2, so its frame
      // `1|2` is open even though the cursor has moved to step 2.
      forStack: [
        {
          stepId: '1',
          iteration: 2,
          start: 1,
          end: 2,
          implicit: false,
          source: { kind: 'range' as const },
        },
      ],
      resolvedCompletions: {
        [key]: buildResolvedCompletion({
          agentId: 'delegation',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: exactFrame(targetFrameKey, 2),
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    });

    expect(readDelegationCollectionPending(parent).pending).toBe(false);
    expect(readDelegationCollectionPendingForPolicy(parent)).toEqual({
      kind: 'delegation-collection-pending-policy',
      pending: true,
      parentRunId: runbookId,
      outcomes: [
        expect.objectContaining({
          completionKey: key,
          targetFrameKey,
          targetEntry: 2,
          outcome: 'pass',
        }),
      ],
      message:
        'A delegated claim has reported an outcome that must be collected by the orchestrator.',
    });
  });

  it('does not mark policy pending for a FOR frame retained in entry-count history but absent from the live forStack', () => {
    // Production-real shape: the entry counter is monotonic, so a closed
    // iteration's frame key persists after the loop advances/exits. Openness
    // must derive from the live forStack — never from entry-count history —
    // otherwise a closed FOR frame would block bare mutation forever.
    const staleFrameKey = buildFrameKey('1', 3);
    const key = buildCompletionKey(exactFrame(staleFrameKey, 3), '1');
    const parent = state({
      step: '2',
      substep: undefined,
      activeFrameKey: buildFrameKey('2'),
      activeEntry: 4,
      // Every step-1 iteration frame remains in the monotonic entry counter.
      frameEntryCounts: {
        [buildFrameKey('2')]: 4,
        [buildFrameKey('1', 1)]: 1,
        [buildFrameKey('1', 2)]: 2,
        [staleFrameKey]: 3,
      },
      // The FOR loop at step 1 has exited: it is no longer on the live stack.
      forStack: [],
      resolvedCompletions: {
        [key]: buildResolvedCompletion({
          agentId: 'delegation',
          result: 'fail',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: exactFrame(staleFrameKey, 3),
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    });

    expect(readDelegationCollectionPendingForPolicy(parent)).toEqual({
      kind: 'delegation-collection-pending-policy',
      pending: false,
      parentRunId: runbookId,
      outcomes: [],
    });
  });

  it('marks an unscoped outcome as policy pending until it is collected, regardless of cursor', () => {
    const targetFrameKey = buildFrameKey('1');
    const key = buildCompletionKey(activeFrame(targetFrameKey, 1), '1');
    const parent = state({
      // The cursor has moved on to step 2, but the unscoped step-1 outcome has
      // not been collected. An uncollected unscoped outcome stays pending — it
      // is never silently dropped by cursor movement.
      step: '2',
      substep: undefined,
      activeFrameKey: buildFrameKey('2'),
      activeEntry: 1,
      frameEntryCounts: {
        [buildFrameKey('2')]: 1,
        [targetFrameKey]: 1,
      },
      resolvedCompletions: {
        [key]: buildResolvedCompletion({
          agentId: 'delegation',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: activeFrame(targetFrameKey, 1),
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    });

    expect(readDelegationCollectionPendingForPolicy(parent)).toEqual({
      kind: 'delegation-collection-pending-policy',
      pending: true,
      parentRunId: runbookId,
      outcomes: [
        expect.objectContaining({
          completionKey: key,
          targetFrameKey,
          targetEntry: 1,
          outcome: 'pass',
        }),
      ],
      message:
        'A delegated claim has reported an outcome that must be collected by the orchestrator.',
    });
  });

  it('marks an unscoped outcome at the current cursor step as policy pending', () => {
    const targetFrameKey = buildFrameKey('1');
    const key = buildCompletionKey(activeFrame(targetFrameKey, 1), '1');
    const parent = state({
      step: '1',
      substep: '1',
      activeFrameKey: targetFrameKey,
      activeEntry: 1,
      frameEntryCounts: { [targetFrameKey]: 1 },
      resolvedCompletions: {
        [key]: buildResolvedCompletion({
          agentId: 'delegation',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: activeFrame(targetFrameKey, 1),
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    });

    expect(readDelegationCollectionPendingForPolicy(parent).pending).toBe(true);
  });
});
