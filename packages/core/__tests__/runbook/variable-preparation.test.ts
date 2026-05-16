import { describe, expect, it } from '@jest/globals';
import {
  RESERVED_TEMPLATE_HELPER_NAMES,
  detectTemplateHelperCollisions,
} from '../../src/runbook/index.js';

describe('template helper semantics', () => {
  it('reserves artifact-producing built-in helper names', () => {
    expect(RESERVED_TEMPLATE_HELPER_NAMES.has('path')).toBe(true);
    expect(RESERVED_TEMPLATE_HELPER_NAMES.has('artifact')).toBe(true);
  });

  it('detects user variable names shadowed by registered helpers', () => {
    const registry = new Map<string, (value: string) => string>([
      ['upper', (value) => value.toUpperCase()],
      ['slug', (value) => value.toLowerCase()],
    ]);

    expect(detectTemplateHelperCollisions(registry, { upper: 'value', env: 'prod' })).toEqual([
      'upper',
    ]);
  });
});
