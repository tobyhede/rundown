import { describe, expect, it } from '@jest/globals';
import type {
  ResolvedStep,
  ResolvedStepWithSubsteps,
  Substep,
  Transitions,
} from '@rundown-org/parser';

import {
  buildFrameKey,
  deriveDelegateFrontier,
  inferAllDelegateSubsteps,
  inferDelegationTarget,
  inferRunbookFromStep,
  isPostDelegateAggregationCursor,
  resolveDelegateTarget,
  type DelegationInferenceState,
  type FrameKey,
  type RunbookState,
  type StepDelegation,
  type SubstepState,
} from '../../src/runbook/index.js';
import type { DelegateFrontierEntry } from '../../src/index.js';
import {
  brandEffectiveVarsForTest,
  brandRunIdForTest,
  brandStoredOutputsForTest,
} from '../../src/testing/effective-vars.js';
import { assertDelegationTokenHash } from '../../src/runbook/delegation-token.js';

const DEFAULT_TRANSITIONS: Transitions = {
  pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
  fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
};

function makeSubstep(overrides: Partial<Substep> & { id: string; description: string }): Substep {
  return { transitions: DEFAULT_TRANSITIONS, ...overrides };
}

function makeStepWithSubsteps(
  name: string,
  substeps: readonly Substep[],
): ResolvedStepWithSubsteps {
  return {
    kind: 'substeps',
    name,
    description: `Step ${name}`,
    transitions: DEFAULT_TRANSITIONS,
    substeps,
  };
}

function makeState(overrides: Partial<DelegationInferenceState> = {}): DelegationInferenceState {
  return {
    id: brandRunIdForTest(`rd_${'1'.repeat(32)}`),
    step: '1',
    ...overrides,
  };
}

function makeActiveDelegation(): StepDelegation {
  return {
    tokenHash: assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`),
    childRunbookPath: 'child.runbook.md',
    childRunbookRef: { source: 'project', path: 'child.runbook.md' },
    contextSnapshot: { vars: brandEffectiveVarsForTest({}), ancestors: [] },
    childRunId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    cancelledAt: null,
  };
}

describe('inferDelegationTarget', () => {
  it('returns the first pending DELEGATE substep with a runbook ref', () => {
    const steps: ResolvedStep[] = [
      makeStepWithSubsteps('1', [
        makeSubstep({ id: '1', description: 'A', runbooks: ['manual.runbook.md'] }),
        makeSubstep({ id: '2', description: 'B', runbooks: ['child.runbook.md'], delegate: true }),
      ]),
    ];

    const result = inferDelegationTarget(makeState(), steps);

    expect(result).toEqual({ runbookRef: 'child.runbook.md', stepId: '1.2' });
  });

  it('throws RD-813 when runbook-list substeps are not marked DELEGATE', () => {
    const steps: ResolvedStep[] = [
      makeStepWithSubsteps('1', [
        makeSubstep({ id: '1', description: 'A', runbooks: ['child.runbook.md'] }),
      ]),
    ];

    expect(() => inferDelegationTarget(makeState(), steps)).toThrow(
      expect.objectContaining({ code: 'RD-813' }),
    );
  });
});

describe('inferRunbookFromStep', () => {
  it('returns the runbook ref for a targeted DELEGATE substep', () => {
    const steps: ResolvedStep[] = [
      makeStepWithSubsteps('1', [
        makeSubstep({ id: '1', description: 'A', runbooks: ['child.runbook.md'], delegate: true }),
      ]),
    ];

    const result = inferRunbookFromStep(makeState(), steps, '1.1');

    expect(result).toBe('child.runbook.md');
  });

  it('throws RD-813 when the targeted runbook-list substep is not marked DELEGATE', () => {
    const steps: ResolvedStep[] = [
      makeStepWithSubsteps('1', [
        makeSubstep({ id: '1', description: 'A', runbooks: ['child.runbook.md'] }),
      ]),
    ];

    expect(() => inferRunbookFromStep(makeState(), steps, '1.1')).toThrow(
      expect.objectContaining({ code: 'RD-813' }),
    );
  });
});

describe('inferAllDelegateSubsteps', () => {
  it('returns only delegate substeps in the active frame', () => {
    const steps: ResolvedStep[] = [
      makeStepWithSubsteps('1', [
        makeSubstep({ id: '1', description: 'A', runbooks: ['a.runbook.md'], delegate: true }),
        makeSubstep({ id: '2', description: 'B', runbooks: ['b.runbook.md'] }),
        makeSubstep({ id: '3', description: 'C', runbooks: ['c.runbook.md'], delegate: true }),
      ]),
      makeStepWithSubsteps('2', [
        makeSubstep({ id: '1', description: 'D', runbooks: ['d.runbook.md'], delegate: true }),
      ]),
    ];

    const result = inferAllDelegateSubsteps(makeState(), steps);

    expect(result).toEqual([
      { runbookRef: 'a.runbook.md', stepId: '1.1' },
      { runbookRef: 'c.runbook.md', stepId: '1.3' },
    ]);
  });

  it('throws when a delegate substep lacks a runbook ref during auto-inference', () => {
    const steps: ResolvedStep[] = [
      makeStepWithSubsteps('1', [makeSubstep({ id: '1', description: 'A', delegate: true })]),
    ];

    expect(() => inferAllDelegateSubsteps(makeState(), steps)).toThrow(/RD-814|runbook reference/i);
  });

  it('skips done substeps', () => {
    const steps: ResolvedStep[] = [
      makeStepWithSubsteps('1', [
        makeSubstep({ id: '1', description: 'A', runbooks: ['a.runbook.md'], delegate: true }),
        makeSubstep({ id: '2', description: 'B', runbooks: ['b.runbook.md'], delegate: true }),
      ]),
    ];
    const substepStates: SubstepState[] = [
      { id: '1', frameKey: buildFrameKey('1'), status: 'done', result: 'pass' },
    ];

    const result = inferAllDelegateSubsteps(makeState({ substepStates }), steps);

    expect(result).toEqual([{ runbookRef: 'b.runbook.md', stepId: '1.2' }]);
  });

  it('skips already active delegated substeps', () => {
    const steps: ResolvedStep[] = [
      makeStepWithSubsteps('1', [
        makeSubstep({ id: '1', description: 'A', runbooks: ['a.runbook.md'], delegate: true }),
        makeSubstep({ id: '2', description: 'B', runbooks: ['b.runbook.md'], delegate: true }),
      ]),
    ];
    const substepStates: SubstepState[] = [
      {
        id: '1',
        frameKey: buildFrameKey('1'),
        status: 'pending',
        delegation: makeActiveDelegation(),
      },
    ];

    const result = inferAllDelegateSubsteps(makeState({ substepStates }), steps);

    expect(result).toEqual([{ runbookRef: 'b.runbook.md', stepId: '1.2' }]);
  });

  it('rejects nested delegation', () => {
    const steps: ResolvedStep[] = [
      makeStepWithSubsteps('1', [
        makeSubstep({ id: '1', description: 'A', runbooks: ['a.runbook.md'], delegate: true }),
      ]),
    ];

    expect(() =>
      inferAllDelegateSubsteps(
        makeState({
          parentLinkage: {
            kind: 'delegation',
            parentRunId: brandRunIdForTest(`rd_${'2'.repeat(32)}`),
            parentStepId: '1.1',
            parentStep: '1',
            parentFrameKey: buildFrameKey('1'),
            parentEntry: 1,
            tokenHash: assertDelegationTokenHash(`sha256:${'b'.repeat(64)}`),
          },
        }),
        steps,
      ),
    ).toThrow(expect.objectContaining({ code: 'RD-819' }));
  });
});

describe('inferDelegationTarget', () => {
  it('does not infer a delegation target from a non-DELEGATE substep with runbooks', () => {
    const state = makeState({ step: '1' });
    const steps: ResolvedStep[] = [
      makeStepWithSubsteps('1', [
        makeSubstep({
          id: '1',
          description: 'Inline child',
          runbooks: ['child.runbook.md'],
        }),
      ]),
    ];

    expect(() => inferDelegationTarget(state, steps)).toThrow(
      expect.objectContaining({ code: 'RD-813' }),
    );
  });

  it('does not infer a delegation target from a DELEGATE substep without runbooks', () => {
    const state = makeState({ step: '1' });
    const steps: ResolvedStep[] = [
      makeStepWithSubsteps('1', [
        makeSubstep({
          id: '1',
          description: 'Write deployment notes',
          delegate: true,
          runbooks: undefined,
        }),
      ]),
    ];

    expect(() => inferDelegationTarget(state, steps)).toThrow(
      expect.objectContaining({ code: 'RD-814' }),
    );
  });
});

describe('resolveDelegateTarget', () => {
  // A single DELEGATE step "1" with two delegate substeps 1.1 and 1.2,
  // each carrying runbooks: ['child.runbook.md'].
  function buildDelegateSteps(): ResolvedStep[] {
    return [
      makeStepWithSubsteps('1', [
        makeSubstep({ id: '1', description: 'A', runbooks: ['child.runbook.md'], delegate: true }),
        makeSubstep({ id: '2', description: 'B', runbooks: ['child.runbook.md'], delegate: true }),
      ]),
    ];
  }

  function buildNonDelegateSteps(): ResolvedStep[] {
    return [
      makeStepWithSubsteps('1', [
        makeSubstep({ id: '1', description: 'A', runbooks: ['child.runbook.md'] }),
      ]),
    ];
  }

  it('returns issuable when a delegate substep has no active delegation', () => {
    const state = makeState({ step: '1' });
    const res = resolveDelegateTarget(state, buildDelegateSteps(), []);
    expect(res).toEqual({
      kind: 'issuable',
      target: { runbookRef: 'child.runbook.md', stepId: '1.1' },
    });
  });

  it('returns already-issued (with frontier token) when all substeps are issued', () => {
    const frameKey = buildFrameKey('1');
    const substepStates: SubstepState[] = [
      { id: '1', frameKey, status: 'pending', delegation: makeActiveDelegation() },
      { id: '2', frameKey, status: 'pending', delegation: makeActiveDelegation() },
    ];
    const state = makeState({ step: '1', activeFrameKey: frameKey, substepStates });
    const frontier: DelegateFrontierEntry[] = [
      { id: '1.1', runbook: 'child.runbook.md', token: 'rdtk_aaa' },
      { id: '1.2', runbook: 'child.runbook.md', token: 'rdtk_bbb' },
    ];
    const res = resolveDelegateTarget(state, buildDelegateSteps(), frontier);
    expect(res).toEqual({
      kind: 'already-issued',
      stepId: '1.1',
      token: 'rdtk_aaa',
      runbookRef: 'child.runbook.md',
    });
  });

  it('returns none when the current step has no delegate substeps', () => {
    const state = makeState({ step: '1' });
    const res = resolveDelegateTarget(state, buildNonDelegateSteps(), []);
    expect(res).toEqual({ kind: 'none' });
  });

  it('returns none when an active delegation carries no frontier token', () => {
    // Every delegate substep already has an active delegation, but the frontier
    // is empty (no recoverable token). With nothing issuable and no frontier
    // entry to echo, the resolution falls through to `none`.
    const frameKey = buildFrameKey('1');
    const substepStates: SubstepState[] = [
      { id: '1', frameKey, status: 'pending', delegation: makeActiveDelegation() },
      { id: '2', frameKey, status: 'pending', delegation: makeActiveDelegation() },
    ];
    const state = makeState({ step: '1', activeFrameKey: frameKey, substepStates });
    const res = resolveDelegateTarget(state, buildDelegateSteps(), []);
    expect(res).toEqual({ kind: 'none' });
  });

  it('prefers an issuable substep over an earlier already-issued one', () => {
    // 1.1 already has an active delegation (would be already-issued), but 1.2 is
    // still issuable. The issuable substep wins in document order via the early
    // return, so a fresh issue is preferred over echoing the pending token.
    const frameKey = buildFrameKey('1');
    const substepStates: SubstepState[] = [
      { id: '1', frameKey, status: 'pending', delegation: makeActiveDelegation() },
    ];
    const state = makeState({ step: '1', activeFrameKey: frameKey, substepStates });
    const frontier: DelegateFrontierEntry[] = [
      { id: '1.1', runbook: 'child.runbook.md', token: 'rdtk_aaa' },
    ];
    const res = resolveDelegateTarget(state, buildDelegateSteps(), frontier);
    expect(res).toEqual({
      kind: 'issuable',
      target: { runbookRef: 'child.runbook.md', stepId: '1.2' },
    });
  });

  it('skips done substeps and returns the next issuable one', () => {
    const frameKey = buildFrameKey('1');
    const substepStates: SubstepState[] = [{ id: '1', frameKey, status: 'done', result: 'pass' }];
    const state = makeState({ step: '1', activeFrameKey: frameKey, substepStates });
    const res = resolveDelegateTarget(state, buildDelegateSteps(), []);
    expect(res).toEqual({
      kind: 'issuable',
      target: { runbookRef: 'child.runbook.md', stepId: '1.2' },
    });
  });

  it('is active-frame isolated: a delegation in another frame does not block issuance', () => {
    // The active frame is "1|2" but the only delegation record is in "1|1".
    // resolveDelegateTarget must scope to the active frame and treat 1.1 as
    // issuable, ignoring the stale other-frame delegation.
    const otherFrame = buildFrameKey('1', 1);
    const activeFrameKey = buildFrameKey('1', 2);
    const substepStates: SubstepState[] = [
      { id: '1', frameKey: otherFrame, status: 'pending', delegation: makeActiveDelegation() },
    ];
    const state = makeState({ step: '1', activeFrameKey, substepStates });
    const res = resolveDelegateTarget(state, buildDelegateSteps(), []);
    expect(res).toEqual({
      kind: 'issuable',
      target: { runbookRef: 'child.runbook.md', stepId: '1.1' },
    });
  });

  it('throws RD-814 when a delegate substep lacks a runbook reference', () => {
    const steps: ResolvedStep[] = [
      makeStepWithSubsteps('1', [makeSubstep({ id: '1', description: 'A', delegate: true })]),
    ];
    const state = makeState({ step: '1' });
    expect(() => resolveDelegateTarget(state, steps, [])).toThrow(/RD-814|runbook reference/i);
  });
});

describe('deriveDelegateFrontier', () => {
  /**
   * Build a substep state carrying a pending (non-cancelled) delegation with a
   * recoverable token, scoped to a specific frame.
   *
   * @param id - Substep id.
   * @param frameKey - Frame key scoping this substep instance.
   * @param token - Recoverable delegation token (omit to model a token-less record).
   * @returns A pending-delegation substep state.
   */
  function pendingDelegationSubstep(
    id: string,
    frameKey: string,
    token: string | undefined,
  ): SubstepState {
    return {
      id,
      frameKey: frameKey as FrameKey,
      status: 'pending',
      delegation: {
        ...(token !== undefined ? { token } : {}),
        tokenHash: assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`),
        childRunbookPath: 'child.runbook.md',
        childRunbookRef: { source: 'project', path: 'child.runbook.md' },
        contextSnapshot: { vars: brandEffectiveVarsForTest({}), ancestors: [] },
        childRunId: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        cancelledAt: null,
      },
    };
  }

  /**
   * Build a minimal `RunbookState` whose `substepStates` may span multiple
   * frames, with the cursor positioned in `activeFrameKey`.
   *
   * @param activeFrameKey - Frame the cursor is currently in.
   * @param substepStates - Per-frame substep states.
   * @returns A runbook state suitable for `deriveDelegateFrontier`.
   */
  function makeRunbookState(
    activeFrameKey: string,
    substepStates: readonly SubstepState[],
  ): RunbookState {
    return {
      id: brandRunIdForTest(`rd_${'1'.repeat(32)}`),
      runbook: { source: 'project', path: 'parent.md' },
      runbookPath: 'parent.md',
      step: '1',
      stepName: 'Main step',
      retryCount: 0,
      variables: brandStoredOutputsForTest({}),
      steps: [{ id: '1', status: 'running' }],
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lifecycle: 'running',
      schemaVersion: 1,
      activeFrameKey: activeFrameKey as FrameKey,
      substepStates,
    };
  }

  it('returns only the active frame entry when iterations share a substep id', () => {
    const state = makeRunbookState('1|2', [
      pendingDelegationSubstep('1', '1|1', 'stale-iter1-token'),
      pendingDelegationSubstep('1', '1|2', 'fresh-iter2-token'),
    ]);

    const frontier = deriveDelegateFrontier(state);

    expect(frontier).toEqual([
      { id: '1.1', runbook: 'child.runbook.md', token: 'fresh-iter2-token' },
    ]);
    expect(frontier.map((entry) => entry.token)).not.toContain('stale-iter1-token');
  });

  it('is frame-scoped, not array-order dependent', () => {
    const substeps = [
      pendingDelegationSubstep('1', '1|1', 'iter1-token'),
      pendingDelegationSubstep('1', '1|2', 'iter2-token'),
    ];

    expect(deriveDelegateFrontier(makeRunbookState('1|1', substeps))).toEqual([
      { id: '1.1', runbook: 'child.runbook.md', token: 'iter1-token' },
    ]);
    expect(deriveDelegateFrontier(makeRunbookState('1|2', substeps))).toEqual([
      { id: '1.1', runbook: 'child.runbook.md', token: 'iter2-token' },
    ]);
  });

  it('surfaces a single non-FOR frame delegation', () => {
    const state = makeRunbookState('1|', [pendingDelegationSubstep('1', '1|', 'tok')]);

    expect(deriveDelegateFrontier(state)).toEqual([
      { id: '1.1', runbook: 'child.runbook.md', token: 'tok' },
    ]);
  });

  it('excludes cancelled delegations', () => {
    const substep = pendingDelegationSubstep('1', '1|', 'tok');
    const cancelled: SubstepState = {
      ...substep,
      delegation: { ...substep.delegation!, cancelledAt: '2026-01-02T00:00:00.000Z' },
    };
    const state = makeRunbookState('1|', [cancelled]);

    expect(deriveDelegateFrontier(state)).toEqual([]);
  });

  it('excludes delegations with no recoverable token', () => {
    const state = makeRunbookState('1|', [pendingDelegationSubstep('1', '1|', undefined)]);

    expect(deriveDelegateFrontier(state)).toEqual([]);
  });

  it('falls back to the derived active frame when activeFrameKey is absent', () => {
    const state: RunbookState = {
      ...makeRunbookState('1|', [pendingDelegationSubstep('1', '1|', 'tok')]),
      activeFrameKey: undefined,
    };

    expect(deriveDelegateFrontier(state)).toEqual([
      { id: '1.1', runbook: 'child.runbook.md', token: 'tok' },
    ]);
  });
});

describe('isPostDelegateAggregationCursor', () => {
  function doneSubstep(id: string): SubstepState {
    return { id, frameKey: buildFrameKey('1'), status: 'done', result: 'pass' };
  }

  /** Steps: 1 = DELEGATE (substeps 1.1/1.2), 2 = plain, 3 = plain. */
  function buildSteps(): ResolvedStep[] {
    return [
      makeStepWithSubsteps('1', [
        makeSubstep({ id: '1', description: 'A', runbooks: ['child.runbook.md'], delegate: true }),
        makeSubstep({ id: '2', description: 'B', runbooks: ['child.runbook.md'], delegate: true }),
      ]),
      {
        kind: 'base',
        name: '2',
        description: 'Plain 2',
        transitions: DEFAULT_TRANSITIONS,
      },
      {
        kind: 'base',
        name: '3',
        description: 'Plain 3',
        transitions: DEFAULT_TRANSITIONS,
      },
    ];
  }

  it('returns true when the predecessor is an aggregated DELEGATE step', () => {
    const state = makeState({
      step: '2',
      substepStates: [doneSubstep('1'), doneSubstep('2')],
    });
    expect(isPostDelegateAggregationCursor(state, buildSteps())).toBe(true);
  });

  it('returns false on a step whose predecessor is an ordinary step', () => {
    // Cursor on step 3; predecessor (step 2) is not a DELEGATE step, even though
    // an earlier step delegated and its substeps are done.
    const state = makeState({
      step: '3',
      substepStates: [doneSubstep('1'), doneSubstep('2')],
    });
    expect(isPostDelegateAggregationCursor(state, buildSteps())).toBe(false);
  });

  it('returns false on the first step (no predecessor)', () => {
    const state = makeState({ step: '1', substepStates: [] });
    expect(isPostDelegateAggregationCursor(state, buildSteps())).toBe(false);
  });

  it('returns false when the predecessor DELEGATE step has not aggregated', () => {
    // Predecessor is a DELEGATE step but its substeps are not yet all done.
    const state = makeState({
      step: '2',
      substepStates: [doneSubstep('1')],
    });
    expect(isPostDelegateAggregationCursor(state, buildSteps())).toBe(false);
  });

  it('returns false when the cursor step is absent from the runbook', () => {
    const state = makeState({ step: '99', substepStates: [doneSubstep('1'), doneSubstep('2')] });
    expect(isPostDelegateAggregationCursor(state, buildSteps())).toBe(false);
  });
});
