import { describe, expect, it } from '@jest/globals';
import fc from 'fast-check';
import type { ResolvedStep, Substep, Transitions } from '@rundown-org/parser';

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

function makeSubstep(index: number, delegate: boolean): Substep {
  const substepNumber = String(index + 1);

  return {
    id: substepNumber,
    description: `Substep ${substepNumber}`,
    transitions: DEFAULT_TRANSITIONS,
    runbooks: [`child-${substepNumber}.runbook.md`],
    ...(delegate ? { delegate: true as const } : {}),
  };
}

function makeSteps(flags: readonly boolean[]): readonly ResolvedStep[] {
  return [
    {
      kind: 'substeps',
      name: '1',
      description: 'Parent',
      transitions: DEFAULT_TRANSITIONS,
      substeps: flags.map((delegate, index) => makeSubstep(index, delegate)),
    },
  ];
}

describe('manual delegation inference properties', () => {
  it('never selects runbook-list substeps that are not marked DELEGATE', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }), (flags) => {
        const firstDelegatedIndex = flags.findIndex(Boolean);
        const steps = makeSteps(flags);

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
});
