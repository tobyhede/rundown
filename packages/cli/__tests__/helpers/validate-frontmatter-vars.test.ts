import {
  validateFrontmatterVars,
  validateInputsDeclarations,
  validateRequiredVars,
} from '../../src/helpers/validate-frontmatter-vars.js';

describe('validateFrontmatterVars', () => {
  it('returns empty array for undefined vars', () => {
    expect(validateFrontmatterVars(undefined)).toEqual([]);
  });

  it('returns empty array for empty vars', () => {
    expect(validateFrontmatterVars({})).toEqual([]);
  });

  it('returns empty array for non-reserved vars', () => {
    expect(validateFrontmatterVars({ name: 'test', port: 3000 })).toEqual([]);
  });

  it('returns error for Step (case-insensitive)', () => {
    const result = validateFrontmatterVars({ Step: 'custom' });
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('error');
    expect(result[0].message).toContain('"Step"');
    expect(result[0].message).toContain('reserved');
  });

  it('returns error for index (lowercase)', () => {
    const result = validateFrontmatterVars({ index: 5 });
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('error');
    expect(result[0].message).toContain('"index"');
  });

  it('returns error for CONTEXT (uppercase)', () => {
    const result = validateFrontmatterVars({ CONTEXT: 'value' });
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('error');
    expect(result[0].message).toContain('"CONTEXT"');
  });

  it('returns multiple errors for multiple reserved vars', () => {
    const result = validateFrontmatterVars({ Step: 'a', Index: 'b', Context: 'c' });
    expect(result).toHaveLength(3);
    expect(result.every((d) => d.severity === 'error')).toBe(true);
  });

  it('allows built-in overridable vars (Date, Year, WorkPath)', () => {
    const result = validateFrontmatterVars({
      Date: '2025-01-01',
      Year: '2025',
      WorkPath: '.artifacts',
    });
    expect(result).toEqual([]);
  });

  it('returns errors only for reserved vars in a mixed set', () => {
    const result = validateFrontmatterVars({
      name: 'test',
      Step: 'custom',
      port: 3000,
      Index: 5,
    });
    expect(result).toHaveLength(2);
    const messages = result.map((d) => d.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining('"Step"'),
        expect.stringContaining('"Index"'),
      ]),
    );
  });

  it('diagnostics have no line field', () => {
    const result = validateFrontmatterVars({ Step: 'custom' });
    expect(result[0]).not.toHaveProperty('line');
  });
});

describe('validateInputsDeclarations', () => {
  it('returns empty for undefined inputs', () => {
    expect(validateInputsDeclarations(undefined, undefined)).toEqual([]);
  });

  it('returns empty for empty inputs array', () => {
    expect(validateInputsDeclarations([], undefined)).toEqual([]);
  });

  it('returns empty for valid inputs with no overlap', () => {
    expect(validateInputsDeclarations(['PlanPath'], { port: 3000 })).toEqual([]);
  });

  it('returns empty for valid inputs with no vars', () => {
    expect(validateInputsDeclarations(['PlanPath', 'Target'], undefined)).toEqual([]);
  });

  it('returns error when input name appears in vars (conflict)', () => {
    const result = validateInputsDeclarations(['PlanPath'], { PlanPath: '' });
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('error');
    expect(result[0].message).toContain('"PlanPath"');
    expect(result[0].message).toContain('inputs');
    expect(result[0].message).toContain('vars');
  });

  it('returns error for reserved runtime names', () => {
    const result = validateInputsDeclarations(['Step'], undefined);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('error');
    expect(result[0].message).toContain('"Step"');
    expect(result[0].message).toContain('reserved');
  });

  it('returns error for reserved names case-insensitively', () => {
    const result = validateInputsDeclarations(['INDEX'], undefined);
    expect(result).toHaveLength(1);
    expect(result[0].message).toContain('"INDEX"');
  });

  it('returns error for invalid identifiers', () => {
    const result = validateInputsDeclarations(['123invalid'], undefined);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('error');
    expect(result[0].message).toContain('not a valid identifier');
  });

  it('skips overlap check for invalid identifiers', () => {
    // Invalid identifier gets only the invalid-id error, not also an overlap error
    const result = validateInputsDeclarations(['123bad'], { '123bad': 'val' });
    expect(result).toHaveLength(1);
    expect(result[0].message).toContain('not a valid identifier');
  });

  it('returns multiple errors for multiple violations', () => {
    const result = validateInputsDeclarations(['Step', 'PlanPath', '123bad'], { PlanPath: '' });
    expect(result).toHaveLength(3); // reserved + overlap + invalid
  });

  it('diagnostics have no line field', () => {
    const result = validateInputsDeclarations(['Step'], undefined);
    expect(result[0]).not.toHaveProperty('line');
  });
});

describe('validateRequiredVars', () => {
  it('returns empty for undefined required', () => {
    expect(validateRequiredVars(undefined, undefined)).toEqual([]);
  });

  it('returns empty for empty required array', () => {
    expect(validateRequiredVars([], undefined)).toEqual([]);
  });

  it('returns empty for valid required with no overlap', () => {
    expect(validateRequiredVars(['PlanPath'], { port: 3000 })).toEqual([]);
  });

  it('returns empty for valid required with no vars', () => {
    expect(validateRequiredVars(['PlanPath', 'Target'], undefined)).toEqual([]);
  });

  it('returns error when name appears in both required and vars', () => {
    const result = validateRequiredVars(['PlanPath'], { PlanPath: '' });
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('error');
    expect(result[0].message).toContain('"PlanPath"');
    expect(result[0].message).toContain('required');
    expect(result[0].message).toContain('vars');
  });

  it('returns error for reserved runtime names', () => {
    const result = validateRequiredVars(['Step'], undefined);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('error');
    expect(result[0].message).toContain('"Step"');
    expect(result[0].message).toContain('reserved');
  });

  it('returns error for reserved names case-insensitively', () => {
    const result = validateRequiredVars(['INDEX'], undefined);
    expect(result).toHaveLength(1);
    expect(result[0].message).toContain('"INDEX"');
  });

  it('returns error for invalid identifiers', () => {
    const result = validateRequiredVars(['123invalid'], undefined);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('error');
    expect(result[0].message).toContain('not a valid identifier');
  });

  it('returns multiple errors for multiple violations', () => {
    const result = validateRequiredVars(['Step', 'PlanPath', '123bad'], { PlanPath: '' });
    expect(result).toHaveLength(3); // reserved + overlap + invalid
  });

  it('skips overlap check for invalid identifiers', () => {
    // Invalid identifier gets only the invalid-id error, not also an overlap error
    const result = validateRequiredVars(['123bad'], { '123bad': 'val' });
    expect(result).toHaveLength(1);
    expect(result[0].message).toContain('not a valid identifier');
  });

  it('returns error for duplicate entries', () => {
    const result = validateRequiredVars(['PlanPath', 'PlanPath'], undefined);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('error');
    expect(result[0].message).toContain('Duplicate');
    expect(result[0].message).toContain('"PlanPath"');
  });

  it('skips further validation for duplicate entries', () => {
    // Second occurrence only gets the duplicate error, not also overlap/reserved
    const result = validateRequiredVars(['PlanPath', 'PlanPath'], { PlanPath: '' });
    // First: overlap error. Second: duplicate error.
    expect(result).toHaveLength(2);
    expect(result[0].message).toContain('cannot be both');
    expect(result[1].message).toContain('Duplicate');
  });
});
