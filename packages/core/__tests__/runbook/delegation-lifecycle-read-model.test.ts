import { describe, expect, it } from '@jest/globals';
import {
  readDelegationCollectionPending,
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
    frameEntries: { [buildFrameKey('1')]: 1 },
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
});
