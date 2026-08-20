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
  completionTargetsFrame,
  exactFrame,
  inactiveFrame,
  type Frame,
} from '../../src/runbook/targeting.js';
import { deriveActiveCompletionFrame } from '../../src/runbook/frame-entry.js';
import {
  brandRunIdForTest,
  brandStoredOutputsForTest,
  brandInitialTemplateVarsForTest,
} from '../../src/testing/effective-vars.js';

import { CURRENT_SCHEMA_VERSION } from '../../src/runbook/index.js';

const runbookId = brandRunIdForTest('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

function state(overrides: Partial<RunbookState> = {}): RunbookState {
  return {
    prompted: false,
    templateVars: brandInitialTemplateVarsForTest({}),
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
    schemaVersion: CURRENT_SCHEMA_VERSION,
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

  it('does not mark a reported outcome in a non-active still-open FOR frame as policy pending', () => {
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
      // `1|2` is OPEN — and openness is still not enough. The drain resolves rows
      // against the ACTIVE frame only, and the entry ordinal is run-global and
      // monotonic (`advanceFrameEntry`), so a cursor that returns to `1|2` lands
      // on an entry strictly greater than 2 and never matches this row. A guard
      // that blocked here would name a row `rundown collect` can never consume.
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
      pending: false,
      parentRunId: runbookId,
      outcomes: [],
    });
  });

  it('does not mark a row stranded by GOTO/RETRY re-entry as policy pending (#749)', () => {
    // The reproduced wedge. The child reported at entry 1 while `1|` was active;
    // a `goto 1.1` then re-entered the frame, bumping `frameEntryCounts['1|']`
    // and `activeEntry` to 2 and resetting the substep to pending. The drain
    // builds the prefixes `1||2|` and `1||0|`, so the row at `1||1|1` is
    // unreachable forever — `collect` refuses it as an unresolved substep. An
    // entry-blind guard reported it pending anyway, refusing every bare
    // pass/fail/complete/stop with a completion key nothing could consume.
    const targetFrameKey = buildFrameKey('1');
    const key = buildCompletionKey(activeFrame(targetFrameKey, 1), '1');
    const parent = state({
      step: '1',
      substep: '1',
      activeFrameKey: targetFrameKey,
      activeEntry: 2,
      frameEntryCounts: { [targetFrameKey]: 2 },
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

    expect(readDelegationCollectionPending(parent).pending).toBe(false);
    expect(readDelegationCollectionPendingForPolicy(parent)).toEqual({
      kind: 'delegation-collection-pending-policy',
      pending: false,
      parentRunId: runbookId,
      outcomes: [],
    });
  });

  it('retains only open-frame outcomes when mixed open/closed outcomes coexist', () => {
    // Two reported outcomes: one in the live iteration-2 frame, one stranded in
    // the closed iteration-1 frame (still in the monotonic counter). The policy
    // read model must keep ONLY the open-frame outcome and drop the closed one.
    const openFrameKey = buildFrameKey('1', 2);
    const closedFrameKey = buildFrameKey('1', 1);
    const openKey = buildCompletionKey(exactFrame(openFrameKey, 2), '1');
    const closedKey = buildCompletionKey(exactFrame(closedFrameKey, 1), '1');
    const parent = state({
      step: '1',
      substep: '1',
      activeFrameKey: openFrameKey,
      activeEntry: 2,
      // Monotonic counter retains both iteration frames.
      frameEntryCounts: {
        [closedFrameKey]: 1,
        [openFrameKey]: 2,
      },
      // Only iteration 2 is live on the stack.
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
        [openKey]: buildResolvedCompletion({
          agentId: 'delegation',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: exactFrame(openFrameKey, 2),
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
        [closedKey]: buildResolvedCompletion({
          agentId: 'delegation',
          result: 'fail',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: exactFrame(closedFrameKey, 1),
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
          completionKey: openKey,
          targetFrameKey: openFrameKey,
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

  it('does not mark an unscoped outcome as policy pending once the cursor has left its frame', () => {
    const targetFrameKey = buildFrameKey('1');
    const key = buildCompletionKey(activeFrame(targetFrameKey, 1), '1');
    const parent = state({
      // The cursor has moved on to step 2 and the unscoped step-1 outcome was
      // never collected. It is not reachable from here: the drain resolves rows
      // against the active frame, and returning to step 1 enters `1|` at a fresh
      // (strictly greater) entry, so no future cursor matches this row either.
      // Blocking on it would refuse every bare mutation with no remedy.
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
      pending: false,
      parentRunId: runbookId,
      outcomes: [],
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

  it('reports exactly the rows the drain resolves against the live cursor', () => {
    // The agreement the two halves must not be able to drift out of: every row
    // the guard blocks on is one `completionTargetsFrame` admits for the frame
    // the drain selects against, and no other row is.
    const frameKey = buildFrameKey('1');
    const reachable = buildCompletionKey(activeFrame(frameKey, 2), '1');
    const sentinel = buildCompletionKey(inactiveFrame(frameKey), '2');
    const strandedEntry = buildCompletionKey(exactFrame(frameKey, 1), '3');
    const otherFrame = buildCompletionKey(exactFrame(buildFrameKey('2'), 2), '1');
    const row = (targetStep: string, targetSubstep: string, targetFrame: Frame) =>
      buildResolvedCompletion({
        agentId: 'delegation',
        result: 'pass',
        targetStep,
        targetSubstep,
        targetFrame,
        completedAt: '2026-01-01T00:00:00.000Z',
      });
    const parent = state({
      step: '1',
      substep: '1',
      activeFrameKey: frameKey,
      activeEntry: 2,
      frameEntryCounts: { [frameKey]: 2, [buildFrameKey('2')]: 2 },
      resolvedCompletions: {
        [reachable]: row('1', '1', activeFrame(frameKey, 2)),
        [sentinel]: row('1', '2', inactiveFrame(frameKey)),
        [strandedEntry]: row('1', '3', exactFrame(frameKey, 1)),
        [otherFrame]: row('2', '1', exactFrame(buildFrameKey('2'), 2)),
      },
    });

    const drainFrame = deriveActiveCompletionFrame(parent);
    const drainReachable = readDelegationOutcomeReportedFacts(parent)
      .filter((fact) => completionTargetsFrame(drainFrame, fact))
      .map((fact) => fact.completionKey);

    // Facts sort by persisted completion key: `1||0|2` precedes `1||2|1`.
    expect(drainReachable).toEqual([sentinel, reachable]);
    expect(
      readDelegationCollectionPendingForPolicy(parent).outcomes.map((o) => o.completionKey),
    ).toEqual(drainReachable);
    expect(readDelegationCollectionPending(parent).outcomes.map((o) => o.completionKey)).toEqual(
      drainReachable,
    );
  });
});
