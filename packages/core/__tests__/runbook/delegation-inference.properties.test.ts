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
  return {
    id: String(index + 1),
    description: `Substep ${index + 1}`,
    transitions: DEFAULT_TRANSITIONS,
    runbooks: [`child-${index + 1}.runbook.md`],
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

        expect(result).toEqual({
          runbookRef: `child-${firstDelegatedIndex + 1}.runbook.md`,
          stepId: `1.${firstDelegatedIndex + 1}`,
        });
      }),
    );
  });
});
