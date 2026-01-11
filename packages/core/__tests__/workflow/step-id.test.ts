import { describe, it, expect } from '@jest/globals';
import { parseStepIdFromString, stepIdToString, stepIdEquals } from '../../src/workflow/step-id.js';

describe('parseStepIdFromString', () => {
  it('parses step only', () => {
    expect(parseStepIdFromString('3')).toEqual({ step: '3', substep: undefined });
  });

  it('parses step with substep', () => {
    expect(parseStepIdFromString('2.1')).toEqual({ step: '2', substep: '1' });
  });

  it('rejects substep 0 (1-indexed)', () => {
    expect(parseStepIdFromString('3.0')).toBeNull();
  });

  it('rejects step 0', () => {
    expect(parseStepIdFromString('0')).toBeNull();
    expect(parseStepIdFromString('0.1')).toBeNull();
  });

  it('rejects negative numbers', () => {
    expect(parseStepIdFromString('-1')).toBeNull();
  });
});

describe('stepIdToString', () => {
  it('formats step only', () => {
    expect(stepIdToString({ step: '3' })).toBe('3');
  });

  it('formats step with substep', () => {
    expect(stepIdToString({ step: '2', substep: '1' })).toBe('2.1');
  });

  it('formats dynamic step with substep', () => {
    expect(stepIdToString({ step: '{N}', substep: '1' })).toBe('{N}.1');
  });

  it('formats dynamic step with dynamic substep', () => {
    expect(stepIdToString({ step: '{N}', substep: '{n}' })).toBe('{N}.{n}');
  });
});

describe('stepIdEquals', () => {
  it('returns true for equal positions', () => {
    expect(stepIdEquals(
      { step: '2', substep: '1' },
      { step: '2', substep: '1' }
    )).toBe(true);
  });

  it('returns false for different steps', () => {
    expect(stepIdEquals(
      { step: '2', substep: '1' },
      { step: '3', substep: '1' }
    )).toBe(false);
  });

  it('returns false for different substeps', () => {
    expect(stepIdEquals(
      { step: '2', substep: '1' },
      { step: '2', substep: '2' }
    )).toBe(false);
  });

  it('returns false when one has substep and other does not', () => {
    expect(stepIdEquals(
      { step: '2', substep: '1' },
      { step: '2' }
    )).toBe(false);
  });

  it('returns true for equal dynamic references', () => {
    expect(stepIdEquals(
      { step: '{N}', substep: '1' },
      { step: '{N}', substep: '1' }
    )).toBe(true);
  });

  it('returns false for different dynamic substeps', () => {
    expect(stepIdEquals(
      { step: '{N}', substep: '1' },
      { step: '{N}', substep: '2' }
    )).toBe(false);
  });

  it('returns false for dynamic vs numeric step', () => {
    expect(stepIdEquals(
      { step: '{N}', substep: '1' },
      { step: '1', substep: '1' }
    )).toBe(false);
  });
});

describe('dynamic substep references', () => {
  it('parses {N}.1 as dynamic step with static substep', () => {
    const result = parseStepIdFromString('{N}.1');
    expect(result).toEqual({ step: '{N}', substep: '1' });
  });

  it('parses {N}.{n} as fully dynamic reference', () => {
    const result = parseStepIdFromString('{N}.{n}');
    expect(result).toEqual({ step: '{N}', substep: '{n}' });
  });

  it('rejects {N} alone (use NEXT action instead)', () => {
    const result = parseStepIdFromString('{N}');
    expect(result).toBeNull();
  });

  it('rejects {N}.0 (substeps are 1-indexed)', () => {
    const result = parseStepIdFromString('{N}.0');
    expect(result).toBeNull();
  });
});

describe('NEXT target', () => {
  it('parses NEXT as valid target', () => {
    const result = parseStepIdFromString('NEXT');
    expect(result).toEqual({ step: 'NEXT' });
  });

  it('rejects NEXT with substep notation', () => {
    const result = parseStepIdFromString('NEXT.1');
    expect(result).toBeNull();
  });
});
