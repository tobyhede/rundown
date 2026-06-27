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
  findPendingDelegation,
  inferAllDelegateSubsteps,
  inferDelegationTarget,
  inferRunbookFromStep,
  isPostDelegateAggregationCursor,
  resolveDelegateTarget,
  resolveTargetedDelegation,
  type DelegationInferenceState,
  type FrameKey,
  type RequestedRunbookArg,
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

function makeActiveDelegation(overrides: Partial<StepDelegation> = {}): StepDelegation {
  return {
    token: 'rdtk_aaa',
    tokenHash: assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`),
    childRunbookPath: 'child.runbook.md',
    childRunbookRef: { source: 'project', path: 'child.runbook.md' },
    contextSnapshot: { vars: brandEffectiveVarsForTest({}), ancestors: [] },
    childRunId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    cancelledAt: null,
    ...overrides,
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

  it('returns false when delegate substeps are done only across DIFFERENT frames', () => {
    // No single frame fully aggregated: substep 1 reached `done` in FOR
    // iteration frame `1|1`, substep 2 reached `done` in iteration frame `1|2`.
    // A frame-agnostic existence check would falsely treat this as an
    // aggregated predecessor; frame-scoped matching must reject it so that a
    // bare `rd collect` here correctly surfaces as misuse (NOT_DELEGATE_STEP).
    const state = makeState({
      step: '2',
      substepStates: [
        { id: '1', frameKey: buildFrameKey('1', 1), status: 'done', result: 'pass' },
        { id: '2', frameKey: buildFrameKey('1', 2), status: 'done', result: 'pass' },
      ],
    });
    expect(isPostDelegateAggregationCursor(state, buildSteps())).toBe(false);
  });

  it('returns true when a single FOR-iteration frame fully aggregated', () => {
    // Both delegate substeps reached `done` within the same iteration frame
    // `1|2`; a noise record for substep 1 lingers in frame `1|1`. A single
    // frame fully aggregated, so the cursor is post-aggregation.
    const state = makeState({
      step: '2',
      substepStates: [
        { id: '1', frameKey: buildFrameKey('1', 1), status: 'done', result: 'pass' },
        { id: '1', frameKey: buildFrameKey('1', 2), status: 'done', result: 'pass' },
        { id: '2', frameKey: buildFrameKey('1', 2), status: 'done', result: 'pass' },
      ],
    });
    expect(isPostDelegateAggregationCursor(state, buildSteps())).toBe(true);
  });

  it('returns false when done records belong to a different step reusing substep ids', () => {
    // Substeps `1` and `2` are `done` only in frames belonging to step `2`
    // (frameKey `2|`), not the predecessor DELEGATE step `1`. Matching scoped
    // to the predecessor's frames must reject this cross-step coincidence.
    const state = makeState({
      step: '2',
      substepStates: [
        { id: '1', frameKey: buildFrameKey('2'), status: 'done', result: 'pass' },
        { id: '2', frameKey: buildFrameKey('2'), status: 'done', result: 'pass' },
      ],
    });
    expect(isPostDelegateAggregationCursor(state, buildSteps())).toBe(false);
  });

  it('returns false when aggregation advanced via GOTO to a non-adjacent step', () => {
    // The DELEGATE step `1` fully aggregated (both substeps `done` in its base
    // frame), but the cursor jumped to step `3` via an explicit GOTO rather than
    // advancing transparently to the adjacent successor (step `2`). The cursor's
    // document-order predecessor is the unrelated ordinary step `2`, not the
    // aggregated DELEGATE step, so a bare `rd collect` here is misuse — the
    // function must NOT mask it as an idempotent post-aggregation no-op.
    // (See the TSDoc: a GOTO aggregation that jumps elsewhere is not treated as
    // an idempotent successor.)
    const state = makeState({
      step: '3',
      substepStates: [doneSubstep('1'), doneSubstep('2')],
    });
    expect(isPostDelegateAggregationCursor(state, buildSteps())).toBe(false);
  });

  it('returns true (frame-agnostic .some) when one frame aggregated and another is still pending', () => {
    // A FOR-loop DELEGATE predecessor: iteration frame `1|1` fully aggregated
    // (both delegate substeps `done`), while iteration frame `1|2` still has a
    // `pending` substep. The function uses `.some()` over candidate frames, so a
    // single fully-aggregated frame is sufficient evidence — the lingering
    // pending frame does not veto. Pins this documented frame-agnostic semantic
    // so a future `.some()`->`.every()` change is caught.
    const state = makeState({
      step: '2',
      substepStates: [
        { id: '1', frameKey: buildFrameKey('1', 1), status: 'done', result: 'pass' },
        { id: '2', frameKey: buildFrameKey('1', 1), status: 'done', result: 'pass' },
        { id: '1', frameKey: buildFrameKey('1', 2), status: 'done', result: 'pass' },
        { id: '2', frameKey: buildFrameKey('1', 2), status: 'pending' },
      ],
    });
    expect(isPostDelegateAggregationCursor(state, buildSteps())).toBe(true);
  });
});

describe('findPendingDelegation', () => {
  const frameKey = buildFrameKey('1');

  // Canonical "pending, tokened, matching" fixture; each negative case below
  // flips exactly ONE dimension so an AND->OR predicate mutant cannot survive.
  function stateWithDelegation(overrides: Partial<StepDelegation> = {}): DelegationInferenceState {
    const substepStates: SubstepState[] = [
      { id: '1', frameKey, status: 'pending', delegation: makeActiveDelegation(overrides) },
    ];
    return makeState({ step: '1', activeFrameKey: frameKey, substepStates });
  }

  it('returns the delegation for a pending, unclaimed, non-cancelled, tokened substep', () => {
    const result = findPendingDelegation(stateWithDelegation(), '1.1', frameKey);
    expect(result?.token).toBe('rdtk_aaa');
  });

  it('returns undefined when the step id has no substep segment', () => {
    expect(findPendingDelegation(stateWithDelegation(), '1', frameKey)).toBeUndefined();
  });

  it('returns undefined when only the substep id differs', () => {
    expect(findPendingDelegation(stateWithDelegation(), '1.2', frameKey)).toBeUndefined();
  });

  it('returns undefined when only the frame key differs', () => {
    expect(
      findPendingDelegation(stateWithDelegation(), '1.1', buildFrameKey('1', 2)),
    ).toBeUndefined();
  });

  it('returns undefined when only cancelledAt is set', () => {
    expect(
      findPendingDelegation(
        stateWithDelegation({ cancelledAt: '2026-01-02T00:00:00.000Z' }),
        '1.1',
        frameKey,
      ),
    ).toBeUndefined();
  });

  it('returns undefined when only childRunId is set (claimed)', () => {
    expect(
      findPendingDelegation(
        stateWithDelegation({ childRunId: brandRunIdForTest(`rd_${'2'.repeat(32)}`) }),
        '1.1',
        frameKey,
      ),
    ).toBeUndefined();
  });

  it('returns undefined when only the token is absent', () => {
    expect(
      findPendingDelegation(stateWithDelegation({ token: undefined }), '1.1', frameKey),
    ).toBeUndefined();
  });

  it('returns undefined when the matching substep has no delegation record', () => {
    const substepStates: SubstepState[] = [{ id: '1', frameKey, status: 'pending' }];
    const state = makeState({ step: '1', activeFrameKey: frameKey, substepStates });
    expect(findPendingDelegation(state, '1.1', frameKey)).toBeUndefined();
  });

  it('returns undefined when the substep is already done', () => {
    // Mirrors resolveDelegateTarget's isSubstepDone guard: a completed substep
    // must not be treated as carrying an in-flight delegation, even if a
    // (stale) pending delegation record lingers on it.
    const substepStates: SubstepState[] = [
      { id: '1', frameKey, status: 'done', result: 'pass', delegation: makeActiveDelegation() },
    ];
    const state = makeState({ step: '1', activeFrameKey: frameKey, substepStates });
    expect(findPendingDelegation(state, '1.1', frameKey)).toBeUndefined();
  });

  it('returns undefined when the frame key does not belong to the parsed step', () => {
    // Substep ids collide across steps (every step has a `1`). A request for
    // step 2's substep (`2.1`) must not match step 1's substep `1.1` just
    // because they share substep id `1` and the caller passed step 1's frame
    // (the CLI derives the frame from the *current* step). Without this guard,
    // `rd delegate --step 2.1` while positioned on step 1 would echo step 1.1's
    // token mislabeled as 2.1.
    const substepStates: SubstepState[] = [
      { id: '1', frameKey, status: 'pending', delegation: makeActiveDelegation() },
    ];
    const state = makeState({ step: '1', activeFrameKey: frameKey, substepStates });
    expect(findPendingDelegation(state, '2.1', frameKey)).toBeUndefined();
  });
});

describe('resolveTargetedDelegation', () => {
  const frameKey = buildFrameKey('1');

  function stateWithDelegation(overrides: Partial<StepDelegation> = {}): DelegationInferenceState {
    const substepStates: SubstepState[] = [
      { id: '1', frameKey, status: 'pending', delegation: makeActiveDelegation(overrides) },
    ];
    return makeState({ step: '1', activeFrameKey: frameKey, substepStates });
  }

  const noneRequested: RequestedRunbookArg = { kind: 'none' };

  it('echoes the existing token for a bare targeted request with an in-flight delegation', () => {
    const result = resolveTargetedDelegation(stateWithDelegation(), '1.1', frameKey, noneRequested);
    expect(result).toEqual({
      kind: 'echo',
      stepId: '1.1',
      token: 'rdtk_aaa',
      runbookRef: 'child.runbook.md',
    });
  });

  it('echoes when the requested runbook matches the in-flight runbook', () => {
    const requested: RequestedRunbookArg = {
      kind: 'resolved',
      ref: { source: 'project', path: 'child.runbook.md' },
      raw: 'child.runbook.md',
    };
    const result = resolveTargetedDelegation(stateWithDelegation(), '1.1', frameKey, requested);
    expect(result).toMatchObject({ kind: 'echo', token: 'rdtk_aaa' });
  });

  it('conflicts (RD-804) when the requested runbook differs from the in-flight runbook', () => {
    const requested: RequestedRunbookArg = {
      kind: 'resolved',
      ref: { source: 'project', path: 'child-b.runbook.md' },
      raw: 'child-b.runbook.md',
    };
    const result = resolveTargetedDelegation(stateWithDelegation(), '1.1', frameKey, requested);
    expect(result.kind).toBe('conflict');
    if (result.kind !== 'conflict') throw new Error('expected conflict');
    expect(result.error.code).toBe('RD-804');
    const message = result.error.message;
    expect(message).toContain('child-b.runbook.md');
    expect(message).toContain('child.runbook.md');
    expect(message).toContain('sha256:');
    expect(message).not.toContain('rdtk_');
  });

  it('conflicts (RD-804) when the requested runbook is unresolvable but a delegation is in flight', () => {
    const requested: RequestedRunbookArg = { kind: 'unresolvable', raw: 'made-up.runbook.md' };
    const result = resolveTargetedDelegation(stateWithDelegation(), '1.1', frameKey, requested);
    expect(result.kind).toBe('conflict');
    if (result.kind !== 'conflict') throw new Error('expected conflict');
    expect(result.error.code).toBe('RD-804');
    expect(result.error.message).not.toContain('rdtk_');
  });

  it('is issuable when no in-flight delegation exists, regardless of requested arg', () => {
    const empty = makeState({ step: '1', activeFrameKey: frameKey, substepStates: [] });
    expect(resolveTargetedDelegation(empty, '1.1', frameKey, noneRequested)).toEqual({
      kind: 'issuable',
    });
    const requested: RequestedRunbookArg = {
      kind: 'resolved',
      ref: { source: 'project', path: 'child.runbook.md' },
      raw: 'child.runbook.md',
    };
    expect(resolveTargetedDelegation(empty, '1.1', frameKey, requested)).toEqual({
      kind: 'issuable',
    });
  });
});
