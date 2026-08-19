import { describe, expect, it } from '@jest/globals';
import {
  extractUnitOutputs,
  findStepOrThrow,
  resolveCurrentExecutionUnit,
} from '../../src/runbook/execution-units.js';
import type { OutputDeclaration } from '@rundown-org/parser';
import type { ResolvedStep, Substep } from '../../src/runbook/types.js';
import { makeBaseStep } from '../helpers/step-factories.js';

function makeSubstep(id: string): Substep {
  return {
    id,
    description: `Substep ${id}`,
    transitions: {
      pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
      fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
    },
  };
}

describe('findStepOrThrow', () => {
  const first = makeBaseStep({ name: '1', description: 'First' });
  const second = makeBaseStep({ name: 'RECOVER', description: 'Named step' });

  it('returns the step whose name matches the cursor', () => {
    expect(findStepOrThrow([first, second], '1')).toBe(first);
    // Named (non-numeric) steps resolve the same way — the cursor carries the
    // step's `name`, not its ordinal.
    expect(findStepOrThrow([first, second], 'RECOVER')).toBe(second);
  });

  it('refuses a cursor no step carries, naming the step it looked for', () => {
    // A run's `step` column and its compiled steps are written together, so a
    // miss means they have diverged. The message names the cursor because that
    // is the only fact distinguishing this from any other lookup failure.
    expect(() => findStepOrThrow([first, second], 'Gone')).toThrow('Step "Gone" not found');
  });

  it('refuses against an empty step list', () => {
    expect(() => findStepOrThrow([], '1')).toThrow('Step "1" not found');
  });
});

describe('resolveCurrentExecutionUnit', () => {
  it('returns the parent step when no substep id is active', () => {
    const step = makeBaseStep({ name: '1', description: 'Parent' });

    expect(resolveCurrentExecutionUnit(step, undefined)).toBe(step);
  });

  it('returns the matching substep when the active cursor references one', () => {
    const substep = makeSubstep('b');
    const step: ResolvedStep = {
      kind: 'substeps',
      name: '1',
      description: 'Parent',
      transitions: {
        pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
        fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
      },
      substeps: [makeSubstep('a'), substep],
    };

    expect(resolveCurrentExecutionUnit(step, 'b')).toBe(substep);
  });

  it('falls back to the parent step when state references a missing substep', () => {
    const step: ResolvedStep = {
      kind: 'substeps',
      name: '1',
      description: 'Parent',
      transitions: {
        pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
        fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
      },
      substeps: [makeSubstep('a')],
    };

    expect(resolveCurrentExecutionUnit(step, 'missing')).toBe(step);
  });
});

function makeOutputsSubstep(id: string, outputs?: readonly OutputDeclaration[]): Substep {
  return { ...makeSubstep(id), ...(outputs !== undefined ? { outputs } : {}) };
}

function makeSubstepsStep(
  substeps: readonly Substep[],
  stepOutputs?: readonly OutputDeclaration[],
): ResolvedStep {
  return {
    kind: 'substeps',
    name: '1',
    description: 'Parent',
    substeps,
    transitions: {
      pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
      fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
    },
    ...(stepOutputs !== undefined ? { outputs: stepOutputs } : {}),
  };
}

describe('extractUnitOutputs', () => {
  it('returns the step OUTPUTS for a step-level unit', () => {
    const outputs: readonly OutputDeclaration[] = [{ name: 'Result' }];
    expect(
      extractUnitOutputs(makeBaseStep({ name: '1', description: 'S', outputs }), undefined),
    ).toEqual(outputs);
  });

  it('returns no declarations when a step-level unit declares none', () => {
    expect(extractUnitOutputs(makeBaseStep({ name: '1', description: 'S' }), undefined)).toEqual(
      [],
    );
  });

  it('returns the substep OUTPUTS, not the parent step OUTPUTS', () => {
    const stepOutputs: readonly OutputDeclaration[] = [{ name: 'StepOut' }];
    const substepOutputs: readonly OutputDeclaration[] = [{ name: 'SubOut' }];
    const step = makeSubstepsStep([makeOutputsSubstep('1.1', substepOutputs)], stepOutputs);

    expect(extractUnitOutputs(step, '1.1')).toEqual(substepOutputs);
  });

  it('returns the parent step OUTPUTS for a step-level unit on a step that has substeps', () => {
    // A step with substeps still owns OUTPUTS of its own, and `substepId`
    // alone decides which tier is being captured — the presence of substeps
    // on the step does not route a step-level unit into the substep branch.
    const stepOutputs: readonly OutputDeclaration[] = [{ name: 'ParentOnly' }];
    const step = makeSubstepsStep([makeOutputsSubstep('1.1', [{ name: 'SubOut' }])], stepOutputs);

    expect(extractUnitOutputs(step, undefined)).toEqual(stepOutputs);
  });

  it('returns no declarations when the named substep declares none', () => {
    const step = makeSubstepsStep([makeOutputsSubstep('1.1')]);

    expect(extractUnitOutputs(step, '1.1')).toEqual([]);
  });

  it('returns no declarations when the substep id names no substep', () => {
    // Not a fallback to the parent's OUTPUTS: those belong to a different
    // channel path, so capturing them under a substep scope would misfile them.
    const step = makeSubstepsStep(
      [makeOutputsSubstep('1.1', [{ name: 'Sub' }])],
      [{ name: 'StepOut' }],
    );

    expect(extractUnitOutputs(step, '9.9')).toEqual([]);
  });

  it('returns the step OUTPUTS when a substep id is named on a step that has none', () => {
    const outputs: readonly OutputDeclaration[] = [{ name: 'StepOut' }];

    expect(
      extractUnitOutputs(makeBaseStep({ name: '1', description: 'S', outputs }), '1.1'),
    ).toEqual(outputs);
  });
});
