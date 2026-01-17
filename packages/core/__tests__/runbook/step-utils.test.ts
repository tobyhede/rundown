import { describe, it, expect } from '@jest/globals';
import { isNumberedStepName, countNumberedSteps } from '../../src/runbook/step-utils.js';

describe('isNumberedStepName', () => {
  it('returns true for single digit', () => {
    expect(isNumberedStepName('1')).toBe(true);
  });

  it('returns true for multi-digit numbers', () => {
    expect(isNumberedStepName('10')).toBe(true);
    expect(isNumberedStepName('999')).toBe(true);
  });

  it('returns false for named steps', () => {
    expect(isNumberedStepName('RECOVER')).toBe(false);
    expect(isNumberedStepName('CLEANUP')).toBe(false);
    expect(isNumberedStepName('ErrorHandler')).toBe(false);
  });

  it('returns false for dynamic step placeholders', () => {
    expect(isNumberedStepName('{N}')).toBe(false);
    expect(isNumberedStepName('{n}')).toBe(false);
  });

  it('returns false for mixed alphanumeric', () => {
    expect(isNumberedStepName('step1')).toBe(false);
    expect(isNumberedStepName('1step')).toBe(false);
    expect(isNumberedStepName('1.1')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isNumberedStepName('')).toBe(false);
  });
});

describe('countNumberedSteps', () => {
  it('counts numbered steps only', () => {
    const steps = [
      { name: '1', isDynamic: false },
      { name: '2', isDynamic: false },
      { name: '3', isDynamic: false },
      { name: 'RECOVER', isDynamic: false },
    ];
    expect(countNumberedSteps(steps)).toBe(3);
  });

  it('includes dynamic steps in count', () => {
    const steps = [
      { name: '{N}', isDynamic: true },
    ];
    expect(countNumberedSteps(steps)).toBe(1);
  });

  it('counts mixed numbered, named, and dynamic steps correctly', () => {
    const steps = [
      { name: '1', isDynamic: false },
      { name: '2', isDynamic: false },
      { name: 'RECOVERY', isDynamic: false },
      { name: '3', isDynamic: false },
      { name: 'CLEANUP', isDynamic: false },
    ];
    expect(countNumberedSteps(steps)).toBe(3);
  });

  it('returns 0 for only named steps', () => {
    const steps = [
      { name: 'SETUP', isDynamic: false },
      { name: 'CLEANUP', isDynamic: false },
    ];
    expect(countNumberedSteps(steps)).toBe(0);
  });

  it('returns 0 for empty array', () => {
    expect(countNumberedSteps([])).toBe(0);
  });

  it('handles readonly arrays', () => {
    const steps = [
      { name: '1', isDynamic: false },
      { name: '2', isDynamic: false },
    ] as const;
    expect(countNumberedSteps(steps)).toBe(2);
  });
});
