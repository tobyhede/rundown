import { validateFrontmatterVars } from '../../src/helpers/validate-frontmatter-vars.js';

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
