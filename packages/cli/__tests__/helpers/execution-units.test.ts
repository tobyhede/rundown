import { describe, it, expect } from '@jest/globals';
import { resolveCurrentExecutionUnit } from '../../src/helpers/execution-units.js';
import { buildBaseStep, buildStepWithSubsteps, buildSubstep } from './test-utils.js';

describe('resolveCurrentExecutionUnit', () => {
  it('returns the parent step when no substep is active', () => {
    const step = buildBaseStep({ name: '1', description: 'parent' });
    expect(resolveCurrentExecutionUnit(step, undefined)).toBe(step);
  });

  it('returns the active substep when the id exists', () => {
    const substep = buildSubstep({ id: 'b', description: 'child' });
    const step = buildStepWithSubsteps([buildSubstep({ id: 'a', description: 'first' }), substep], {
      name: '1',
      description: 'parent',
    });
    expect(resolveCurrentExecutionUnit(step, 'b')).toBe(substep);
  });

  it('falls back to the parent step when the substep id is stale', () => {
    const step = buildStepWithSubsteps([buildSubstep({ id: 'a', description: 'first' })], {
      name: '1',
      description: 'parent',
    });
    expect(resolveCurrentExecutionUnit(step, 'missing')).toBe(step);
  });
});
