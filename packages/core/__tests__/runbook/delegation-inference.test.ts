import { describe, expect, it } from '@jest/globals';
import type {
  ResolvedStep,
  ResolvedStepWithSubsteps,
  Substep,
  Transitions,
} from '@rundown-org/parser';

import {
  buildFrameKey,
  inferAllDelegateSubsteps,
  inferDelegationTarget,
  inferRunbookFromStep,
  type DelegationInferenceState,
  type StepDelegation,
  type SubstepState,
} from '../../src/runbook/index.js';
import { brandEffectiveVarsForTest, brandRunIdForTest } from '../../src/testing/effective-vars.js';
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
      expect.objectContaining({ code: 'RD-813' }),
    );
  });
});
