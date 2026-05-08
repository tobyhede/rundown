import { describe, expect, it } from '@jest/globals';
import { resolveCurrentExecutionUnit } from '../../src/runbook/execution-units.js';
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
