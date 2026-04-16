// packages/cli/__tests__/helpers/execution-units.test.ts

import type { StepVariables } from '../../src/services/execution-vars.js';
import {
  isSubstep,
  mergeExecutionTemplateVars,
  shouldPersistParentOutputs,
} from '../../src/helpers/execution-units.js';
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

describe('mergeExecutionTemplateVars', () => {
  // The execution frame (`before`) carries values that only exist during
  // execution: FOR-loop iteration values, Step/Index frame, INPUTS injection.
  // Persisted state (`after`) may contain stale CLI `--var` values that must
  // not overwrite these computed values when OUTPUTS are evaluated.
  it('lets the execution frame win when a key is defined on both sides', () => {
    const before: StepVariables = { item: 'iter-value', Step: '1' };
    const after: StepVariables = { item: 'stale-cli', environment: 'prod' };

    const merged = mergeExecutionTemplateVars(before, after);

    expect(merged).toEqual({ item: 'iter-value', Step: '1', environment: 'prod' });
  });

  it('retains post-transition keys that the execution frame does not carry', () => {
    const before: StepVariables = { Step: '2' };
    const after: StepVariables = { environment: 'staging', region: 'us-east-1' };

    const merged = mergeExecutionTemplateVars(before, after);

    expect(merged).toEqual({ Step: '2', environment: 'staging', region: 'us-east-1' });
  });

  it('returns undefined when neither side is defined', () => {
    expect(mergeExecutionTemplateVars(undefined, undefined)).toBeUndefined();
  });

  it('returns before when only before is defined', () => {
    const before: StepVariables = { Step: '1', item: 'x' };
    expect(mergeExecutionTemplateVars(before, undefined)).toEqual(before);
  });

  it('returns after when only after is defined', () => {
    const after: StepVariables = { environment: 'staging' };
    expect(mergeExecutionTemplateVars(undefined, after)).toEqual(after);
  });

  it('does not mutate either input', () => {
    const before: StepVariables = { item: 'iter-value' };
    const after: StepVariables = { item: 'stale', other: 'keep' };
    const beforeCopy = { ...before };
    const afterCopy = { ...after };

    mergeExecutionTemplateVars(before, after);

    expect(before).toEqual(beforeCopy);
    expect(after).toEqual(afterCopy);
  });
});
