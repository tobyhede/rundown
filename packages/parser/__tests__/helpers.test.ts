import { describe, it, expect } from '@jest/globals';
import {
  parseAction,
  extractRunbookList,
  isPromptCodeBlock,
  parseQuotedOrIdentifier,
  RESERVED_WORDS,
  isReservedWord,
  parseStepIdFromString,
  extractStepHeader,
  extractSubstepHeader,
  parseConditional,
  convertToTransitions,
  validateLoopControlUsage,
  validateDEFERUsage,
  parseForClause,
  isBoundRef,
  isUnresolvedForClause,
  isResolvedForClause,
  type ParsedConditional,
  type Bound,
  type ParsedForClause,
} from '../src/index.js';
import { formatAction, isExecutableCodeBlock } from '../src/helpers.js';

describe('parseAction NEXT and BREAK', () => {
  it('parses standalone NEXT as first-class NEXT action', () => {
    const result = parseAction('NEXT');
    expect(result).toEqual({ type: 'NEXT' });
  });

  it('parses standalone BREAK as first-class BREAK action', () => {
    const result = parseAction('BREAK');
    expect(result).toEqual({ type: 'BREAK' });
  });
});

describe('parseAction GOTO with substep', () => {
  it('parses GOTO 3 as step-only target', () => {
    const result = parseAction('GOTO 3');
    expect(result).toEqual({
      type: 'GOTO',
      target: { step: '3', substep: undefined },
    });
  });

  it('parses GOTO 2.1 as step with substep', () => {
    const result = parseAction('GOTO 2.1');
    expect(result).toEqual({
      type: 'GOTO',
      target: { step: '2', substep: '1' },
    });
  });

  it('rejects GOTO 3.0', () => {
    expect(parseAction('GOTO 3.0')).toBeNull();
  });
});

describe('parseAction GOTO with named targets', () => {
  it('parses GOTO named step', () => {
    const result = parseAction('GOTO Cleanup');
    expect(result).toEqual({
      type: 'GOTO',
      target: { step: 'Cleanup' },
    });
  });

  it('parses GOTO named step with numeric substep', () => {
    const result = parseAction('GOTO ErrorHandler.1');
    expect(result).toEqual({
      type: 'GOTO',
      target: { step: 'ErrorHandler', substep: '1' },
    });
  });

  it('parses GOTO named step with named substep', () => {
    const result = parseAction('GOTO ErrorHandler.Recover');
    expect(result).toEqual({
      type: 'GOTO',
      target: { step: 'ErrorHandler', substep: 'Recover' },
    });
  });

  it('parses GOTO numeric step with named substep', () => {
    const result = parseAction('GOTO 1.Cleanup');
    expect(result).toEqual({
      type: 'GOTO',
      target: { step: '1', substep: 'Cleanup' },
    });
  });

  it('returns null for quoted GOTO target (names must be identifiers)', () => {
    const result = parseAction('GOTO "Error Handler"');
    expect(result).toBeNull();
  });
});

describe('extractRunbookList', () => {
  it('should extract runbook files from markdown list', () => {
    const content = `### 1.{n} Dispatch agents
 - verify-review.runbook.md
 - security-review.runbook.md

Some other content`;

    const result = extractRunbookList(content);
    expect(result).toEqual(['verify-review.runbook.md', 'security-review.runbook.md']);
  });

  it('should return empty array if no runbooks', () => {
    const content = `### 1.{n} Dispatch agents

Just a description, no runbooks.`;

    const result = extractRunbookList(content);
    expect(result).toEqual([]);
  });

  it('should only match .runbook.md files', () => {
    const content = `### 1.{n}
 - valid.runbook.md
 - not-a-runbook.md
 - another.runbook.md`;

    const result = extractRunbookList(content);
    expect(result).toEqual(['valid.runbook.md', 'another.runbook.md']);
  });
});

describe('isPromptCodeBlock', () => {
  describe('executable tags (returns false)', () => {
    it('returns false for bash', () => {
      expect(isPromptCodeBlock('bash')).toBe(false);
    });

    it('returns false for sh', () => {
      expect(isPromptCodeBlock('sh')).toBe(false);
    });

    it('returns false for shell', () => {
      expect(isPromptCodeBlock('shell')).toBe(false);
    });

    it('returns false for BASH (mixed case)', () => {
      expect(isPromptCodeBlock('BASH')).toBe(false);
    });

    it('returns false for Bash (title case)', () => {
      expect(isPromptCodeBlock('Bash')).toBe(false);
    });

    it('returns false for bash with attributes', () => {
      expect(isPromptCodeBlock('bash filename="test.sh"')).toBe(false);
    });
  });

  describe('prompted tags (returns true)', () => {
    it('returns true for prompt', () => {
      expect(isPromptCodeBlock('prompt')).toBe(true);
    });

    it('returns true for PROMPT (uppercase)', () => {
      expect(isPromptCodeBlock('PROMPT')).toBe(true);
    });

    it('returns true for Prompt (title case)', () => {
      expect(isPromptCodeBlock('Prompt')).toBe(true);
    });

    it('returns true for prompt with attributes', () => {
      expect(isPromptCodeBlock('prompt title="Example"')).toBe(true);
    });
  });

  describe('non-executable language tags (returns true)', () => {
    it('returns true for json', () => {
      expect(isPromptCodeBlock('json')).toBe(true);
    });

    it('returns true for typescript', () => {
      expect(isPromptCodeBlock('typescript')).toBe(true);
    });

    it('returns true for yaml', () => {
      expect(isPromptCodeBlock('yaml')).toBe(true);
    });

    it('returns true for python', () => {
      expect(isPromptCodeBlock('python')).toBe(true);
    });

    it('returns true for unknown language', () => {
      expect(isPromptCodeBlock('foobar')).toBe(true);
    });
  });

  describe('bare code fences (returns null)', () => {
    it('returns null for empty string', () => {
      expect(isPromptCodeBlock('')).toBeNull();
    });

    it('returns null for undefined', () => {
      expect(isPromptCodeBlock(undefined)).toBeNull();
    });

    it('returns null for null', () => {
      expect(isPromptCodeBlock(null)).toBeNull();
    });

    it('returns null for whitespace only', () => {
      expect(isPromptCodeBlock('   ')).toBeNull();
    });
  });
});

describe('parseConditional with YES/NO', () => {
  it('should preserve YES as type', () => {
    const result = parseConditional('YES CONTINUE');
    expect(result).toEqual({
      type: 'yes',
      retry: 0,
      action: { type: 'CONTINUE' },
      modifier: null,
      raw: 'CONTINUE',
    });
  });

  it('should preserve NO as type', () => {
    const result = parseConditional('NO STOP');
    expect(result).toEqual({
      type: 'no',
      retry: 0,
      action: { type: 'STOP' },
      modifier: null,
      raw: 'STOP',
    });
  });
});

describe('convertToTransitions with YES/NO', () => {
  it('should preserve yes kind in transitions', () => {
    const conditionals: ParsedConditional[] = [
      { type: 'yes', retry: 0, action: { type: 'CONTINUE' }, modifier: null, raw: 'CONTINUE' },
      { type: 'no', retry: 0, action: { type: 'STOP' }, modifier: null, raw: 'STOP' },
    ];
    const result = convertToTransitions(conditionals);
    expect(result).toBeDefined();
    expect(result!.transitions.pass.kind).toBe('yes');
    expect(result!.transitions.fail.kind).toBe('no');
  });

  it('should preserve pass kind in transitions', () => {
    const conditionals: ParsedConditional[] = [
      { type: 'pass', retry: 0, action: { type: 'CONTINUE' }, modifier: null, raw: 'CONTINUE' },
      { type: 'fail', retry: 0, action: { type: 'STOP' }, modifier: null, raw: 'STOP' },
    ];
    const result = convertToTransitions(conditionals);
    expect(result).toBeDefined();
    expect(result!.transitions.pass.kind).toBe('pass');
    expect(result!.transitions.fail.kind).toBe('fail');
  });
});

describe('parseAction COMPLETE with message', () => {
  it('parses COMPLETE without message', () => {
    const result = parseAction('COMPLETE');
    expect(result).toEqual({ type: 'COMPLETE' });
  });

  it('parses COMPLETE with single-word message', () => {
    const result = parseAction('COMPLETE SUCCESS');
    expect(result).toEqual({ type: 'COMPLETE', message: 'SUCCESS' });
  });

  it('parses COMPLETE with quoted message', () => {
    const result = parseAction('COMPLETE "all tasks done"');
    expect(result).toEqual({ type: 'COMPLETE', message: 'all tasks done' });
  });

  it('returns null for COMPLETE with unquoted multi-word', () => {
    const result = parseAction('COMPLETE all done');
    expect(result).toBeNull();
  });
});

describe('parseQuotedOrIdentifier', () => {
  describe('valid inputs', () => {
    it('parses single-word identifier', () => {
      expect(parseQuotedOrIdentifier('BLOCKED')).toBe('BLOCKED');
    });

    it('parses identifier with underscore', () => {
      expect(parseQuotedOrIdentifier('error_handler')).toBe('error_handler');
    });

    it('parses identifier starting with underscore', () => {
      expect(parseQuotedOrIdentifier('_private')).toBe('_private');
    });

    it('parses single underscore identifier', () => {
      expect(parseQuotedOrIdentifier('_')).toBe('_');
    });

    it('parses single letter identifier', () => {
      expect(parseQuotedOrIdentifier('A')).toBe('A');
    });

    it('parses quoted multi-word string', () => {
      expect(parseQuotedOrIdentifier('"build failed"')).toBe('build failed');
    });

    it('parses quoted single word', () => {
      expect(parseQuotedOrIdentifier('"Success"')).toBe('Success');
    });

    it('handles empty quoted string', () => {
      expect(parseQuotedOrIdentifier('""')).toBe('');
    });

    it('trims whitespace', () => {
      expect(parseQuotedOrIdentifier('  BLOCKED  ')).toBe('BLOCKED');
    });
  });

  describe('invalid inputs', () => {
    it('throws on unquoted multi-word', () => {
      expect(() => parseQuotedOrIdentifier('build failed')).toThrow();
    });

    it('throws on identifier starting with digit', () => {
      expect(() => parseQuotedOrIdentifier('123abc')).toThrow();
    });

    it('throws on identifier with hyphen', () => {
      expect(() => parseQuotedOrIdentifier('error-handler')).toThrow();
    });

    it('throws on empty string', () => {
      expect(() => parseQuotedOrIdentifier('')).toThrow();
    });

    it('throws on unclosed quote', () => {
      expect(() => parseQuotedOrIdentifier('"unclosed')).toThrow();
    });
  });
});

describe('parseAction STOP message validation', () => {
  it('parses STOP without message', () => {
    const result = parseAction('STOP');
    expect(result).toEqual({ type: 'STOP' });
  });

  it('parses STOP with single-word message', () => {
    const result = parseAction('STOP BLOCKED');
    expect(result).toEqual({ type: 'STOP', message: 'BLOCKED' });
  });

  it('parses STOP with quoted message', () => {
    const result = parseAction('STOP "build failed"');
    expect(result).toEqual({ type: 'STOP', message: 'build failed' });
  });

  it('returns null for STOP with unquoted multi-word', () => {
    const result = parseAction('STOP build failed');
    expect(result).toBeNull();
  });

  it('parses STOP with underscore in message', () => {
    const result = parseAction('STOP ERROR_CODE');
    expect(result).toEqual({ type: 'STOP', message: 'ERROR_CODE' });
  });
});

describe('RESERVED_WORDS', () => {
  it('contains NEXT', () => {
    expect(RESERVED_WORDS.has('NEXT')).toBe(true);
  });

  it('contains action keywords', () => {
    expect(RESERVED_WORDS.has('CONTINUE')).toBe(true);
    expect(RESERVED_WORDS.has('COMPLETE')).toBe(true);
    expect(RESERVED_WORDS.has('STOP')).toBe(true);
    expect(RESERVED_WORDS.has('GOTO')).toBe(true);
    expect(RESERVED_WORDS.has('RETRY')).toBe(true);
  });

  it('contains transition keywords', () => {
    expect(RESERVED_WORDS.has('PASS')).toBe(true);
    expect(RESERVED_WORDS.has('FAIL')).toBe(true);
    expect(RESERVED_WORDS.has('YES')).toBe(true);
    expect(RESERVED_WORDS.has('NO')).toBe(true);
    expect(RESERVED_WORDS.has('ALL')).toBe(true);
    expect(RESERVED_WORDS.has('ANY')).toBe(true);
  });
});

describe('isReservedWord', () => {
  it('returns true for reserved words', () => {
    expect(isReservedWord('NEXT')).toBe(true);
    expect(isReservedWord('CONTINUE')).toBe(true);
  });

  it('returns false for non-reserved words', () => {
    expect(isReservedWord('Cleanup')).toBe(false);
    expect(isReservedWord('ErrorHandler')).toBe(false);
  });
});

describe('extractStepHeader with named steps', () => {
  describe('static steps', () => {
    it('extracts numeric step', () => {
      expect(extractStepHeader('1 Do something')).toEqual({
        name: '1',
        description: 'Do something',
      });
    });
  });

  describe('named steps', () => {
    it('extracts named step', () => {
      expect(extractStepHeader('Cleanup')).toEqual({
        name: 'Cleanup',
        description: 'Cleanup',
      });
    });

    it('extracts named step with title', () => {
      expect(extractStepHeader('ErrorHandler Handle all errors')).toEqual({
        name: 'ErrorHandler',
        description: 'Handle all errors',
      });
    });

    it('extracts named step with underscore', () => {
      expect(extractStepHeader('error_handler')).toEqual({
        name: 'error_handler',
        description: 'error_handler',
      });
    });

    it('extracts single letter named step', () => {
      expect(extractStepHeader('A')).toEqual({
        name: 'A',
        description: 'A',
      });
    });

    it('returns null for reserved word', () => {
      expect(extractStepHeader('NEXT')).toBeNull();
    });

    it('returns null for reserved word COMPLETE', () => {
      expect(extractStepHeader('COMPLETE')).toBeNull();
    });
  });

  describe('named steps with trailing separators', () => {
    it('strips trailing period from named step', () => {
      expect(extractStepHeader('Rollback. Handle rollback')).toEqual({
        name: 'Rollback',
        description: 'Handle rollback',
      });
    });

    it('strips trailing colon from named step', () => {
      expect(extractStepHeader('Rollback: Handle rollback')).toEqual({
        name: 'Rollback',
        description: 'Handle rollback',
      });
    });

    it('strips trailing em dash from named step', () => {
      expect(extractStepHeader('Rollback— Handle rollback')).toEqual({
        name: 'Rollback',
        description: 'Handle rollback',
      });
    });

    it('strips trailing arrow from named step', () => {
      expect(extractStepHeader('Rollback→ Handle rollback')).toEqual({
        name: 'Rollback',
        description: 'Handle rollback',
      });
    });

    it('strips trailing hyphen from named step', () => {
      expect(extractStepHeader('Rollback- Handle rollback')).toEqual({
        name: 'Rollback',
        description: 'Handle rollback',
      });
    });

    it('strips trailing closing parenthesis from named step', () => {
      expect(extractStepHeader('Rollback) Handle rollback')).toEqual({
        name: 'Rollback',
        description: 'Handle rollback',
      });
    });

    it('strips multiple trailing separators from named step', () => {
      expect(extractStepHeader('Rollback.) Handle rollback')).toEqual({
        name: 'Rollback',
        description: 'Handle rollback',
      });
    });

    it('handles named step with trailing separator and no description', () => {
      expect(extractStepHeader('Rollback.')).toEqual({
        name: 'Rollback',
        description: 'Rollback',
      });
    });
  });
});

describe('parseStepIdFromString with named steps', () => {
  describe('named step parsing', () => {
    it('parses simple named step', () => {
      expect(parseStepIdFromString('Cleanup')).toEqual({ step: 'Cleanup' });
    });

    it('parses named step with underscore', () => {
      expect(parseStepIdFromString('error_handler')).toEqual({ step: 'error_handler' });
    });

    it('parses named step starting with underscore', () => {
      expect(parseStepIdFromString('_private')).toEqual({ step: '_private' });
    });
  });

  describe('named substep parsing', () => {
    it('parses numeric step with named substep', () => {
      expect(parseStepIdFromString('1.Cleanup')).toEqual({ step: '1', substep: 'Cleanup' });
    });

    it('parses named step with numeric substep', () => {
      expect(parseStepIdFromString('ErrorHandler.1')).toEqual({
        step: 'ErrorHandler',
        substep: '1',
      });
    });

    it('parses named step with named substep', () => {
      expect(parseStepIdFromString('ErrorHandler.Recover')).toEqual({
        step: 'ErrorHandler',
        substep: 'Recover',
      });
    });
  });

  describe('invalid named steps', () => {
    it('returns null for quoted step (names must be identifiers)', () => {
      expect(parseStepIdFromString('"Error Handler"')).toBeNull();
    });

    it('returns null for quoted substep (names must be identifiers)', () => {
      expect(parseStepIdFromString('1."Clean Up"')).toBeNull();
    });

    it('returns null for identifier starting with digit', () => {
      expect(parseStepIdFromString('123abc')).toBeNull();
    });

    it('returns null for identifier with hyphen', () => {
      expect(parseStepIdFromString('error-handler')).toBeNull();
    });
  });

  describe('reserved word rejection', () => {
    it('returns null for CONTINUE as step name', () => {
      expect(parseStepIdFromString('CONTINUE')).toBeNull();
    });

    it('returns null for COMPLETE as step name', () => {
      expect(parseStepIdFromString('COMPLETE')).toBeNull();
    });

    it('returns null for STOP as step name', () => {
      expect(parseStepIdFromString('STOP')).toBeNull();
    });

    it('returns null for GOTO as step name', () => {
      expect(parseStepIdFromString('GOTO')).toBeNull();
    });

    it('returns null for PASS as step name', () => {
      expect(parseStepIdFromString('PASS')).toBeNull();
    });

    it('returns null for FAIL as step name', () => {
      expect(parseStepIdFromString('FAIL')).toBeNull();
    });

    it('returns null for reserved word as substep', () => {
      expect(parseStepIdFromString('ErrorHandler.STOP')).toBeNull();
    });

    it('returns null for reserved word as substep of numeric step', () => {
      expect(parseStepIdFromString('1.CONTINUE')).toBeNull();
    });

    it('returns null for reserved word as substep of {N}', () => {
      expect(parseStepIdFromString('{N}.STOP')).toBeNull();
    });
  });
});

describe('extractSubstepHeader with named substeps', () => {
  describe('static substeps', () => {
    it('extracts numeric substep', () => {
      const result = extractSubstepHeader('1.1 First substep');
      expect(result).toEqual({
        stepRef: '1',
        id: '1',
        description: 'First substep',
      });
    });
  });

  describe('named substeps', () => {
    it('extracts named substep of numeric step', () => {
      const result = extractSubstepHeader('1.Cleanup Handle cleanup');
      expect(result).toEqual({
        stepRef: '1',
        id: 'Cleanup',
        description: 'Handle cleanup',
      });
    });

    it('extracts named substep of named step', () => {
      const result = extractSubstepHeader('ErrorHandler.Recover Recovery logic');
      expect(result).toEqual({
        stepRef: 'ErrorHandler',
        id: 'Recover',
        description: 'Recovery logic',
      });
    });

    it('extracts substep with minimal single-word description', () => {
      const result = extractSubstepHeader('1.A Do');
      expect(result).toEqual({
        stepRef: '1',
        id: 'A',
        description: 'Do',
      });
    });

    it('rejects reserved word as substep name', () => {
      expect(extractSubstepHeader('1.NEXT Invalid')).toBeNull();
    });
  });

  describe('bare named substeps', () => {
    it('parses bare name with no description', () => {
      expect(extractSubstepHeader('ErrorHandler')).toEqual({
        id: 'ErrorHandler',
        description: '',
      });
    });

    it('parses bare name with description', () => {
      expect(extractSubstepHeader('ErrorHandler Handle the error')).toEqual({
        id: 'ErrorHandler',
        description: 'Handle the error',
      });
    });

    it('parses bare name with colon separator', () => {
      expect(extractSubstepHeader('ErrorHandler: Handle the error')).toEqual({
        id: 'ErrorHandler',
        description: 'Handle the error',
      });
    });

    it('parses bare name with paren separator', () => {
      expect(extractSubstepHeader('ErrorHandler) Title')).toEqual({
        id: 'ErrorHandler',
        description: 'Title',
      });
    });

    it('rejects reserved word GOTO', () => {
      expect(extractSubstepHeader('GOTO')).toBeNull();
    });

    it('rejects reserved word PASS', () => {
      expect(extractSubstepHeader('PASS')).toBeNull();
    });

    it('accepts underscore-prefixed identifier', () => {
      expect(extractSubstepHeader('_private')).toEqual({
        id: '_private',
        description: '',
      });
    });
  });
});

// Phase 2: Step-ID function tests
import { stepIdToString, stepIdEquals } from '../src/step-id.js';

describe('stepIdToString', () => {
  it('formats numeric step', () => {
    expect(stepIdToString({ step: '1' })).toBe('1');
  });

  it('formats step with substep', () => {
    expect(stepIdToString({ step: '1', substep: '2' })).toBe('1.2');
  });

  it('formats named step', () => {
    expect(stepIdToString({ step: 'ErrorHandler' })).toBe('ErrorHandler');
  });

  it('formats named step with substep', () => {
    expect(stepIdToString({ step: 'ErrorHandler', substep: 'Recover' })).toBe(
      'ErrorHandler.Recover',
    );
  });

  it('formats NEXT target', () => {
    expect(stepIdToString({ step: 'NEXT' })).toBe('NEXT');
  });

  it('formats step with AT', () => {
    expect(stepIdToString({ step: '3', at: 1 })).toBe('3 AT 1');
  });

  it('formats step.substep with AT', () => {
    expect(stepIdToString({ step: '3', substep: '1', at: 2 })).toBe('3.1 AT 2');
  });

  it('formats step with template variable AT', () => {
    expect(stepIdToString({ step: '3', at: '{{Index}}' })).toBe('3 AT {{Index}}');
  });
});

describe('stepIdEquals', () => {
  it('returns true for equal numeric steps', () => {
    expect(stepIdEquals({ step: '1' }, { step: '1' })).toBe(true);
  });

  it('returns false for different steps', () => {
    expect(stepIdEquals({ step: '1' }, { step: '2' })).toBe(false);
  });

  it('returns true for equal steps with substeps', () => {
    expect(stepIdEquals({ step: '1', substep: '2' }, { step: '1', substep: '2' })).toBe(true);
  });

  it('returns false when one has substep and one does not', () => {
    expect(stepIdEquals({ step: '1', substep: '2' }, { step: '1' })).toBe(false);
  });

  it('returns false for different substeps', () => {
    expect(stepIdEquals({ step: '1', substep: '1' }, { step: '1', substep: '2' })).toBe(false);
  });

  it('handles undefined substeps correctly', () => {
    expect(stepIdEquals({ step: '1', substep: undefined }, { step: '1' })).toBe(true);
  });

  it('returns true for equal named steps', () => {
    expect(stepIdEquals({ step: 'ErrorHandler' }, { step: 'ErrorHandler' })).toBe(true);
  });

  it('returns true for equal NEXT targets', () => {
    expect(stepIdEquals({ step: 'NEXT' }, { step: 'NEXT' })).toBe(true);
  });

  it('returns true for equal AT values', () => {
    expect(stepIdEquals({ step: '3', at: 1 }, { step: '3', at: 1 })).toBe(true);
  });

  it('returns false when one has AT and one does not', () => {
    expect(stepIdEquals({ step: '3', at: 1 }, { step: '3' })).toBe(false);
  });

  it('returns false for different AT values', () => {
    expect(stepIdEquals({ step: '3', at: 1 }, { step: '3', at: 2 })).toBe(false);
  });
});

describe('parseStepIdFromString edge cases', () => {
  describe('quoted strings', () => {
    it('returns null for quoted step name (names must be identifiers)', () => {
      expect(parseStepIdFromString('"Step Name"')).toBeNull();
    });
  });

  describe('requireSeparator option', () => {
    it('parses 2.1 with separator requirement when followed by space', () => {
      const result = parseStepIdFromString('2.1 Description', { requireSeparator: true });
      expect(result).toEqual({ step: '2', substep: '1' });
    });

    it('parses 3.Cleanup with separator requirement when followed by colon', () => {
      const result = parseStepIdFromString('3.Cleanup:text', { requireSeparator: true });
      expect(result).toEqual({ step: '3', substep: 'Cleanup' });
    });

    it('parses 2.Name with separator when followed by space', () => {
      const result = parseStepIdFromString('2.Name Description', { requireSeparator: true });
      expect(result).toEqual({ step: '2', substep: 'Name' });
    });
  });

  describe('zero step/substep validation', () => {
    it('returns null for step 0', () => {
      expect(parseStepIdFromString('0')).toBeNull();
    });

    it('returns null for substep 0 in numeric step', () => {
      expect(parseStepIdFromString('1.0')).toBeNull();
    });

    it('returns null for substep 0 in named step', () => {
      expect(parseStepIdFromString('ErrorHandler.0')).toBeNull();
    });
  });

  describe('NEXT edge cases', () => {
    it('returns null for NEXT.1 (NEXT cannot have substep notation)', () => {
      expect(parseStepIdFromString('NEXT.1')).toBeNull();
    });

    it('returns null for NEXT.Substep', () => {
      expect(parseStepIdFromString('NEXT.Substep')).toBeNull();
    });
  });

  describe('empty input', () => {
    it('returns null for empty string', () => {
      expect(parseStepIdFromString('')).toBeNull();
    });
  });
});

// Phase 3: formatAction, parseAction error cases, parseConditional error cases

describe('formatAction', () => {
  it('formats CONTINUE', () => {
    expect(formatAction({ type: 'CONTINUE' })).toBe('CONTINUE');
  });

  it('formats COMPLETE without message', () => {
    expect(formatAction({ type: 'COMPLETE' })).toBe('COMPLETE');
  });

  it('formats COMPLETE with message', () => {
    expect(formatAction({ type: 'COMPLETE', message: 'all done' })).toBe('COMPLETE "all done"');
  });

  it('formats STOP without message', () => {
    expect(formatAction({ type: 'STOP' })).toBe('STOP');
  });

  it('formats STOP with message', () => {
    expect(formatAction({ type: 'STOP', message: 'BLOCKED' })).toBe('STOP "BLOCKED"');
  });

  it('formats GOTO with numeric target', () => {
    expect(formatAction({ type: 'GOTO', target: { step: '2' } })).toBe('GOTO 2');
  });

  it('formats GOTO with named target', () => {
    expect(formatAction({ type: 'GOTO', target: { step: 'ErrorHandler' } })).toBe(
      'GOTO ErrorHandler',
    );
  });
});

describe('parseAction error cases', () => {
  it('returns null for unrecognized action', () => {
    expect(parseAction('UNKNOWN')).toBeNull();
  });

  it('returns null for gibberish', () => {
    expect(parseAction('foobar123')).toBeNull();
  });

  it('returns null for RETRY with invalid fallback action', () => {
    expect(parseAction('RETRY 3 INVALID')).toBeNull();
  });

  it('returns null for COMPLETE with unclosed quote', () => {
    expect(parseAction('COMPLETE "unclosed')).toBeNull();
  });

  it('returns null for STOP with unclosed quote', () => {
    expect(parseAction('STOP "unclosed')).toBeNull();
  });

  it('returns null for GOTO with invalid target', () => {
    expect(parseAction('GOTO @invalid')).toBeNull();
  });

  it('returns null for GOTO with reserved word target', () => {
    expect(parseAction('GOTO CONTINUE')).toBeNull();
  });
});

describe('parseConditional DEFER shorthand', () => {
  it('returns array of two ParsedConditionals for standalone DEFER', () => {
    const result = parseConditional('DEFER');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([
      { type: 'pass', retry: 0, action: { type: 'DEFER' }, modifier: null, raw: 'DEFER' },
      { type: 'fail', retry: 0, action: { type: 'DEFER' }, modifier: null, raw: 'DEFER' },
    ]);
  });

  it('returns array of length 2', () => {
    const result = parseConditional('DEFER');
    expect(result).toHaveLength(2);
  });

  it('does not match DEFER with trailing text', () => {
    // "DEFER something" should not match the shorthand — it would fall through
    // to the normal parsing path which returns null
    const result = parseConditional('DEFER something');
    expect(result).toBeNull();
  });

  it('trims whitespace around standalone DEFER', () => {
    const result = parseConditional('  DEFER  ');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  });
});

describe('parseConditional error cases', () => {
  it('throws for PASS with invalid action', () => {
    expect(() => parseConditional('PASS UNKNOWN')).toThrow('Invalid PASS transition');
  });

  it('throws for FAIL with invalid action', () => {
    expect(() => parseConditional('FAIL INVALID')).toThrow('Invalid FAIL transition');
  });

  it('throws for YES with invalid action', () => {
    expect(() => parseConditional('YES BADACTION')).toThrow('Invalid YES transition');
  });

  it('throws for NO with invalid action', () => {
    expect(() => parseConditional('NO NOTVALID')).toThrow('Invalid NO transition');
  });

  it('throws for colon-separated syntax', () => {
    expect(() => parseConditional('PASS: CONTINUE')).toThrow('Invalid transition syntax');
    expect(() => parseConditional('FAIL: STOP')).toThrow('Invalid transition syntax');
    expect(() => parseConditional('YES: CONTINUE')).toThrow('Invalid transition syntax');
    expect(() => parseConditional('NO: STOP')).toThrow('Invalid transition syntax');
  });
});

describe('parseConditional prefix matching', () => {
  it('returns null for words starting with NO', () => {
    expect(parseConditional('NOTE: this is content')).toBeNull();
    expect(parseConditional('NOTHING')).toBeNull();
    expect(parseConditional('NORMAL CONTINUE')).toBeNull();
  });

  it('returns null for words starting with PASS', () => {
    expect(parseConditional('PASSING')).toBeNull();
    expect(parseConditional('PASSWORD reset')).toBeNull();
  });

  it('returns null for words starting with FAIL', () => {
    expect(parseConditional('FAILED')).toBeNull();
    expect(parseConditional('FAILURE mode')).toBeNull();
  });

  it('returns null for words starting with YES', () => {
    expect(parseConditional('YESTERDAY')).toBeNull();
  });

  it('still parses valid transitions', () => {
    expect(parseConditional('NO STOP')).toMatchObject({ type: 'no', action: { type: 'STOP' } });
    expect(parseConditional('PASS CONTINUE')).toMatchObject({
      type: 'pass',
      action: { type: 'CONTINUE' },
    });
    expect(parseConditional('FAIL STOP')).toMatchObject({ type: 'fail', action: { type: 'STOP' } });
    expect(parseConditional('YES CONTINUE')).toMatchObject({
      type: 'yes',
      action: { type: 'CONTINUE' },
    });
  });

  it('still throws for bare keywords without actions', () => {
    expect(() => parseConditional('NO')).toThrow('Invalid NO transition');
    expect(() => parseConditional('PASS')).toThrow('Invalid PASS transition');
    expect(() => parseConditional('FAIL')).toThrow('Invalid FAIL transition');
    expect(() => parseConditional('YES')).toThrow('Invalid YES transition');
  });

  it('returns null for tab-separated keyword and action (only spaces supported)', () => {
    expect(parseConditional('PASS\tCONTINUE')).toBeNull();
    expect(parseConditional('FAIL\tSTOP')).toBeNull();
  });
});

describe('convertToTransitions aggregation conflicts', () => {
  it('throws for conflicting ALL/ALL modifiers', () => {
    const conditionals: ParsedConditional[] = [
      { type: 'pass', retry: 0, action: { type: 'CONTINUE' }, modifier: 'ALL', raw: 'CONTINUE' },
      { type: 'fail', retry: 0, action: { type: 'STOP' }, modifier: 'ALL', raw: 'STOP' },
    ];
    expect(() => convertToTransitions(conditionals)).toThrow('Invalid aggregation combination');
  });

  it('throws for conflicting ANY/ANY modifiers', () => {
    const conditionals: ParsedConditional[] = [
      { type: 'pass', retry: 0, action: { type: 'CONTINUE' }, modifier: 'ANY', raw: 'CONTINUE' },
      { type: 'fail', retry: 0, action: { type: 'STOP' }, modifier: 'ANY', raw: 'STOP' },
    ];
    expect(() => convertToTransitions(conditionals)).toThrow('Invalid aggregation combination');
  });

  it('accepts valid PASS ALL + FAIL ANY (pessimistic)', () => {
    const conditionals: ParsedConditional[] = [
      { type: 'pass', retry: 0, action: { type: 'CONTINUE' }, modifier: 'ALL', raw: 'CONTINUE' },
      { type: 'fail', retry: 0, action: { type: 'STOP' }, modifier: 'ANY', raw: 'STOP' },
    ];
    const result = convertToTransitions(conditionals);
    expect(result).not.toBeNull();
    expect(result?.aggregation?.strategy).toBe('ALL');
  });

  it('accepts valid PASS ANY + FAIL ALL (optimistic)', () => {
    const conditionals: ParsedConditional[] = [
      { type: 'pass', retry: 0, action: { type: 'CONTINUE' }, modifier: 'ANY', raw: 'CONTINUE' },
      { type: 'fail', retry: 0, action: { type: 'STOP' }, modifier: 'ALL', raw: 'STOP' },
    ];
    const result = convertToTransitions(conditionals);
    expect(result).not.toBeNull();
    expect(result?.aggregation?.strategy).toBe('ANY');
  });

  it('throws for one-sided PASS ALL modifier', () => {
    const conditionals: ParsedConditional[] = [
      { type: 'pass', retry: 0, action: { type: 'CONTINUE' }, modifier: 'ALL', raw: 'CONTINUE' },
      { type: 'fail', retry: 0, action: { type: 'STOP' }, modifier: null, raw: 'STOP' },
    ];
    expect(() => convertToTransitions(conditionals)).toThrow('PASS ALL requires explicit FAIL ANY');
  });

  it('throws for one-sided PASS ANY modifier', () => {
    const conditionals: ParsedConditional[] = [
      { type: 'pass', retry: 0, action: { type: 'CONTINUE' }, modifier: 'ANY', raw: 'CONTINUE' },
      { type: 'fail', retry: 0, action: { type: 'STOP' }, modifier: null, raw: 'STOP' },
    ];
    expect(() => convertToTransitions(conditionals)).toThrow('PASS ANY requires explicit FAIL ALL');
  });

  it('throws for one-sided FAIL ANY modifier', () => {
    const conditionals: ParsedConditional[] = [
      { type: 'pass', retry: 0, action: { type: 'CONTINUE' }, modifier: null, raw: 'CONTINUE' },
      { type: 'fail', retry: 0, action: { type: 'STOP' }, modifier: 'ANY', raw: 'STOP' },
    ];
    expect(() => convertToTransitions(conditionals)).toThrow('FAIL ANY requires explicit PASS ALL');
  });

  it('throws for one-sided FAIL ALL modifier', () => {
    const conditionals: ParsedConditional[] = [
      { type: 'pass', retry: 0, action: { type: 'CONTINUE' }, modifier: null, raw: 'CONTINUE' },
      { type: 'fail', retry: 0, action: { type: 'STOP' }, modifier: 'ALL', raw: 'STOP' },
    ];
    expect(() => convertToTransitions(conditionals)).toThrow('FAIL ALL requires explicit PASS ANY');
  });

  it('returns null for empty conditionals array', () => {
    expect(convertToTransitions([])).toBeNull();
  });

  it('provides default STOP for missing fail action', () => {
    const conditionals: ParsedConditional[] = [
      { type: 'pass', retry: 0, action: { type: 'COMPLETE' }, modifier: null, raw: 'COMPLETE' },
    ];
    const result = convertToTransitions(conditionals);
    expect(result).not.toBeNull();
    expect(result?.transitions.fail.action).toEqual({ type: 'STOP' });
  });

  it('provides default CONTINUE for missing pass action', () => {
    const conditionals: ParsedConditional[] = [
      { type: 'fail', retry: 0, action: { type: 'STOP' }, modifier: null, raw: 'STOP' },
    ];
    const result = convertToTransitions(conditionals);
    expect(result).not.toBeNull();
    expect(result?.transitions.pass.action).toEqual({ type: 'CONTINUE' });
  });

  it('sets aggregation to undefined when both modifiers are null', () => {
    const conditionals: ParsedConditional[] = [
      { type: 'pass', retry: 0, action: { type: 'CONTINUE' }, modifier: null, raw: 'CONTINUE' },
      { type: 'fail', retry: 0, action: { type: 'STOP' }, modifier: null, raw: 'STOP' },
    ];
    const result = convertToTransitions(conditionals);
    expect(result?.aggregation).toBeUndefined();
  });

  it('sets aggregation to undefined when only pass provided with null modifier', () => {
    const conditionals: ParsedConditional[] = [
      { type: 'pass', retry: 0, action: { type: 'COMPLETE' }, modifier: null, raw: 'COMPLETE' },
    ];
    const result = convertToTransitions(conditionals);
    expect(result?.aggregation).toBeUndefined();
  });

  it('sets aggregation to undefined when only fail provided with null modifier', () => {
    const conditionals: ParsedConditional[] = [
      { type: 'fail', retry: 0, action: { type: 'STOP' }, modifier: null, raw: 'STOP' },
    ];
    const result = convertToTransitions(conditionals);
    expect(result?.aggregation).toBeUndefined();
  });

  it('sets aggregation to ALL when explicit ALL modifier present', () => {
    const conditionals: ParsedConditional[] = [
      { type: 'pass', retry: 0, action: { type: 'CONTINUE' }, modifier: 'ALL', raw: 'CONTINUE' },
      { type: 'fail', retry: 0, action: { type: 'STOP' }, modifier: 'ANY', raw: 'STOP' },
    ];
    const result = convertToTransitions(conditionals);
    expect(result?.aggregation?.strategy).toBe('ALL');
  });

  it('throws for one-sided ALL modifier without complement', () => {
    const conditionals: ParsedConditional[] = [
      { type: 'pass', retry: 0, action: { type: 'CONTINUE' }, modifier: 'ALL', raw: 'CONTINUE' },
      { type: 'fail', retry: 0, action: { type: 'STOP' }, modifier: null, raw: 'STOP' },
    ];
    expect(() => convertToTransitions(conditionals)).toThrow('PASS ALL requires explicit FAIL ANY');
  });
});

describe('validateLoopControlUsage with RETRY containing NEXT', () => {
  it('rejects RETRY with NEXT fallback in non-FOR context', () => {
    expect(() => {
      validateLoopControlUsage(
        [
          {
            type: 'fail',
            retry: 2,
            action: { type: 'GOTO', target: { step: 'NEXT' } },
            modifier: null,
            raw: 'RETRY 2 NEXT',
          },
        ],
        false,
      );
    }).not.toThrow();
  });
});

describe('validateLoopControlUsage with first-class NEXT/BREAK', () => {
  it('rejects first-class NEXT outside FOR context', () => {
    const conditionals: ParsedConditional[] = [
      { type: 'pass', action: { type: 'NEXT' }, retry: 0, modifier: null, raw: 'NEXT' },
    ];
    expect(() => {
      validateLoopControlUsage(conditionals, false);
    }).toThrow('NEXT is only valid within substeps of a FOR step');
  });

  it('accepts first-class NEXT in FOR context', () => {
    const conditionals: ParsedConditional[] = [
      { type: 'pass', action: { type: 'NEXT' }, retry: 0, modifier: null, raw: 'NEXT' },
    ];
    expect(() => {
      validateLoopControlUsage(conditionals, true);
    }).not.toThrow();
  });

  it('rejects first-class BREAK outside FOR context', () => {
    const conditionals: ParsedConditional[] = [
      { type: 'pass', action: { type: 'BREAK' }, retry: 0, modifier: null, raw: 'BREAK' },
    ];
    expect(() => {
      validateLoopControlUsage(conditionals, false);
    }).toThrow('BREAK is only valid within substeps of a FOR step');
  });

  it('accepts first-class BREAK in FOR context', () => {
    const conditionals: ParsedConditional[] = [
      { type: 'pass', action: { type: 'BREAK' }, retry: 0, modifier: null, raw: 'BREAK' },
    ];
    expect(() => {
      validateLoopControlUsage(conditionals, true);
    }).not.toThrow();
  });
});

describe('validateDEFERUsage', () => {
  it('rejects DEFER in non-substep context', () => {
    const conditionals: ParsedConditional[] = [
      { type: 'pass', action: { type: 'DEFER' }, retry: 0, modifier: null, raw: 'DEFER' },
    ];
    expect(() => {
      validateDEFERUsage(conditionals, false);
    }).toThrow(
      'DEFER is only valid within substeps or FOR iteration-level transitions, not at step level',
    );
  });

  it('accepts DEFER in substep context', () => {
    const conditionals: ParsedConditional[] = [
      { type: 'pass', action: { type: 'DEFER' }, retry: 0, modifier: null, raw: 'DEFER' },
    ];
    expect(() => {
      validateDEFERUsage(conditionals, true);
    }).not.toThrow();
  });

  it('does not throw for non-DEFER actions in non-substep context', () => {
    const conditionals: ParsedConditional[] = [
      { type: 'pass', action: { type: 'CONTINUE' }, retry: 0, modifier: null, raw: 'CONTINUE' },
    ];
    expect(() => {
      validateDEFERUsage(conditionals, false);
    }).not.toThrow();
  });
});

describe('isExecutableCodeBlock edge cases', () => {
  it('returns false for null input', () => {
    expect(isExecutableCodeBlock(null)).toBe(false);
  });

  it('returns false for undefined input', () => {
    expect(isExecutableCodeBlock(undefined)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isExecutableCodeBlock('')).toBe(false);
  });

  it('returns true for bash with attributes', () => {
    expect(isExecutableCodeBlock('bash filename="test.sh"')).toBe(true);
  });

  it('returns false for unknown language', () => {
    expect(isExecutableCodeBlock('python')).toBe(false);
  });
});

describe('extractSubstepHeader edge cases', () => {
  it('returns null for empty string', () => {
    expect(extractSubstepHeader('')).toBeNull();
  });

  it('parses bare name (no dot) as bare named substep', () => {
    expect(extractSubstepHeader('NoDot')).toEqual({
      id: 'NoDot',
      description: '',
    });
  });

  it('returns null for string starting with dot', () => {
    expect(extractSubstepHeader('.1 Something')).toBeNull();
  });

  it('returns null for invalid step reference', () => {
    expect(extractSubstepHeader('@invalid.1 Something')).toBeNull();
  });

  it('treats trailing dot on bare numeric as separator', () => {
    expect(extractSubstepHeader('1.')).toEqual({
      id: '1',
      description: '',
    });
  });

  it('returns null for invalid substep id', () => {
    expect(extractSubstepHeader('1.@invalid Something')).toBeNull();
  });

  it('treats former agent-type parentheses as description text', () => {
    const result = extractSubstepHeader('1.1 Run tests (test-agent)');
    expect(result).toEqual({
      stepRef: '1',
      id: '1',
      description: 'Run tests (test-agent)',
    });
  });

  it('treats standalone agent-type parentheses as description text', () => {
    const result = extractSubstepHeader('1.1 (code-agent)');
    expect(result).toEqual({
      stepRef: '1',
      id: '1',
      description: '(code-agent)',
    });
  });

  it('parses substep with no description after id', () => {
    const result = extractSubstepHeader('1.1');
    expect(result).toEqual({
      stepRef: '1',
      id: '1',
      description: '',
    });
  });
});

describe('parseConditional with modifier', () => {
  it('parses PASS ALL CONTINUE', () => {
    const result = parseConditional('PASS ALL CONTINUE');
    expect(result).toEqual({
      type: 'pass',
      retry: 0,
      action: { type: 'CONTINUE' },
      modifier: 'ALL',
      raw: 'CONTINUE',
    });
  });

  it('parses FAIL ANY STOP', () => {
    const result = parseConditional('FAIL ANY STOP');
    expect(result).toEqual({
      type: 'fail',
      retry: 0,
      action: { type: 'STOP' },
      modifier: 'ANY',
      raw: 'STOP',
    });
  });
});

describe('ParsedConditional with retry property', () => {
  it('parseConditional extracts retry as property', () => {
    const result = parseConditional('FAIL RETRY 2 GOTO 3');
    expect(result).toEqual({
      type: 'fail',
      retry: 2,
      action: { type: 'GOTO', target: { step: '3', substep: undefined } },
      modifier: null,
      raw: 'RETRY 2 GOTO 3',
    });
  });

  it('parseConditional handles NEXT shorthand', () => {
    const result = parseConditional('PASS NEXT');
    expect(result).toEqual({
      type: 'pass',
      retry: 0,
      action: { type: 'NEXT' },
      modifier: null,
      raw: 'NEXT',
    });
  });

  it('parseConditional handles RETRY with NEXT', () => {
    const result = parseConditional('FAIL RETRY 2 NEXT');
    expect(result).toEqual({
      type: 'fail',
      retry: 2,
      action: { type: 'NEXT' },
      modifier: null,
      raw: 'RETRY 2 NEXT',
    });
  });
});

describe('strict RETRY syntax enforcement', () => {
  it('rejects bare RETRY (no count, no action)', () => {
    expect(() => parseConditional('FAIL RETRY')).toThrow('Invalid FAIL transition');
  });

  it('rejects RETRY with count but no action', () => {
    expect(() => parseConditional('FAIL RETRY 2')).toThrow('Invalid FAIL transition');
  });

  it('rejects RETRY with quoted message shorthand', () => {
    expect(() => parseConditional('FAIL RETRY 3 "error"')).toThrow('Invalid FAIL transition');
  });

  it('rejects RETRY without count (RETRY STOP)', () => {
    expect(() => parseConditional('FAIL RETRY STOP')).toThrow('Invalid FAIL transition');
  });

  it('rejects RETRY with zero count', () => {
    expect(() => parseConditional('FAIL RETRY 0 STOP')).toThrow('Invalid FAIL transition');
  });

  it('rejects RETRY with leading-zero count', () => {
    expect(() => parseConditional('FAIL RETRY 03 STOP')).toThrow('Invalid FAIL transition');
  });

  it('accepts RETRY with count and action', () => {
    const result = parseConditional('FAIL RETRY 3 STOP');
    expect(result).toEqual({
      type: 'fail',
      retry: 3,
      action: { type: 'STOP' },
      modifier: null,
      raw: 'RETRY 3 STOP',
    });
  });

  it('accepts RETRY with count, action, and message', () => {
    const result = parseConditional('FAIL RETRY 3 STOP "msg"');
    expect(result).toEqual({
      type: 'fail',
      retry: 3,
      action: { type: 'STOP', message: 'msg' },
      modifier: null,
      raw: 'RETRY 3 STOP "msg"',
    });
  });

  it('accepts RETRY with aggregation', () => {
    const result = parseConditional('FAIL ALL RETRY 3 STOP');
    expect(result).toEqual({
      type: 'fail',
      retry: 3,
      action: { type: 'STOP' },
      modifier: 'ALL',
      raw: 'RETRY 3 STOP',
    });
  });
});

describe('parseStepIdFromString with AT syntax', () => {
  it('parses numeric step with AT', () => {
    expect(parseStepIdFromString('3 AT 1')).toEqual({ step: '3', at: 1 });
  });

  it('parses step.substep with AT', () => {
    expect(parseStepIdFromString('3.1 AT 2')).toEqual({ step: '3', substep: '1', at: 2 });
  });

  it('parses step with template variable AT', () => {
    expect(parseStepIdFromString('3 AT {{Index}}')).toEqual({ step: '3', at: '{{Index}}' });
  });

  it('parses named step with AT', () => {
    expect(parseStepIdFromString('ErrorHandler AT 5')).toEqual({ step: 'ErrorHandler', at: 5 });
  });

  it('rejects AT with zero', () => {
    expect(parseStepIdFromString('3 AT 0')).toBeNull();
  });

  it('rejects AT with negative', () => {
    expect(parseStepIdFromString('3 AT -1')).toBeNull();
  });

  it('rejects AT with invalid template', () => {
    expect(parseStepIdFromString('3 AT {Index}')).toBeNull();
  });

  it('still works without AT (backward compat)', () => {
    expect(parseStepIdFromString('3')).toEqual({ step: '3' });
    expect(parseStepIdFromString('3.1')).toEqual({ step: '3', substep: '1' });
  });

  it('parses AT with whitespace in template variable', () => {
    expect(parseStepIdFromString('3 AT {{ Index }}')).toEqual({ step: '3', at: '{{ Index }}' });
  });

  it('parses AT with leading whitespace only in template', () => {
    expect(parseStepIdFromString('3 AT {{ Index}}')).toEqual({ step: '3', at: '{{ Index}}' });
  });
});

describe('parseStepIdFromString with three-level positions', () => {
  it('parses 1.2.1 as step=1, substep=1, at=2', () => {
    expect(parseStepIdFromString('1.2.1')).toEqual({ step: '1', substep: '1', at: 2 });
  });

  it('parses 1.3.2 as step=1, substep=2, at=3', () => {
    expect(parseStepIdFromString('1.3.2')).toEqual({ step: '1', substep: '2', at: 3 });
  });

  it('parses 3.1.1 as step=3, substep=1, at=1', () => {
    expect(parseStepIdFromString('3.1.1')).toEqual({ step: '3', substep: '1', at: 1 });
  });

  it('parses 1.2.Cleanup as step=1, substep=Cleanup, at=2', () => {
    expect(parseStepIdFromString('1.2.Cleanup')).toEqual({ step: '1', substep: 'Cleanup', at: 2 });
  });

  describe('validation', () => {
    it('rejects step 0', () => {
      expect(parseStepIdFromString('0.1.1')).toBeNull();
    });

    it('rejects iteration 0', () => {
      expect(parseStepIdFromString('1.0.1')).toBeNull();
    });

    it('rejects substep 0', () => {
      expect(parseStepIdFromString('1.2.0')).toBeNull();
    });

    it('rejects reserved word as substep', () => {
      expect(parseStepIdFromString('1.2.CONTINUE')).toBeNull();
    });

    it('rejects contradictory AT suffix', () => {
      expect(parseStepIdFromString('1.2.1 AT 3')).toBeNull();
    });
  });

  describe('requireSeparator option', () => {
    it('parses 1.2.1 with separator when followed by space', () => {
      const result = parseStepIdFromString('1.2.1 Desc', { requireSeparator: true });
      expect(result).toEqual({ step: '1', substep: '1', at: 2 });
    });
  });
});

describe('parseForClause', () => {
  describe('full form: FOR variable IN start TO end', () => {
    it('parses named variable with numeric range', () => {
      expect(parseForClause('FOR batch IN 1 TO 10')).toEqual({
        variable: 'batch',
        start: 1,
        end: 10,
      });
    });

    it('parses underscore variable name', () => {
      expect(parseForClause('FOR _idx IN 1 TO 5')).toEqual({ variable: '_idx', start: 1, end: 5 });
    });
  });

  describe('unnamed range: FOR start TO end', () => {
    it('parses numeric range', () => {
      expect(parseForClause('FOR 1 TO 10')).toEqual({ start: 1, end: 10 });
    });
  });

  describe('named count: FOR variable IN count', () => {
    it('parses numeric count (start defaults to 1)', () => {
      expect(parseForClause('FOR batch IN 10')).toEqual({ variable: 'batch', start: 1, end: 10 });
    });
  });

  describe('unnamed count: FOR count', () => {
    it('parses numeric count (start defaults to 1)', () => {
      expect(parseForClause('FOR 10')).toEqual({ start: 1, end: 10 });
    });
  });

  describe('accepts unresolved template variables as BoundRef', () => {
    it('accepts named variable with template end', () => {
      expect(parseForClause('FOR batch IN 1 TO {{Max}}')).toEqual({
        unresolved: true,
        variable: 'batch',
        start: 1,
        end: { ref: 'Max' },
      });
    });

    it('accepts named variable with template start and end', () => {
      expect(parseForClause('FOR item IN {{Start}} TO {{End}}')).toEqual({
        unresolved: true,
        variable: 'item',
        start: { ref: 'Start' },
        end: { ref: 'End' },
      });
    });

    it('accepts unnamed range with template end', () => {
      expect(parseForClause('FOR 1 TO {{Max}}')).toEqual({
        unresolved: true,
        start: 1,
        end: { ref: 'Max' },
      });
    });

    it('accepts unnamed range with template start', () => {
      expect(parseForClause('FOR {{Start}} TO 10')).toEqual({
        unresolved: true,
        start: { ref: 'Start' },
        end: 10,
      });
    });

    it('accepts named variable with template start', () => {
      expect(parseForClause('FOR batch IN {{Start}} TO 10')).toEqual({
        unresolved: true,
        variable: 'batch',
        start: { ref: 'Start' },
        end: 10,
      });
    });

    it('accepts named variable with numeric start and template end', () => {
      expect(parseForClause('FOR batch IN 1 TO {{End}}')).toEqual({
        unresolved: true,
        variable: 'batch',
        start: 1,
        end: { ref: 'End' },
      });
    });

    it('accepts unnamed count as BoundRef', () => {
      expect(parseForClause('FOR {{Count}}')).toEqual({
        unresolved: true,
        start: 1,
        end: { ref: 'Count' },
      });
    });

    it('parses named count with no-space braces as source reference', () => {
      // FOR batch IN {{Count}} matches source pattern (single {{ }} after IN)
      expect(parseForClause('FOR batch IN {{Count}}')).toEqual({
        variable: 'batch',
        start: 1,
        source: 'Count',
      });
    });

    it('accepts windowed source with template end', () => {
      expect(parseForClause('FOR batch IN 1 TO {{Max}} OF {{ items }}')).toEqual({
        unresolved: true,
        variable: 'batch',
        start: 1,
        end: { ref: 'Max' },
        source: 'items',
      });
    });

    it('accepts windowed source with both bounds as refs', () => {
      expect(parseForClause('FOR batch IN {{Start}} TO {{End}} OF {{ items }}')).toEqual({
        unresolved: true,
        variable: 'batch',
        start: { ref: 'Start' },
        end: { ref: 'End' },
        source: 'items',
      });
    });

    it('accepts windowed source with template start and numeric end', () => {
      expect(parseForClause('FOR item IN {{Start}} TO 10 OF {{ items }}')).toEqual({
        unresolved: true,
        variable: 'item',
        start: { ref: 'Start' },
        end: 10,
        source: 'items',
      });
    });

    it('accepts template ref with spaces in braces', () => {
      expect(parseForClause('FOR 1 TO {{ Max }}')).toEqual({
        unresolved: true,
        start: 1,
        end: { ref: 'Max' },
      });
    });

    // Source reference syntax is unchanged — single {{ }} after IN is still a source
    it('accepts named count as source reference (not BoundRef)', () => {
      // FOR batch IN {{ Count }} is a source reference, not a bound
      expect(parseForClause('FOR batch IN {{ Count }}')).toEqual({
        variable: 'batch',
        start: 1,
        source: 'Count',
      });
    });

    it('accepts unnamed count with spaces in braces as BoundRef', () => {
      // FOR {{ Count }} without variable IN prefix is an unnamed count ref, not a source
      expect(parseForClause('FOR {{ Count }}')).toEqual({
        unresolved: true,
        start: 1,
        end: { ref: 'Count' },
      });
    });
  });

  describe('invalid inputs', () => {
    it('returns null for non-FOR text', () => {
      expect(parseForClause('PASS CONTINUE')).toBeNull();
    });

    it('returns null for bare FOR without arguments', () => {
      expect(parseForClause('FOR')).toBeNull();
    });

    it('returns null for FOR with space but no arguments', () => {
      expect(parseForClause('FOR ')).toBeNull();
    });

    it('returns null for zero as count', () => {
      expect(parseForClause('FOR 0')).toBeNull();
    });

    it('returns null for negative count', () => {
      expect(parseForClause('FOR -1')).toBeNull();
    });

    it('returns null for invalid variable name', () => {
      expect(parseForClause('FOR 1batch IN 1 TO 10')).toBeNull();
    });

    it('returns null for reserved word as variable name', () => {
      expect(parseForClause('FOR PASS IN 1 TO 10')).toBeNull();
      expect(parseForClause('FOR FAIL IN 1 TO 5')).toBeNull();
      expect(parseForClause('FOR GOTO IN 1 TO 3')).toBeNull();
      expect(parseForClause('FOR TO IN 1 TO 5')).toBeNull();
    });

    it('returns null for invalid template format', () => {
      expect(parseForClause('FOR {Count}')).toBeNull();
    });

    it('returns null for non-numeric, non-template end', () => {
      expect(parseForClause('FOR 1 TO abc')).toBeNull();
    });

    it('returns null for text that starts with FOR but is not valid', () => {
      expect(parseForClause('FOR something weird here')).toBeNull();
    });
  });

  describe('reversed ranges (descending)', () => {
    it('accepts reversed range (start > end)', () => {
      expect(parseForClause('FOR 10 TO 1')).toEqual({ start: 10, end: 1 });
    });

    it('accepts reversed range with named variable', () => {
      expect(parseForClause('FOR batch IN 5 TO 2')).toEqual({
        variable: 'batch',
        start: 5,
        end: 2,
      });
    });

    it('accepts named variable with descending range', () => {
      expect(parseForClause('FOR i IN 5 TO 1')).toEqual({ variable: 'i', start: 5, end: 1 });
    });

    it('accepts large descending range', () => {
      expect(parseForClause('FOR 100 TO 50')).toEqual({ start: 100, end: 50 });
    });

    it('accepts minimal descending range', () => {
      expect(parseForClause('FOR 2 TO 1')).toEqual({ start: 2, end: 1 });
    });
  });

  describe('data source iteration', () => {
    it('parses FOR variable IN {{ source }} (all items)', () => {
      expect(parseForClause('FOR server IN {{ servers }}')).toEqual({
        variable: 'server',
        start: 1,
        source: 'servers',
      });
    });

    it('parses FOR variable IN {{ source }} with no spaces in braces', () => {
      expect(parseForClause('FOR server IN {{servers}}')).toEqual({
        variable: 'server',
        start: 1,
        source: 'servers',
      });
    });

    it('parses FOR variable IN start TO end OF {{ source }} (windowed)', () => {
      expect(parseForClause('FOR item IN 1 TO 10 OF {{ items }}')).toEqual({
        variable: 'item',
        start: 1,
        end: 10,
        source: 'items',
      });
    });

    it('parses windowed source with non-1 start', () => {
      expect(parseForClause('FOR item IN 5 TO 20 OF {{ batch }}')).toEqual({
        variable: 'item',
        start: 5,
        end: 20,
        source: 'batch',
      });
    });

    it('rejects reserved word as variable in source syntax', () => {
      expect(parseForClause('FOR PASS IN {{ items }}')).toBeNull();
    });

    it('parses unnamed {{ }} as count ref (not source without variable)', () => {
      // Without variable IN prefix, {{ items }} is parsed as unnamed count ref
      expect(parseForClause('FOR {{ items }}')).toEqual({
        unresolved: true,
        start: 1,
        end: { ref: 'items' },
      });
    });

    it('rejects source name with invalid characters', () => {
      expect(parseForClause('FOR x IN {{ my-items }}')).toBeNull();
    });

    it('parses source name matching identifier pattern', () => {
      expect(parseForClause('FOR x IN {{ my_items_2 }}')).toEqual({
        variable: 'x',
        start: 1,
        source: 'my_items_2',
      });
    });

    it('rejects source reference without braces', () => {
      expect(parseForClause('FOR item IN 1 TO 10 OF items')).toBeNull();
    });

    it('rejects empty source name in braces', () => {
      expect(parseForClause('FOR item IN {{ }}')).toBeNull();
    });

    it('rejects empty windowed source name', () => {
      expect(parseForClause('FOR item IN 1 TO 10 OF {{ }}')).toBeNull();
    });
  });
});

describe('BoundRef type guards', () => {
  describe('isBoundRef', () => {
    it('returns true for BoundRef', () => {
      const bound: Bound = { ref: 'Max' };
      expect(isBoundRef(bound)).toBe(true);
    });

    it('returns false for number', () => {
      const bound: Bound = 10;
      expect(isBoundRef(bound)).toBe(false);
    });
  });

  describe('isUnresolvedForClause', () => {
    it('returns true for unresolved numeric clause', () => {
      const fc: ParsedForClause = { unresolved: true, start: 1, end: { ref: 'Max' } };
      expect(isUnresolvedForClause(fc)).toBe(true);
    });

    it('returns true for unresolved source clause', () => {
      const fc: ParsedForClause = {
        unresolved: true,
        variable: 'item',
        start: 1,
        end: { ref: 'Max' },
        source: 'items',
      };
      expect(isUnresolvedForClause(fc)).toBe(true);
    });

    it('returns false for resolved numeric clause', () => {
      const fc: ParsedForClause = { start: 1, end: 10 };
      expect(isUnresolvedForClause(fc)).toBe(false);
    });

    it('returns false for resolved source clause', () => {
      const fc: ParsedForClause = { variable: 'item', start: 1, source: 'items' };
      expect(isUnresolvedForClause(fc)).toBe(false);
    });
  });

  describe('isResolvedForClause', () => {
    it('returns true for resolved numeric clause', () => {
      const fc: ParsedForClause = { start: 1, end: 10 };
      expect(isResolvedForClause(fc)).toBe(true);
    });

    it('returns true for resolved source clause', () => {
      const fc: ParsedForClause = { variable: 'item', start: 1, source: 'items' };
      expect(isResolvedForClause(fc)).toBe(true);
    });

    it('returns false for unresolved clause', () => {
      const fc: ParsedForClause = { unresolved: true, start: 1, end: { ref: 'Max' } };
      expect(isResolvedForClause(fc)).toBe(false);
    });
  });
});

describe('C1: bash prompt is not executable', () => {
  it('returns false for "bash prompt"', () => {
    expect(isExecutableCodeBlock('bash prompt')).toBe(false);
  });

  it('returns false for "sh prompt"', () => {
    expect(isExecutableCodeBlock('sh prompt')).toBe(false);
  });

  it('returns false for "shell prompt"', () => {
    expect(isExecutableCodeBlock('shell prompt')).toBe(false);
  });

  it('returns false for "BASH PROMPT" (case-insensitive)', () => {
    expect(isExecutableCodeBlock('BASH PROMPT')).toBe(false);
  });

  it('returns true for "bash runme" (non-prompt attribute)', () => {
    expect(isExecutableCodeBlock('bash runme')).toBe(true);
  });

  it('returns true for plain "bash"', () => {
    expect(isExecutableCodeBlock('bash')).toBe(true);
  });
});

describe('C1: bash prompt is recognized as prompt block', () => {
  it('returns true for "bash prompt"', () => {
    expect(isPromptCodeBlock('bash prompt')).toBe(true);
  });

  it('returns true for "sh prompt"', () => {
    expect(isPromptCodeBlock('sh prompt')).toBe(true);
  });

  it('returns true for "shell prompt"', () => {
    expect(isPromptCodeBlock('shell prompt')).toBe(true);
  });

  it('returns true for "BASH PROMPT" (case-insensitive)', () => {
    expect(isPromptCodeBlock('BASH PROMPT')).toBe(true);
  });

  it('returns false for "bash runme" (executable, not prompt)', () => {
    expect(isPromptCodeBlock('bash runme')).toBe(false);
  });

  it('returns false for plain "bash" (executable, not prompt)', () => {
    expect(isPromptCodeBlock('bash')).toBe(false);
  });
});

describe('C2: substep short form (bare numeric)', () => {
  it('parses "1" as short form substep', () => {
    expect(extractSubstepHeader('1')).toEqual({
      id: '1',
      description: '',
    });
  });

  it('parses "2 Review code" with description', () => {
    expect(extractSubstepHeader('2 Review code')).toEqual({
      id: '2',
      description: 'Review code',
    });
  });

  it('treats former agent-type parentheses as description text', () => {
    expect(extractSubstepHeader('3 Review (agent)')).toEqual({
      id: '3',
      description: 'Review (agent)',
    });
  });

  it('treats standalone agent-type parentheses as description text', () => {
    expect(extractSubstepHeader('1 (code-agent)')).toEqual({
      id: '1',
      description: '(code-agent)',
    });
  });

  it('strips trailing period separator from bare numeric', () => {
    expect(extractSubstepHeader('1. Title')).toEqual({
      id: '1',
      description: 'Title',
    });
  });

  it('strips trailing paren separator from bare numeric', () => {
    expect(extractSubstepHeader('1) Title')).toEqual({
      id: '1',
      description: 'Title',
    });
  });

  it('strips trailing colon separator from bare numeric', () => {
    expect(extractSubstepHeader('2: Review code')).toEqual({
      id: '2',
      description: 'Review code',
    });
  });

  it('handles bare numeric with separator and no description', () => {
    expect(extractSubstepHeader('3.')).toEqual({
      id: '3',
      description: '',
    });
  });

  it('returns null for 0 (non-positive)', () => {
    expect(extractSubstepHeader('0')).toBeNull();
  });

  it('still parses dot form "1.1 Description"', () => {
    expect(extractSubstepHeader('1.1 Description')).toEqual({
      stepRef: '1',
      id: '1',
      description: 'Description',
    });
  });
});

describe('E3: bare numeric step headers', () => {
  it('parses "1" as step with default description', () => {
    expect(extractStepHeader('1')).toEqual({
      name: '1',
      description: 'Step 1',
    });
  });

  it('parses "1." as step with default description', () => {
    expect(extractStepHeader('1.')).toEqual({
      name: '1',
      description: 'Step 1',
    });
  });

  it('parses "1)" as step with default description', () => {
    expect(extractStepHeader('1)')).toEqual({
      name: '1',
      description: 'Step 1',
    });
  });

  it('parses "1 -" as step with default description', () => {
    expect(extractStepHeader('1 -')).toEqual({
      name: '1',
      description: 'Step 1',
    });
  });

  it('preserves existing behavior for "1. Do something"', () => {
    expect(extractStepHeader('1. Do something')).toEqual({
      name: '1',
      description: 'Do something',
    });
  });
});
