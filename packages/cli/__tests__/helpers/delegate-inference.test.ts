import { describe, it, expect } from '@jest/globals';
import type { Step, Substep, StepWithSubsteps } from '@rundown-org/parser';
import type { RunbookState, SubstepState, StepDelegation } from '@rundown-org/core';
import {
  inferDelegationTarget,
  inferRunbookFromStep,
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
