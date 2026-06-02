import { describe, expect, it } from '@jest/globals';
import fc from 'fast-check';
import type {
  ResolvedStep,
  ResolvedStepWithSubsteps,
  Substep,
  Transitions,
} from '@rundown-org/parser';

import { inferDelegationTarget, type DelegationInferenceState } from '../../src/runbook/index.js';
import { brandRunIdForTest } from '../../src/testing/effective-vars.js';

const DEFAULT_TRANSITIONS: Transitions = {
  pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
  fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
};

function makeState(): DelegationInferenceState {
  return {
    id: brandRunIdForTest(`rd_${'1'.repeat(32)}`),
    step: '1',
  };
}

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

function makeRunbookListSubstep(index: number, delegate: boolean): Substep {
  const substepNumber = String(index + 1);

  return makeSubstep({
    id: substepNumber,
    description: `Substep ${substepNumber}`,
    runbooks: [`child-${substepNumber}.runbook.md`],
    ...(delegate ? { delegate: true as const } : {}),
  });
}

function makeRunbookListSteps(flags: readonly boolean[]): readonly ResolvedStep[] {
  return [
    makeStepWithSubsteps(
      '1',
      flags.map((delegate, index) => makeRunbookListSubstep(index, delegate)),
    ),
  ];
}

describe('delegation inference invariants', () => {
  it('never selects runbook-list substeps that are not marked DELEGATE', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }), (flags) => {
        const firstDelegatedIndex = flags.findIndex(Boolean);
        const steps = makeRunbookListSteps(flags);

        if (firstDelegatedIndex === -1) {
          expect(() => inferDelegationTarget(makeState(), steps)).toThrow(
            expect.objectContaining({ code: 'RD-813' }),
          );
          return;
        }

        const result = inferDelegationTarget(makeState(), steps);
        const firstDelegatedStepNumber = String(firstDelegatedIndex + 1);

        expect(result).toEqual({
          runbookRef: `child-${firstDelegatedStepNumber}.runbook.md`,
          stepId: `1.${firstDelegatedStepNumber}`,
        });
      }),
    );
  });

  it('throws RD-814 for any DELEGATE substep missing a runbook reference', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z][A-Za-z0-9 _-]{0,20}$/),
        fc.option(fc.string({ minLength: 1, maxLength: 80 }), { nil: undefined }),
        (description, prompt) => {
          const steps: ResolvedStep[] = [
            makeStepWithSubsteps('1', [
              makeSubstep({
                id: '1',
                description,
                delegate: true,
                prompt,
              }),
            ]),
          ];

          expect(() => inferDelegationTarget(makeState(), steps)).toThrow(
            expect.objectContaining({ code: 'RD-814' }),
          );
        },
      ),
    );
  });
});
