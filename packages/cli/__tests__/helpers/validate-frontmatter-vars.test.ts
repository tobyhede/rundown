import { describe, it, expect } from '@jest/globals';
import { validateOutputsDeclarations } from '../../src/helpers/validate-frontmatter-vars.js';

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
