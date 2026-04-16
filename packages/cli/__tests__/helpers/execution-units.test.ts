// packages/cli/__tests__/helpers/execution-units.test.ts

import { isSubstep, shouldPersistParentOutputs } from '../../src/helpers/execution-units.js';
import { buildBaseStep, buildStepWithSubsteps, buildSubstep } from './test-utils.js';

describe('isSubstep', () => {
  it('returns true for a substep-shaped value (has id, no kind)', () => {
    const substep = buildSubstep({
      id: '1',
      description: 'child',
    });
    expect(isSubstep(substep)).toBe(true);
  });

  it('returns false for a base step (has kind)', () => {
    const step = buildBaseStep({
      name: '1',
      description: 'parent',
    });
    expect(isSubstep(step)).toBe(false);
  });

  it('returns false for a step with substeps', () => {
    const step = buildStepWithSubsteps([], {
      name: '1',
      description: 'parent',
    });
    expect(isSubstep(step)).toBe(false);
  });
});

describe('shouldPersistParentOutputs', () => {
  it('always returns false when parent has no outputs', () => {
    for (const isSubstepContext of [false, true]) {
      for (const parentStepAdvanced of [false, true]) {
        for (const isTerminalAction of [false, true]) {
          expect(
            shouldPersistParentOutputs({
              isSubstepContext,
              parentStepAdvanced,
              isTerminalAction,
              parentHasOutputs: false,
            }),
          ).toBe(false);
        }
      }
    }
  });

  it('returns true when parent has outputs and PASS came directly from parent step', () => {
    // No substep context — parent OUTPUTS publish unconditionally.
    for (const parentStepAdvanced of [false, true]) {
      for (const isTerminalAction of [false, true]) {
        expect(
          shouldPersistParentOutputs({
            isSubstepContext: false,
            parentStepAdvanced,
            isTerminalAction,
            parentHasOutputs: true,
          }),
        ).toBe(true);
      }
    }
  });

  it('returns true from substep when parent step advanced (CONTINUE → next step)', () => {
    expect(
      shouldPersistParentOutputs({
        isSubstepContext: true,
        parentStepAdvanced: true,
        isTerminalAction: false,
        parentHasOutputs: true,
      }),
    ).toBe(true);
  });

  it('returns true from substep on terminal action (substep STOP/COMPLETE)', () => {
    expect(
      shouldPersistParentOutputs({
        isSubstepContext: true,
        parentStepAdvanced: false,
        isTerminalAction: true,
        parentHasOutputs: true,
      }),
    ).toBe(true);
  });

  it('returns false from substep when parent did not advance and action is non-terminal', () => {
    // e.g., substep CONTINUE that aggregates into parent DEFER —
    // parent OUTPUTS must NOT publish yet.
    expect(
      shouldPersistParentOutputs({
        isSubstepContext: true,
        parentStepAdvanced: false,
        isTerminalAction: false,
        parentHasOutputs: true,
      }),
    ).toBe(false);
  });

  // Full table-driven assertion of the documented matrix
  describe('decision matrix', () => {
    interface Row {
      isSubstepContext: boolean;
      parentStepAdvanced: boolean;
      isTerminalAction: boolean;
      parentHasOutputs: boolean;
      expected: boolean;
    }

    const matrix: readonly Row[] = [
      // parentHasOutputs: false → always false (4 rows × 4 = covered above)
      // No substep
      {
        isSubstepContext: false,
        parentStepAdvanced: false,
        isTerminalAction: false,
        parentHasOutputs: true,
        expected: true,
      },
      {
        isSubstepContext: false,
        parentStepAdvanced: true,
        isTerminalAction: false,
        parentHasOutputs: true,
        expected: true,
      },
      {
        isSubstepContext: false,
        parentStepAdvanced: false,
        isTerminalAction: true,
        parentHasOutputs: true,
        expected: true,
      },
      {
        isSubstepContext: false,
        parentStepAdvanced: true,
        isTerminalAction: true,
        parentHasOutputs: true,
        expected: true,
      },
      // Substep, parent advanced
      {
        isSubstepContext: true,
        parentStepAdvanced: true,
        isTerminalAction: false,
        parentHasOutputs: true,
        expected: true,
      },
      {
        isSubstepContext: true,
        parentStepAdvanced: true,
        isTerminalAction: true,
        parentHasOutputs: true,
        expected: true,
      },
      // Substep, parent did NOT advance, terminal action
      {
        isSubstepContext: true,
        parentStepAdvanced: false,
        isTerminalAction: true,
        parentHasOutputs: true,
        expected: true,
      },
      // Substep, parent did NOT advance, non-terminal action — only `false` row
      {
        isSubstepContext: true,
        parentStepAdvanced: false,
        isTerminalAction: false,
        parentHasOutputs: true,
        expected: false,
      },
    ];

    it.each(
      matrix,
    )('substep=$isSubstepContext, advanced=$parentStepAdvanced, terminal=$isTerminalAction, hasOutputs=$parentHasOutputs → $expected', ({
      expected,
      ...inputs
    }) => {
      expect(shouldPersistParentOutputs(inputs)).toBe(expected);
    });
  });
});
