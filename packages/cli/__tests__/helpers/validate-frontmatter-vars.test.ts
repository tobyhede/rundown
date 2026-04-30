import { describe, it, expect } from '@jest/globals';
import {
  validateFrontmatterVars,
  validateRequiredVars,
  validateOutputsDeclarations,
} from '../../src/helpers/validate-frontmatter-vars.js';

describe('validateFrontmatterVars', () => {
  it('returns empty array for undefined vars', () => {
    expect(validateFrontmatterVars(undefined)).toEqual([]);
  });

  it('returns empty array for non-reserved vars', () => {
    expect(validateFrontmatterVars({ PlanPath: 'value', Region: 'us-west' })).toEqual([]);
  });

  it('returns error for reserved runtime names', () => {
    const result = validateFrontmatterVars({ Step: '1', Context: 'ctx' });
    expect(result).toHaveLength(2);
    expect(result[0].severity).toBe('error');
    expect(result[0].message).toContain('"Step"');
    expect(result[1].message).toContain('"Context"');
  });

  it('returns error for reserved runtime names case-insensitively', () => {
    const result = validateFrontmatterVars({ sTeP: '1', cOnTeXt: 'ctx' });
    expect(result).toHaveLength(2);
    expect(result.every((diagnostic) => diagnostic.severity === 'error')).toBe(true);
    expect(result.map((diagnostic) => diagnostic.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('"sTeP"'),
        expect.stringContaining('"cOnTeXt"'),
      ]),
    );
  });
});

describe('validateRequiredVars', () => {
  it('returns empty array for undefined required list', () => {
    expect(validateRequiredVars(undefined, undefined)).toEqual([]);
  });

  it('returns error for duplicate required names', () => {
    const result = validateRequiredVars(['PlanPath', 'PlanPath'], undefined);
    expect(result).toHaveLength(1);
    expect(result[0].message).toContain('Duplicate entry "PlanPath"');
  });

  it('returns error for poisoned or invalid identifiers', () => {
    const result = validateRequiredVars(['__proto__', 'bad-name'], undefined);
    expect(result).toHaveLength(2);
    expect(result[0].message).toContain('not a valid identifier');
    expect(result[1].message).toContain('not a valid identifier');
  });

  it('returns error for reserved names and vars overlap', () => {
    const result = validateRequiredVars(['Step', 'PlanPath'], { PlanPath: 'value' });
    expect(result).toHaveLength(2);
    expect(result).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('reserved runtime variable'),
      }),
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('cannot be both in "required" and "vars"'),
      }),
    ]);
  });
});

describe('validateOutputsDeclarations', () => {
  it('returns empty array for undefined outputs', () => {
    expect(validateOutputsDeclarations(undefined)).toEqual([]);
  });

  it('returns empty array for empty outputs array', () => {
    expect(validateOutputsDeclarations([])).toEqual([]);
  });

  it('returns empty for valid unique output names', () => {
    const result = validateOutputsDeclarations([
      { name: 'PlanPath' },
      { name: 'ResultFile', value: '{{ path "result.json" }}' },
    ]);
    expect(result).toEqual([]);
  });

  it('returns error for duplicate output names', () => {
    const result = validateOutputsDeclarations([{ name: 'PlanPath' }, { name: 'PlanPath' }]);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('error');
    expect(result[0].message).toContain('"PlanPath"');
    expect(result[0].message.toLowerCase()).toContain('duplicate');
  });

  it('returns error for reserved runtime names', () => {
    const result = validateOutputsDeclarations([{ name: 'Step' }]);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('error');
    expect(result[0].message).toContain('"Step"');
    expect(result[0].message).toContain('reserved');
  });

  it('returns error for reserved names case-insensitively', () => {
    const result = validateOutputsDeclarations([{ name: 'INDEX' }]);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('error');
    expect(result[0].message).toContain('"INDEX"');
    expect(result[0].message).toContain('reserved');
  });

  it('reports both reserved error and duplicate error when same reserved name repeated', () => {
    const result = validateOutputsDeclarations([{ name: 'Step' }, { name: 'Step' }]);
    expect(result).toHaveLength(2);
    const messages = result.map((d) => d.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining('reserved'),
        expect.stringContaining('Duplicate'),
      ]),
    );
  });
});
