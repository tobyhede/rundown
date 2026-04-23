import { describe, it, expect } from '@jest/globals';
import type { Step, Substep, StepWithSubsteps, StepWithFor } from '@rundown-org/parser';
import type { RunbookState, SubstepState, StepDelegation } from '@rundown-org/core';
import {
  inferDelegationTarget,
  inferRunbookFromStep,
  inferAllDelegateSubsteps,
} from '../../src/helpers/delegate-inference.js';

/** Build a minimal substep for testing. */
function makeSubstep(overrides: Partial<Substep> & { id: string; description: string }): Substep {
  return { ...overrides };
}

/** Build a minimal step with substeps. */
function makeStepWithSubsteps(name: string, substeps: Substep[]): StepWithSubsteps {
  return {
    kind: 'substeps' as const,
    name,
    description: `Step ${name}`,
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
    variables: {},
    steps: [],
    ...overrides,
  };
}

/** Build a delegation that is active (not cancelled). */
function makeActiveDelegation(): StepDelegation {
  return {
    tokenHash: 'sha256:abc',
    childRunbookPath: 'child.runbook.md',
    contextSnapshot: { vars: {}, ancestors: [] },
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
): StepWithFor {
  return {
    kind: 'for' as const,
    name,
    description: `Step ${name}`,
    substeps,
    transitions: {} as any,
    forClause: { start: range.start, end: range.end },
  };
}

describe('inferDelegationTarget', () => {
  it('returns first pending substep with runbook reference', () => {
    const substeps = [
      makeSubstep({ id: '1', description: 'First', runbooks: ['child.runbook.md'] }),
      makeSubstep({ id: '2', description: 'Second', runbooks: ['other.runbook.md'] }),
    ];
    const steps: Step[] = [makeStepWithSubsteps('1', substeps)];
    const state = makeState({ step: '1' });

    const result = inferDelegationTarget(state, steps);

    expect(result).toEqual({ runbookRef: 'child.runbook.md', stepId: '1.1' });
  });

  it('skips substeps that are already delegated', () => {
    const substeps = [
      makeSubstep({ id: '1', description: 'First', runbooks: ['child.runbook.md'] }),
      makeSubstep({ id: '2', description: 'Second', runbooks: ['other.runbook.md'] }),
    ];
    const steps: Step[] = [makeStepWithSubsteps('1', substeps)];
    const substepStates: SubstepState[] = [
      { id: '1', frameKey: '1|', status: 'pending', delegation: makeActiveDelegation() },
      { id: '2', frameKey: '1|', status: 'pending' },
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
    const steps: Step[] = [makeStepWithSubsteps('1', substeps)];
    const substepStates: SubstepState[] = [
      { id: '1', frameKey: '1|', status: 'done', result: 'pass' },
      { id: '2', frameKey: '1|', status: 'pending' },
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
    const steps: Step[] = [makeStepWithSubsteps('1', substeps)];
    const state = makeState({ step: '1' });

    expect(() => inferDelegationTarget(state, steps)).toThrow(
      expect.objectContaining({ code: 'RD-813' }),
    );
  });

  it('throws RD-813 when all delegatable substeps are already delegated', () => {
    const substeps = [
      makeSubstep({ id: '1', description: 'First', runbooks: ['child.runbook.md'] }),
    ];
    const steps: Step[] = [makeStepWithSubsteps('1', substeps)];
    const substepStates: SubstepState[] = [
      { id: '1', frameKey: '1|', status: 'pending', delegation: makeActiveDelegation() },
    ];
    const state = makeState({ step: '1', substepStates });

    expect(() => inferDelegationTarget(state, steps)).toThrow(
      expect.objectContaining({ code: 'RD-813' }),
    );
  });

  it('throws RD-813 when step has no substeps', () => {
    const steps: Step[] = [{ kind: 'base' as const, name: '1', description: 'Base step' }];
    const state = makeState({ step: '1' });

    expect(() => inferDelegationTarget(state, steps)).toThrow(
      expect.objectContaining({ code: 'RD-813' }),
    );
  });

  it('infers delegation target from prompted-for step', () => {
    const substeps = [
      makeSubstep({ id: '1', description: 'Handle item', runbooks: ['child.runbook.md'] }),
    ];
    const steps: Step[] = [
      {
        kind: 'prompted-for' as const,
        name: '1',
        description: 'Process items',
        prompt: 'FOR item IN 1 TO {{N}}',
        substeps,
        transitions: { pass: { next: 'COMPLETE' }, fail: { next: 'STOP' } },
      },
    ];
    const state = makeState({ step: '1' });

    const result = inferDelegationTarget(state, steps as any);

    expect(result).toEqual({ runbookRef: 'child.runbook.md', stepId: '1.1' });
  });

  it('finds next delegatable substep in FOR loop iteration 2 when iteration 1 has active delegation', () => {
    const substeps = [
      makeSubstep({ id: '1', description: 'First', runbooks: ['child.runbook.md'] }),
    ];
    const steps: Step[] = [makeStepWithSubsteps('1', substeps)];
    const substepStates: SubstepState[] = [
      { id: '1', frameKey: '1|1', status: 'pending', delegation: makeActiveDelegation() },
      { id: '1', frameKey: '1|2', status: 'pending' },
    ];
    const state = makeState({
      step: '1',
      substepStates,
      activeFrameKey: '1|2',
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
    const steps: Step[] = [makeStepWithSubsteps('1', substeps)];
    const state = makeState({ step: '1' });

    const result = inferAllDelegateSubsteps(state, steps as any);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ runbookRef: 'a.runbook.md', stepId: '1.1' });
    expect(result[1]).toEqual({ runbookRef: 'b.runbook.md', stepId: '1.2' });
  });

  it('skips substeps that are already delegated', () => {
    const substeps = [
      makeSubstep({ id: '1', description: 'A', runbooks: ['a.runbook.md'], delegate: true }),
      makeSubstep({ id: '2', description: 'B', runbooks: ['b.runbook.md'], delegate: true }),
    ];
    const steps: Step[] = [makeStepWithSubsteps('1', substeps)];
    const substepStates: SubstepState[] = [
      { id: '1', frameKey: '1|', status: 'pending', delegation: makeActiveDelegation() },
    ];
    const state = makeState({ step: '1', substepStates });

    const result = inferAllDelegateSubsteps(state, steps as any);

    expect(result).toHaveLength(1);
    expect(result[0].stepId).toBe('1.2');
  });

  it('skips substeps that are done', () => {
    const substeps = [
      makeSubstep({ id: '1', description: 'A', runbooks: ['a.runbook.md'], delegate: true }),
      makeSubstep({ id: '2', description: 'B', runbooks: ['b.runbook.md'], delegate: true }),
    ];
    const steps: Step[] = [makeStepWithSubsteps('1', substeps)];
    const substepStates: SubstepState[] = [
      { id: '1', frameKey: '1|', status: 'done', result: 'pass' },
    ];
    const state = makeState({ step: '1', substepStates });

    const result = inferAllDelegateSubsteps(state, steps as any);

    expect(result).toHaveLength(1);
    expect(result[0].stepId).toBe('1.2');
  });

  it('returns empty array when no delegate substeps have runbooks', () => {
    const substeps = [
      makeSubstep({ id: '1', description: 'A', delegate: true }), // no runbooks
    ];
    const steps: Step[] = [makeStepWithSubsteps('1', substeps)];
    const state = makeState({ step: '1' });

    const result = inferAllDelegateSubsteps(state, steps as any);

    expect(result).toHaveLength(0);
  });

  it('throws RD-813 when current step has no substeps', () => {
    const steps: Step[] = [{ kind: 'base' as const, name: '1', description: 'Step' } as any];
    const state = makeState({ step: '1' });

    expect(() => inferAllDelegateSubsteps(state, steps as any)).toThrow(
      expect.objectContaining({ code: 'RD-813' }),
    );
  });

  it('scopes frontier to the current FOR iteration — substeps from other iterations are excluded', () => {
    const substeps = [
      makeSubstep({ id: '1', description: 'A', runbooks: ['a.runbook.md'], delegate: true }),
      makeSubstep({ id: '2', description: 'B', runbooks: ['b.runbook.md'], delegate: true }),
    ];
    const steps: Step[] = [makeStepWithFor('1', substeps, { start: 1, end: 3 })];

    // Iteration 1: substep 1 is done; substep 2 is pending
    const substepStatesIter1: SubstepState[] = [
      { id: '1', frameKey: '1|1', status: 'done', result: 'pass' },
    ];
    const stateIter1 = makeState({
      step: '1',
      substepStates: substepStatesIter1,
      activeFrameKey: '1|1',
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

    const resultIter1 = inferAllDelegateSubsteps(stateIter1, steps as any);
    expect(resultIter1).toHaveLength(1);
    expect(resultIter1[0].stepId).toBe('1.2');

    // Iteration 2: fresh slate
    const stateIter2 = makeState({
      step: '1',
      substepStates: [],
      activeFrameKey: '1|2',
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
    const resultIter2 = inferAllDelegateSubsteps(stateIter2, steps as any);
    expect(resultIter2).toHaveLength(2);
  });
});

describe('inferRunbookFromStep', () => {
  it('returns runbook reference for a valid substep', () => {
    const substeps = [
      makeSubstep({ id: '1', description: 'First', runbooks: ['child.runbook.md'] }),
    ];
    const steps: Step[] = [makeStepWithSubsteps('1', substeps)];
    const state = makeState({ step: '1' });

    const result = inferRunbookFromStep(state, steps, '1.1');

    expect(result).toBe('child.runbook.md');
  });

  it('throws RD-814 when substep has no runbook reference', () => {
    const substeps = [makeSubstep({ id: '1', description: 'First' })];
    const steps: Step[] = [makeStepWithSubsteps('1', substeps)];
    const state = makeState({ step: '1' });

    expect(() => inferRunbookFromStep(state, steps, '1.1')).toThrow(
      expect.objectContaining({ code: 'RD-814' }),
    );
  });
});
