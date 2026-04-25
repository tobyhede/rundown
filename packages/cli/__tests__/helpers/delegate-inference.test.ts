import { describe, it, expect } from '@jest/globals';
import type {
  ResolvedStep,
  ResolvedStepWithFor,
  ResolvedStepWithSubsteps,
  Substep,
  Transitions,
} from '@rundown-org/parser';
import type { RunbookState, SubstepState, StepDelegation } from '@rundown-org/core';
import {
  inferDelegationTarget,
  inferRunbookFromStep,
  inferAllDelegateSubsteps,
} from '../../src/helpers/delegate-inference.js';
import {
  brandEffectiveVarsForTest,
  brandFrameKeyForTest,
  brandStoredOutputsForTest,
} from './brand-helpers.js';

/** Canonical transitions pair used across fixtures to avoid `as any` casts. */
const DEFAULT_TRANSITIONS: Transitions = {
  pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
  fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
};

/** Build a minimal substep for testing. */
function makeSubstep(overrides: Partial<Substep> & { id: string; description: string }): Substep {
  return { transitions: DEFAULT_TRANSITIONS, ...overrides };
}

/** Build a minimal step with substeps. */
function makeStepWithSubsteps(name: string, substeps: Substep[]): ResolvedStepWithSubsteps {
  return {
    kind: 'substeps' as const,
    name,
    description: `Step ${name}`,
    transitions: DEFAULT_TRANSITIONS,
    substeps,
  };
}

/** Build a minimal RunbookState for testing. */
function makeState(overrides: Partial<RunbookState> = {}): RunbookState {
  return {
    id: 'test-run-id',
    runbook: 'test.runbook.md',
    runbookPath: 'test.runbook.md',
    step: '1',
    stepName: 'Step 1',
    retryCount: 0,
    variables: brandStoredOutputsForTest(),
    steps: [],
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Build a delegation that is active (not cancelled). */
function makeActiveDelegation(): StepDelegation {
  return {
    tokenHash: 'sha256:abc',
    childRunbookPath: 'child.runbook.md',
    contextSnapshot: { vars: brandEffectiveVarsForTest(), ancestors: [] },
    childRunId: null,
    createdAt: new Date().toISOString(),
    cancelledAt: null,
  };
}

/** Build a minimal FOR-type step with substeps. */
function makeStepWithFor(
  name: string,
  substeps: Substep[],
  range: { start: number; end: number },
): ResolvedStepWithFor {
  return {
    kind: 'for' as const,
    name,
    description: `Step ${name}`,
    substeps,
    transitions: DEFAULT_TRANSITIONS,
    forClause: { start: range.start, end: range.end },
  };
}

describe('inferDelegationTarget', () => {
  it('returns first pending substep with runbook reference', () => {
    const substeps = [
      makeSubstep({ id: '1', description: 'First', runbooks: ['child.runbook.md'] }),
      makeSubstep({ id: '2', description: 'Second', runbooks: ['other.runbook.md'] }),
    ];
    const steps: ResolvedStep[] = [makeStepWithSubsteps('1', substeps)];
    const state = makeState({ step: '1' });

    const result = inferDelegationTarget(state, steps);

    expect(result).toEqual({ runbookRef: 'child.runbook.md', stepId: '1.1' });
  });

  it('skips substeps that are already delegated', () => {
    const substeps = [
      makeSubstep({ id: '1', description: 'First', runbooks: ['child.runbook.md'] }),
      makeSubstep({ id: '2', description: 'Second', runbooks: ['other.runbook.md'] }),
    ];
    const steps: ResolvedStep[] = [makeStepWithSubsteps('1', substeps)];
    const substepStates: SubstepState[] = [
      { id: '1', frameKey: brandFrameKeyForTest('1'), status: 'pending', delegation: makeActiveDelegation() },
      { id: '2', frameKey: brandFrameKeyForTest('1'), status: 'pending' },
    ];
    const state = makeState({ step: '1', substepStates });

    const result = inferDelegationTarget(state, steps);

    expect(result).toEqual({ runbookRef: 'other.runbook.md', stepId: '1.2' });
  });

  it('skips substeps that are done', () => {
    const substeps = [
      makeSubstep({ id: '1', description: 'First', runbooks: ['child.runbook.md'] }),
      makeSubstep({ id: '2', description: 'Second', runbooks: ['other.runbook.md'] }),
    ];
    const steps: ResolvedStep[] = [makeStepWithSubsteps('1', substeps)];
    const substepStates: SubstepState[] = [
      { id: '1', frameKey: brandFrameKeyForTest('1'), status: 'done', result: 'pass' },
      { id: '2', frameKey: brandFrameKeyForTest('1'), status: 'pending' },
    ];
    const state = makeState({ step: '1', substepStates });

    const result = inferDelegationTarget(state, steps);

    expect(result).toEqual({ runbookRef: 'other.runbook.md', stepId: '1.2' });
  });

  it('throws RD-813 when no substep has a runbook reference', () => {
    const substeps = [
      makeSubstep({ id: '1', description: 'First' }),
      makeSubstep({ id: '2', description: 'Second' }),
    ];
    const steps: ResolvedStep[] = [makeStepWithSubsteps('1', substeps)];
    const state = makeState({ step: '1' });

    expect(() => inferDelegationTarget(state, steps)).toThrow(
      expect.objectContaining({ code: 'RD-813' }),
    );
  });

  it('throws RD-813 when all delegatable substeps are already delegated', () => {
    const substeps = [
      makeSubstep({ id: '1', description: 'First', runbooks: ['child.runbook.md'] }),
    ];
    const steps: ResolvedStep[] = [makeStepWithSubsteps('1', substeps)];
    const substepStates: SubstepState[] = [
      { id: '1', frameKey: brandFrameKeyForTest('1'), status: 'pending', delegation: makeActiveDelegation() },
    ];
    const state = makeState({ step: '1', substepStates });

    expect(() => inferDelegationTarget(state, steps)).toThrow(
      expect.objectContaining({ code: 'RD-813' }),
    );
  });

  it('throws RD-813 when step has no substeps', () => {
    const steps: ResolvedStep[] = [
      {
        kind: 'base' as const,
        name: '1',
        description: 'Base step',
        transitions: DEFAULT_TRANSITIONS,
      },
    ];
    const state = makeState({ step: '1' });

    expect(() => inferDelegationTarget(state, steps)).toThrow(
      expect.objectContaining({ code: 'RD-813' }),
    );
  });

  it('infers delegation target from prompted-for step', () => {
    const substeps = [
      makeSubstep({ id: '1', description: 'Handle item', runbooks: ['child.runbook.md'] }),
    ];
    const steps: ResolvedStep[] = [
      {
        kind: 'prompted-for' as const,
        name: '1',
        description: 'Process items',
        prompt: 'FOR item IN 1 TO {{N}}',
        transitions: DEFAULT_TRANSITIONS,
        substeps,
      },
    ];
    const state = makeState({ step: '1' });

    const result = inferDelegationTarget(state, steps);

    expect(result).toEqual({ runbookRef: 'child.runbook.md', stepId: '1.1' });
  });

  it('finds next delegatable substep in FOR loop iteration 2 when iteration 1 has active delegation', () => {
    const substeps = [
      makeSubstep({ id: '1', description: 'First', runbooks: ['child.runbook.md'] }),
    ];
    const steps: ResolvedStep[] = [makeStepWithSubsteps('1', substeps)];
    const substepStates: SubstepState[] = [
      { id: '1', frameKey: brandFrameKeyForTest('1', 1), status: 'pending', delegation: makeActiveDelegation() },
      { id: '1', frameKey: brandFrameKeyForTest('1', 2), status: 'pending' },
    ];
    const state = makeState({
      step: '1',
      substepStates,
      activeFrameKey: brandFrameKeyForTest('1', 2),
      forStack: [
        {
          stepId: '1',
          iteration: 2,
          start: 1,
          end: 3,
          implicit: false,
          source: { kind: 'range' as const },
        },
      ],
    });

    const result = inferDelegationTarget(state, steps);

    expect(result).toEqual({ runbookRef: 'child.runbook.md', stepId: '1.1' });
  });
});

describe('inferAllDelegateSubsteps', () => {
  it('returns all unresolved substeps with delegate: true and runbooks', () => {
    const substeps = [
      makeSubstep({ id: '1', description: 'A', runbooks: ['a.runbook.md'], delegate: true }),
      makeSubstep({ id: '2', description: 'B', runbooks: ['b.runbook.md'], delegate: true }),
      makeSubstep({ id: '3', description: 'C', runbooks: ['c.runbook.md'] }), // no delegate
    ];
    const steps: ResolvedStep[] = [makeStepWithSubsteps('1', substeps)];
    const state = makeState({ step: '1' });

    const result = inferAllDelegateSubsteps(state, steps);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ runbookRef: 'a.runbook.md', stepId: '1.1' });
    expect(result[1]).toEqual({ runbookRef: 'b.runbook.md', stepId: '1.2' });
  });

  it('skips substeps that are already delegated', () => {
    const substeps = [
      makeSubstep({ id: '1', description: 'A', runbooks: ['a.runbook.md'], delegate: true }),
      makeSubstep({ id: '2', description: 'B', runbooks: ['b.runbook.md'], delegate: true }),
    ];
    const steps: ResolvedStep[] = [makeStepWithSubsteps('1', substeps)];
    const substepStates: SubstepState[] = [
      { id: '1', frameKey: brandFrameKeyForTest('1'), status: 'pending', delegation: makeActiveDelegation() },
    ];
    const state = makeState({ step: '1', substepStates });

    const result = inferAllDelegateSubsteps(state, steps);

    expect(result).toHaveLength(1);
    expect(result[0].stepId).toBe('1.2');
  });

  it('skips substeps that are done', () => {
    const substeps = [
      makeSubstep({ id: '1', description: 'A', runbooks: ['a.runbook.md'], delegate: true }),
      makeSubstep({ id: '2', description: 'B', runbooks: ['b.runbook.md'], delegate: true }),
    ];
    const steps: ResolvedStep[] = [makeStepWithSubsteps('1', substeps)];
    const substepStates: SubstepState[] = [
      { id: '1', frameKey: brandFrameKeyForTest('1'), status: 'done', result: 'pass' },
    ];
    const state = makeState({ step: '1', substepStates });

    const result = inferAllDelegateSubsteps(state, steps);

    expect(result).toHaveLength(1);
    expect(result[0].stepId).toBe('1.2');
  });

  it('throws RD-814 when a delegate substep is missing its runbook reference', () => {
    // Invariant: the parser rejects DELEGATE substeps that lack a runbook
    // (packages/parser/src/parser.ts finalizePendingSubstep). If that guard
    // is ever bypassed — e.g., programmatic step construction — inference
    // must surface a hard error rather than silently skip the substep.
    const substeps = [
      makeSubstep({ id: '1', description: 'A', delegate: true }), // no runbooks
    ];
    const steps: ResolvedStep[] = [makeStepWithSubsteps('1', substeps)];
    const state = makeState({ step: '1' });

    expect(() => inferAllDelegateSubsteps(state, steps)).toThrow(
      expect.objectContaining({ code: 'RD-814' }),
    );
  });

  it('throws RD-813 when current step has no substeps', () => {
    const steps: ResolvedStep[] = [
      {
        kind: 'base' as const,
        name: '1',
        description: 'Step',
        transitions: DEFAULT_TRANSITIONS,
      },
    ];
    const state = makeState({ step: '1' });

    expect(() => inferAllDelegateSubsteps(state, steps)).toThrow(
      expect.objectContaining({ code: 'RD-813' }),
    );
  });

  it('scopes frontier to the current FOR iteration — substeps from other iterations are excluded', () => {
    const substeps = [
      makeSubstep({ id: '1', description: 'A', runbooks: ['a.runbook.md'], delegate: true }),
      makeSubstep({ id: '2', description: 'B', runbooks: ['b.runbook.md'], delegate: true }),
    ];
    const steps: ResolvedStep[] = [makeStepWithFor('1', substeps, { start: 1, end: 3 })];

    // Iteration 1: substep 1 is done; substep 2 is pending
    const substepStatesIter1: SubstepState[] = [
      { id: '1', frameKey: brandFrameKeyForTest('1', 1), status: 'done', result: 'pass' },
    ];
    const stateIter1 = makeState({
      step: '1',
      substepStates: substepStatesIter1,
      activeFrameKey: brandFrameKeyForTest('1', 1),
      forStack: [
        {
          stepId: '1',
          iteration: 1,
          start: 1,
          end: 3,
          implicit: false,
          source: { kind: 'range' as const },
        },
      ],
    });

    const resultIter1 = inferAllDelegateSubsteps(stateIter1, steps);
    expect(resultIter1).toHaveLength(1);
    expect(resultIter1[0].stepId).toBe('1.2');

    // Iteration 2: fresh slate
    const stateIter2 = makeState({
      step: '1',
      substepStates: [],
      activeFrameKey: brandFrameKeyForTest('1', 2),
      forStack: [
        {
          stepId: '1',
          iteration: 2,
          start: 1,
          end: 3,
          implicit: false,
          source: { kind: 'range' as const },
        },
      ],
    });
    const resultIter2 = inferAllDelegateSubsteps(stateIter2, steps);
    expect(resultIter2).toHaveLength(2);
  });
});

describe('inferRunbookFromStep', () => {
  it('returns runbook reference for a valid substep', () => {
    const substeps = [
      makeSubstep({ id: '1', description: 'First', runbooks: ['child.runbook.md'] }),
    ];
    const steps: ResolvedStep[] = [makeStepWithSubsteps('1', substeps)];
    const state = makeState({ step: '1' });

    const result = inferRunbookFromStep(state, steps, '1.1');

    expect(result).toBe('child.runbook.md');
  });

  it('throws RD-814 when substep has no runbook reference', () => {
    const substeps = [makeSubstep({ id: '1', description: 'First' })];
    const steps: ResolvedStep[] = [makeStepWithSubsteps('1', substeps)];
    const state = makeState({ step: '1' });

    expect(() => inferRunbookFromStep(state, steps, '1.1')).toThrow(
      expect.objectContaining({ code: 'RD-814' }),
    );
  });
});
