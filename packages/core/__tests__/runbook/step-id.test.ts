import { describe, it, expect } from '@jest/globals';
import { parseStepIdFromString, stepIdToString, stepIdEquals } from '../../src/runbook/step-id.js';

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

});

describe('removed dynamic formats', () => {
  it('rejects {N} format', () => {
    expect(parseStepIdFromString('{N}')).toBeNull();
    expect(parseStepIdFromString('{N}.1')).toBeNull();
    expect(parseStepIdFromString('{N}.{n}')).toBeNull();
  });

  it('rejects NEXT format', () => {
    expect(parseStepIdFromString('NEXT')).toBeNull();
    expect(parseStepIdFromString('NEXT.1')).toBeNull();
  });

  it('rejects {n} as substep', () => {
    expect(parseStepIdFromString('1.{n}')).toBeNull();
  });
});
