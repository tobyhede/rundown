// packages/cli/__tests__/helpers/execution-units.test.ts

import type { ResolvedStep, Substep } from '@rundown-org/core';
import { isSubstep } from '../../src/helpers/execution-units.js';

describe('isSubstep', () => {
  it('returns true for a substep-shaped value (has id, no kind)', () => {
    const substep = {
      id: '1',
      description: 'child',
      transitions: { pass: { type: 'CONTINUE' }, fail: { type: 'STOP' } },
    } as unknown as Substep;
    expect(isSubstep(substep)).toBe(true);
  });

  it('returns false for a base step (has kind)', () => {
    const step = {
      kind: 'base',
      name: '1',
      description: 'parent',
      transitions: { pass: { type: 'CONTINUE' }, fail: { type: 'STOP' } },
    } as unknown as ResolvedStep;
    expect(isSubstep(step)).toBe(false);
  });

  it('returns false for a step with substeps', () => {
    const step = {
      kind: 'substeps',
      name: '1',
      description: 'parent',
      substeps: [],
      transitions: { pass: { type: 'CONTINUE' }, fail: { type: 'STOP' } },
    } as unknown as ResolvedStep;
    expect(isSubstep(step)).toBe(false);
  });
});
