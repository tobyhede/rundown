import { describe, it, expect } from '@jest/globals';
import {
  parseStepIdFromString,
  stepIdToString,
  stepIdEquals,
  isReservedWord,
  NAMED_IDENTIFIER_PATTERN,
} from '../src/step-id.js';

// === Batch 5: step-id.ts mutation-killing tests ===

describe('isReservedWord mutation killing', () => {
  it('rejects BREAK as identifier', () => {
    expect(isReservedWord('BREAK')).toBe(true);
  });

  it('rejects DEFER as identifier', () => {
    expect(isReservedWord('DEFER')).toBe(true);
  });

  it('rejects FOR as identifier', () => {
    expect(isReservedWord('FOR')).toBe(true);
  });

  it('rejects IN as identifier', () => {
    expect(isReservedWord('IN')).toBe(true);
  });

  it('rejects AT as identifier', () => {
    expect(isReservedWord('AT')).toBe(true);
  });

  it('rejects TO as identifier', () => {
    expect(isReservedWord('TO')).toBe(true);
  });

  it('accepts non-reserved word', () => {
    expect(isReservedWord('Deploy')).toBe(false);
  });

  it('is case-sensitive (lowercase not reserved)', () => {
    expect(isReservedWord('next')).toBe(false);
    expect(isReservedWord('break')).toBe(false);
  });
});

describe('NAMED_IDENTIFIER_PATTERN', () => {
  it('matches letter-starting identifier', () => {
    expect(NAMED_IDENTIFIER_PATTERN.test('Deploy')).toBe(true);
  });

  it('matches underscore-starting identifier', () => {
    expect(NAMED_IDENTIFIER_PATTERN.test('_private')).toBe(true);
  });

  it('rejects digit-starting string', () => {
    expect(NAMED_IDENTIFIER_PATTERN.test('1abc')).toBe(false);
  });

  it('rejects string with hyphens', () => {
    expect(NAMED_IDENTIFIER_PATTERN.test('my-step')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(NAMED_IDENTIFIER_PATTERN.test('')).toBe(false);
  });

  it('rejects string with spaces', () => {
    expect(NAMED_IDENTIFIER_PATTERN.test('my step')).toBe(false);
  });
});

describe('parseStepIdFromString AT clause mutation killing', () => {
  it('trims spaces around AT value', () => {
    const result = parseStepIdFromString('3 AT 5');
    expect(result).toEqual({ step: '3', at: 5 });
  });

  it('rejects AT with zero', () => {
    expect(parseStepIdFromString('3 AT 0')).toBeNull();
  });

  it('rejects AT with negative number', () => {
    expect(parseStepIdFromString('3 AT -1')).toBeNull();
  });

  it('rejects AT with NaN', () => {
    expect(parseStepIdFromString('3 AT abc')).toBeNull();
  });

  it('accepts AT with template variable', () => {
    expect(parseStepIdFromString('3 AT {{Index}}')).toEqual({ step: '3', at: '{{Index}}' });
  });

  it('accepts AT with template having spaces', () => {
    expect(parseStepIdFromString('3 AT {{ Index }}')).toEqual({ step: '3', at: '{{ Index }}' });
  });

  it('rejects AT with single-brace template', () => {
    expect(parseStepIdFromString('3 AT {Index}')).toBeNull();
  });

  // --- Mutation-killing: AT value trim, strict integer equality, template regex anchors ---

  it('trims trailing space from AT value', () => {
    expect(parseStepIdFromString('3 AT  5 ')).toEqual({ step: '3', at: 5 });
  });

  it('trims spaces from step before AT', () => {
    expect(parseStepIdFromString('  3  AT 5')).toEqual({ step: '3', at: 5 });
  });

  it('rejects AT with leading-zero integer', () => {
    expect(parseStepIdFromString('3 AT 01')).toBeNull();
  });

  it('rejects AT with template trailing text', () => {
    expect(parseStepIdFromString('3 AT {{var}}x')).toBeNull();
  });

  it('rejects AT with template leading text', () => {
    expect(parseStepIdFromString('3 AT x{{var}}')).toBeNull();
  });

  it('no at property when AT absent (numeric)', () => {
    const result = parseStepIdFromString('1.2');
    expect(result).not.toHaveProperty('at');
  });

  it('no at property when AT absent (named)', () => {
    const result = parseStepIdFromString('deploy');
    expect(result).not.toHaveProperty('at');
  });
});

// Equivalent mutants: The NEXT/{N} early-exit block is purely an optimization.
// All ~15 Stryker mutants here are equivalent because:
// - '{N}', '{N}.1' start with '{' — no later pattern matches → final null return
// - 'NEXT', 'NEXT.1' match the named pattern but isReservedWord('NEXT') rejects → null
// - '{n}' contains invalid chars — no pattern matches → final null return
// Removing or mutating the early-exit produces the same result via downstream logic.
describe('parseStepIdFromString NEXT/{N} detection mutation killing', () => {
  it('rejects NEXT as step', () => {
    expect(parseStepIdFromString('NEXT')).toBeNull();
  });

  it('rejects NEXT.1 as step.substep', () => {
    expect(parseStepIdFromString('NEXT.1')).toBeNull();
  });

  it('rejects NEXT.Substep', () => {
    expect(parseStepIdFromString('NEXT.Substep')).toBeNull();
  });

  it('rejects {N} as step', () => {
    expect(parseStepIdFromString('{N}')).toBeNull();
  });

  it('rejects {N}.1 as step.substep', () => {
    expect(parseStepIdFromString('{N}.1')).toBeNull();
  });

  it('accepts NEXTX as named step (not a prefix match)', () => {
    // "NEXTX" is not "NEXT" or "NEXT.", so it should parse as a named step
    // But wait - NEXTX doesn't start with NEXT. - and NEXTX !== NEXT, so it goes to named pattern
    expect(parseStepIdFromString('NEXTX')).toEqual({ step: 'NEXTX' });
  });

  it('rejects {n} anywhere in input', () => {
    expect(parseStepIdFromString('{n}')).toBeNull();
    expect(parseStepIdFromString('1.{n}')).toBeNull();
  });
});

describe('parseStepIdFromString three-part step ID mutation killing', () => {
  it('parses 1.2.3 correctly', () => {
    expect(parseStepIdFromString('1.2.3')).toEqual({ step: '1', substep: '3', at: 2 });
  });

  it('parses 1.2.setup as named substep', () => {
    expect(parseStepIdFromString('1.2.setup')).toEqual({ step: '1', substep: 'setup', at: 2 });
  });

  it('rejects three-level with trailing content (no requireSeparator)', () => {
    expect(parseStepIdFromString('1.2.3 extra')).toBeNull();
  });

  it('accepts three-level with trailing content (requireSeparator)', () => {
    expect(parseStepIdFromString('1.2.3 Desc', { requireSeparator: true })).toEqual({
      step: '1',
      substep: '3',
      at: 2,
    });
  });

  it('rejects three-level step=0', () => {
    expect(parseStepIdFromString('0.1.1')).toBeNull();
  });

  it('rejects three-level iteration=0', () => {
    expect(parseStepIdFromString('1.0.1')).toBeNull();
  });

  it('rejects three-level substep=0', () => {
    expect(parseStepIdFromString('1.2.0')).toBeNull();
  });

  it('rejects three-level reserved word substep CONTINUE', () => {
    expect(parseStepIdFromString('1.2.CONTINUE')).toBeNull();
  });

  it('rejects three-level reserved word substep BREAK', () => {
    expect(parseStepIdFromString('1.2.BREAK')).toBeNull();
  });

  it('rejects three-level with AT suffix (contradictory)', () => {
    expect(parseStepIdFromString('1.2.3 AT 5')).toBeNull();
  });

  // --- Mutation-killing: threeLevelPattern requireSeparator branch ---

  it('three-part rejects leading non-digit (requireSep)', () => {
    expect(parseStepIdFromString('x1.2.3 Desc', { requireSeparator: true })).toBeNull();
  });

  it('three-part multi-digit step (requireSep)', () => {
    expect(parseStepIdFromString('12.2.3 Desc', { requireSeparator: true })).toEqual({
      step: '12',
      substep: '3',
      at: 2,
    });
  });

  it('three-part multi-digit iteration (requireSep)', () => {
    expect(parseStepIdFromString('1.23.4 Desc', { requireSeparator: true })).toEqual({
      step: '1',
      substep: '4',
      at: 23,
    });
  });

  it('three-part multi-digit substep (requireSep)', () => {
    expect(parseStepIdFromString('1.2.34 Desc', { requireSeparator: true })).toEqual({
      step: '1',
      substep: '34',
      at: 2,
    });
  });

  it('three-part named substep (requireSep)', () => {
    expect(parseStepIdFromString('1.2.setup Desc', { requireSeparator: true })).toEqual({
      step: '1',
      substep: 'setup',
      at: 2,
    });
  });

  // --- Mutation-killing: threeLevelPattern exact-match branch ---

  it('three-part rejects leading content (no requireSep)', () => {
    expect(parseStepIdFromString('x1.2.3')).toBeNull();
  });

  it('three-part multi-digit step', () => {
    expect(parseStepIdFromString('12.2.3')).toEqual({ step: '12', substep: '3', at: 2 });
  });

  it('three-part multi-digit iteration', () => {
    expect(parseStepIdFromString('1.23.4')).toEqual({ step: '1', substep: '4', at: 23 });
  });

  it('three-part multi-digit substep', () => {
    expect(parseStepIdFromString('1.2.34')).toEqual({ step: '1', substep: '34', at: 2 });
  });
});

// Equivalent mutants in reserved-word and numeric-substep validation:
// - Removing ^/$ anchors from /^\d+$/ is equivalent (captured values are already constrained by
//   the capture group regex)
// - Replacing && with || on `substep && X` is equivalent (substep from capture is always truthy)
// - Removing NAMED_IDENTIFIER_PATTERN.test(substep) guard before isReservedWord(substep) is
//   equivalent (all reserved words pass the pattern test)
describe('parseStepIdFromString reserved word substep checks mutation killing', () => {
  it('rejects 1.BREAK', () => {
    expect(parseStepIdFromString('1.BREAK')).toBeNull();
  });

  it('rejects 1.FOR', () => {
    expect(parseStepIdFromString('1.FOR')).toBeNull();
  });

  it('rejects 1.DEFER', () => {
    expect(parseStepIdFromString('1.DEFER')).toBeNull();
  });

  it('rejects 1.IN', () => {
    expect(parseStepIdFromString('1.IN')).toBeNull();
  });

  it('rejects 1.AT', () => {
    expect(parseStepIdFromString('1.AT')).toBeNull();
  });

  it('rejects 1.TO', () => {
    expect(parseStepIdFromString('1.TO')).toBeNull();
  });

  it('rejects deploy.DEFER (named step)', () => {
    expect(parseStepIdFromString('deploy.DEFER')).toBeNull();
  });

  it('rejects deploy.BREAK (named step)', () => {
    expect(parseStepIdFromString('deploy.BREAK')).toBeNull();
  });

  it('rejects deploy.FOR (named step)', () => {
    expect(parseStepIdFromString('deploy.FOR')).toBeNull();
  });

  it('rejects deploy.CONTINUE (named step)', () => {
    expect(parseStepIdFromString('deploy.CONTINUE')).toBeNull();
  });

  it('rejects deploy.STOP (named step)', () => {
    expect(parseStepIdFromString('deploy.STOP')).toBeNull();
  });

  it('rejects deploy.COMPLETE (named step)', () => {
    expect(parseStepIdFromString('deploy.COMPLETE')).toBeNull();
  });

  it('rejects ErrorHandler.STOP', () => {
    expect(parseStepIdFromString('ErrorHandler.STOP')).toBeNull();
  });

  it('accepts valid non-reserved substep on numeric step', () => {
    expect(parseStepIdFromString('1.Cleanup')).toEqual({ step: '1', substep: 'Cleanup' });
  });

  it('rejects 1.0 (substep 0 invalid)', () => {
    expect(parseStepIdFromString('1.0')).toBeNull();
  });

  // --- Mutation-killing: \d+ → \d on /^\d+$/ in three-part, numeric, and named sections ---

  it('rejects multi-digit zero substep (3-part)', () => {
    expect(parseStepIdFromString('1.2.00')).toBeNull();
  });

  it('rejects multi-digit zero substep (numeric)', () => {
    expect(parseStepIdFromString('1.00')).toBeNull();
  });

  it('rejects multi-digit zero substep (named)', () => {
    expect(parseStepIdFromString('deploy.00')).toBeNull();
  });

  it('rejects leading-zero numeric step target', () => {
    expect(parseStepIdFromString('01')).toBeNull();
  });

  it('rejects leading-zero numeric step in substep target', () => {
    expect(parseStepIdFromString('01.2')).toBeNull();
  });

  it('rejects leading-zero iteration in three-part shorthand', () => {
    expect(parseStepIdFromString('1.02.3')).toBeNull();
  });
});

describe('parseStepIdFromString two-part step ID mutation killing', () => {
  it('parses 1.setup as named substep', () => {
    expect(parseStepIdFromString('1.setup')).toEqual({ step: '1', substep: 'setup' });
  });

  it('rejects 1.2 with trailing content (no requireSeparator)', () => {
    expect(parseStepIdFromString('1.2 extra')).toBeNull();
  });

  it('rejects 1. (nothing after dot)', () => {
    expect(parseStepIdFromString('1.')).toBeNull();
  });

  it('parses step with substep and AT', () => {
    expect(parseStepIdFromString('1.2 AT 3')).toEqual({ step: '1', substep: '2', at: 3 });
  });

  // --- Mutation-killing: numericPattern requireSeparator branch ---

  it('two-part rejects leading non-digit (requireSep)', () => {
    expect(parseStepIdFromString('x1 Desc', { requireSeparator: true })).toBeNull();
  });

  it('two-part multi-digit step (requireSep)', () => {
    expect(parseStepIdFromString('12 Desc', { requireSeparator: true })).toEqual({ step: '12' });
  });

  it('two-part multi-digit substep (requireSep)', () => {
    expect(parseStepIdFromString('1.23 Desc', { requireSeparator: true })).toEqual({
      step: '1',
      substep: '23',
    });
  });

  it('two-part step-only with separator (requireSep)', () => {
    expect(parseStepIdFromString('1 Desc', { requireSeparator: true })).toEqual({ step: '1' });
  });
});

describe('parseStepIdFromString named step pattern mutation killing', () => {
  it('parses deploy.1 as named step with numeric substep', () => {
    expect(parseStepIdFromString('deploy.1')).toEqual({ step: 'deploy', substep: '1' });
  });

  it('parses deploy.setup as named step with named substep', () => {
    expect(parseStepIdFromString('deploy.setup')).toEqual({ step: 'deploy', substep: 'setup' });
  });

  it('parses deploy without substep', () => {
    expect(parseStepIdFromString('deploy')).toEqual({ step: 'deploy' });
  });

  it('parses named step with AT', () => {
    expect(parseStepIdFromString('deploy AT 3')).toEqual({ step: 'deploy', at: 3 });
  });

  it('parses named step.substep with AT', () => {
    expect(parseStepIdFromString('deploy.1 AT 3')).toEqual({ step: 'deploy', substep: '1', at: 3 });
  });

  it('rejects empty input', () => {
    expect(parseStepIdFromString('')).toBeNull();
  });

  it('rejects quoted input', () => {
    expect(parseStepIdFromString('"deploy"')).toBeNull();
  });

  it('rejects reserved word as named step', () => {
    expect(parseStepIdFromString('GOTO')).toBeNull();
    expect(parseStepIdFromString('COMPLETE')).toBeNull();
    expect(parseStepIdFromString('STOP')).toBeNull();
  });

  it('rejects named step.0 (substep 0)', () => {
    expect(parseStepIdFromString('deploy.0')).toBeNull();
  });

  // --- Mutation-killing: \d+ → \d in namedPattern regex ---

  it('multi-digit numeric substep', () => {
    expect(parseStepIdFromString('deploy.12')).toEqual({ step: 'deploy', substep: '12' });
  });
});

describe('stepIdToString mutation killing', () => {
  it('formats step without substep or AT', () => {
    expect(stepIdToString({ step: '1' })).toBe('1');
  });

  it('formats step with substep', () => {
    expect(stepIdToString({ step: '1', substep: '2' })).toBe('1.2');
  });

  it('formats step with AT', () => {
    expect(stepIdToString({ step: '3', at: 1 })).toBe('3 AT 1');
  });

  it('formats step with substep and AT', () => {
    expect(stepIdToString({ step: '3', substep: '1', at: 2 })).toBe('3.1 AT 2');
  });

  it('formats named step', () => {
    expect(stepIdToString({ step: 'deploy' })).toBe('deploy');
  });

  it('formats named step with named substep', () => {
    expect(stepIdToString({ step: 'deploy', substep: 'setup' })).toBe('deploy.setup');
  });

  it('does not add substep when substep is undefined', () => {
    expect(stepIdToString({ step: '1', substep: undefined })).toBe('1');
  });

  it('does not add AT when at is undefined', () => {
    expect(stepIdToString({ step: '1', at: undefined })).toBe('1');
  });
});

describe('stepIdEquals mutation killing', () => {
  it('returns true for identical step-only', () => {
    expect(stepIdEquals({ step: '1' }, { step: '1' })).toBe(true);
  });

  it('returns false for different step', () => {
    expect(stepIdEquals({ step: '1' }, { step: '2' })).toBe(false);
  });

  it('returns true for identical step+substep', () => {
    expect(stepIdEquals({ step: '1', substep: '2' }, { step: '1', substep: '2' })).toBe(true);
  });

  it('returns false for different substep', () => {
    expect(stepIdEquals({ step: '1', substep: '1' }, { step: '1', substep: '2' })).toBe(false);
  });

  it('returns false when one has substep, other does not', () => {
    expect(stepIdEquals({ step: '1', substep: '2' }, { step: '1' })).toBe(false);
  });

  it('returns true for identical AT values', () => {
    expect(stepIdEquals({ step: '3', at: 1 }, { step: '3', at: 1 })).toBe(true);
  });

  it('returns false for different AT values', () => {
    expect(stepIdEquals({ step: '3', at: 1 }, { step: '3', at: 2 })).toBe(false);
  });

  it('returns false when one has AT, other does not', () => {
    expect(stepIdEquals({ step: '3', at: 1 }, { step: '3' })).toBe(false);
  });
});
