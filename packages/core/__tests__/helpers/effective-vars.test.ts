import { describe, expect, it } from '@jest/globals';
import { brandEffectiveVarsForTest } from './effective-vars.js';

describe('legacy effective-vars test helper import path', () => {
  it('keeps ./effective-vars.js available to sibling helper modules', () => {
    const vars = brandEffectiveVarsForTest({ Plan: 'draft' });

    expect(vars.Plan).toBe('draft');
  });
});
