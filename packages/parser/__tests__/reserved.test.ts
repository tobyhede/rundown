import { describe, expect, it } from '@jest/globals';
import {
  BUILTIN_TEMPLATE_HELPER_NAMES,
  BUILTIN_TEMPLATE_HELPER_NAME_SET,
  isBuiltinTemplateHelperName,
} from '../src/reserved.js';

describe('built-in template helper names', () => {
  it('contains exactly the built-in render helper names', () => {
    expect([...BUILTIN_TEMPLATE_HELPER_NAMES]).toEqual(['artifact', 'path', 'validateSchema']);
    expect([...BUILTIN_TEMPLATE_HELPER_NAME_SET].sort()).toEqual([
      'artifact',
      'path',
      'validateSchema',
    ]);
  });

  it('is case-sensitive', () => {
    expect(isBuiltinTemplateHelperName('artifact')).toBe(true);
    expect(isBuiltinTemplateHelperName('path')).toBe(true);
    expect(isBuiltinTemplateHelperName('validateSchema')).toBe(true);
    expect(isBuiltinTemplateHelperName('Artifact')).toBe(false);
    expect(isBuiltinTemplateHelperName('validateschema')).toBe(false); // cspell:disable-line
    expect(isBuiltinTemplateHelperName('upper')).toBe(false);
  });
});
