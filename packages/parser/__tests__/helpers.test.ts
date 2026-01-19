import { describe, it, expect } from '@jest/globals';
import { parseAction, extractRunbookList, isPromptCodeBlock, parseQuotedOrIdentifier, RESERVED_WORDS, isReservedWord, parseStepIdFromString, extractStepHeader, extractSubstepHeader, parseConditional, convertToTransitions, validateNEXTUsage, type ParsedConditional } from '../src/index.js';

describe('parseAction GOTO NEXT', () => {
  it('parses GOTO NEXT as action', () => {
    const result = parseAction('GOTO NEXT');
    expect(result).toEqual({ type: 'GOTO', target: { step: 'NEXT' } });
  });

  it('parses standalone NEXT as GOTO NEXT', () => {
    const result = parseAction('NEXT');
    expect(result).toEqual({ type: 'GOTO', target: { step: 'NEXT' } });
  });

  it('parses RETRY 3 GOTO NEXT', () => {
    const result = parseAction('RETRY 3 GOTO NEXT');
    expect(result).toEqual({
      type: 'RETRY',
      max: 3,
      then: { type: 'GOTO', target: { step: 'NEXT' } }
    });
  });
});

describe('parseAction RETRY with exhaustion', () => {
  it('parses RETRY (bare) as RETRY 1 STOP', () => {
    const result = parseAction('RETRY');
    expect(result).toEqual({
      type: 'RETRY',
      max: 1,
      then: { type: 'STOP' }
    });
  });

  it('parses RETRY 3 as RETRY 3 STOP', () => {
    const result = parseAction('RETRY 3');
    expect(result).toEqual({
      type: 'RETRY',
      max: 3,
      then: { type: 'STOP' }
    });
  });

  it('parses RETRY "message" as RETRY 1 STOP with message', () => {
    const result = parseAction('RETRY "Build failed"');
    expect(result).toEqual({
      type: 'RETRY',
      max: 1,
      then: { type: 'STOP', message: 'Build failed' }
    });
  });

  it('parses RETRY 3 "message" as RETRY 3 STOP with message', () => {
    const result = parseAction('RETRY 3 "Build failed"');
    expect(result).toEqual({
      type: 'RETRY',
      max: 3,
      then: { type: 'STOP', message: 'Build failed' }
    });
  });

  it('parses RETRY 3 STOP "message"', () => {
    const result = parseAction('RETRY 3 STOP "Build failed"');
    expect(result).toEqual({
      type: 'RETRY',
      max: 3,
      then: { type: 'STOP', message: 'Build failed' }
    });
  });

  it('parses RETRY 3 GOTO 2', () => {
    const result = parseAction('RETRY 3 GOTO 2');
    expect(result).toEqual({
      type: 'RETRY',
      max: 3,
      then: { type: 'GOTO', target: { step: '2', substep: undefined } }
    });
  });

  it('parses RETRY GOTO 2 as RETRY 1 GOTO 2', () => {
    const result = parseAction('RETRY GOTO 2');
    expect(result).toEqual({
      type: 'RETRY',
      max: 1,
      then: { type: 'GOTO', target: { step: '2', substep: undefined } }
    });
  });

  it('parses RETRY CONTINUE as RETRY 1 CONTINUE', () => {
    const result = parseAction('RETRY CONTINUE');
    expect(result).toEqual({
      type: 'RETRY',
      max: 1,
      then: { type: 'CONTINUE' }
    });
  });

  it('parses RETRY 5 CONTINUE', () => {
    const result = parseAction('RETRY 5 CONTINUE');
    expect(result).toEqual({
      type: 'RETRY',
      max: 5,
      then: { type: 'CONTINUE' }
    });
  });

  it('parses RETRY 2 COMPLETE', () => {
    const result = parseAction('RETRY 2 COMPLETE');
    expect(result).toEqual({
      type: 'RETRY',
      max: 2,
      then: { type: 'COMPLETE' }
    });
  });
});

describe('parseAction GOTO with substep', () => {
  it('parses GOTO 3 as step-only target', () => {
    const result = parseAction('GOTO 3');
    expect(result).toEqual({
      type: 'GOTO',
      target: { step: '3', substep: undefined }
    });
  });

  it('parses GOTO 2.1 as step with substep', () => {
    const result = parseAction('GOTO 2.1');
    expect(result).toEqual({
      type: 'GOTO',
      target: { step: '2', substep: '1' }
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
      target: { step: 'Cleanup' }
    });
  });

  it('parses GOTO named step with numeric substep', () => {
    const result = parseAction('GOTO ErrorHandler.1');
    expect(result).toEqual({
      type: 'GOTO',
      target: { step: 'ErrorHandler', substep: '1' }
    });
  });

  it('parses GOTO named step with named substep', () => {
    const result = parseAction('GOTO ErrorHandler.Recover');
    expect(result).toEqual({
      type: 'GOTO',
      target: { step: 'ErrorHandler', substep: 'Recover' }
    });
  });

  it('parses GOTO numeric step with named substep', () => {
    const result = parseAction('GOTO 1.Cleanup');
    expect(result).toEqual({
      type: 'GOTO',
      target: { step: '1', substep: 'Cleanup' }
    });
  });

  it('parses GOTO {N} with named substep', () => {
    const result = parseAction('GOTO {N}.Recovery');
    expect(result).toEqual({
      type: 'GOTO',
      target: { step: '{N}', substep: 'Recovery' }
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

  describe('passive/other tags (returns null)', () => {
    it('returns null for json', () => {
      expect(isPromptCodeBlock('json')).toBeNull();
    });

    it('returns null for typescript', () => {
      expect(isPromptCodeBlock('typescript')).toBeNull();
    });

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
    const result = parseConditional('YES: CONTINUE');
    expect(result).toEqual({
      type: 'yes',
      action: { type: 'CONTINUE' },
      modifier: null,
      raw: 'CONTINUE',
    });
  });

  it('should preserve NO as type', () => {
    const result = parseConditional('NO: STOP');
    expect(result).toEqual({
      type: 'no',
      action: { type: 'STOP' },
      modifier: null,
      raw: 'STOP',
    });
  });
});

describe('convertToTransitions with YES/NO', () => {
  it('should preserve yes kind in transitions', () => {
    const conditionals: ParsedConditional[] = [
      { type: 'yes', action: { type: 'CONTINUE' }, modifier: null, raw: 'CONTINUE' },
      { type: 'no', action: { type: 'STOP' }, modifier: null, raw: 'STOP' },
    ];
    const result = convertToTransitions(conditionals);
    expect(result!.pass.kind).toBe('yes');
    expect(result!.fail.kind).toBe('no');
  });

  it('should preserve pass kind in transitions', () => {
    const conditionals: ParsedConditional[] = [
      { type: 'pass', action: { type: 'CONTINUE' }, modifier: null, raw: 'CONTINUE' },
      { type: 'fail', action: { type: 'STOP' }, modifier: null, raw: 'STOP' },
    ];
    const result = convertToTransitions(conditionals);
    expect(result!.pass.kind).toBe('pass');
    expect(result!.fail.kind).toBe('fail');
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
        isDynamic: false,
        description: 'Do something',
      });
    });
  });

  describe('dynamic steps', () => {
    it('extracts {N} step', () => {
      expect(extractStepHeader('{N} Process each item')).toEqual({
        name: '{N}',
        isDynamic: true,
        description: 'Process each item',
      });
    });
  });

  describe('named steps', () => {
    it('extracts named step', () => {
      expect(extractStepHeader('Cleanup')).toEqual({
        name: 'Cleanup',
        isDynamic: false,
        description: 'Cleanup',
      });
    });

    it('extracts named step with title', () => {
      expect(extractStepHeader('ErrorHandler Handle all errors')).toEqual({
        name: 'ErrorHandler',
        isDynamic: false,
        description: 'Handle all errors',
      });
    });

    it('extracts named step with underscore', () => {
      expect(extractStepHeader('error_handler')).toEqual({
        name: 'error_handler',
        isDynamic: false,
        description: 'error_handler',
      });
    });

    it('extracts single letter named step', () => {
      expect(extractStepHeader('A')).toEqual({
        name: 'A',
        isDynamic: false,
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
        isDynamic: false,
        description: 'Handle rollback',
      });
    });

    it('strips trailing colon from named step', () => {
      expect(extractStepHeader('Rollback: Handle rollback')).toEqual({
        name: 'Rollback',
        isDynamic: false,
        description: 'Handle rollback',
      });
    });

    it('strips trailing em dash from named step', () => {
      expect(extractStepHeader('Rollback— Handle rollback')).toEqual({
        name: 'Rollback',
        isDynamic: false,
        description: 'Handle rollback',
      });
    });

    it('strips trailing arrow from named step', () => {
      expect(extractStepHeader('Rollback→ Handle rollback')).toEqual({
        name: 'Rollback',
        isDynamic: false,
        description: 'Handle rollback',
      });
    });

    it('strips trailing hyphen from named step', () => {
      expect(extractStepHeader('Rollback- Handle rollback')).toEqual({
        name: 'Rollback',
        isDynamic: false,
        description: 'Handle rollback',
      });
    });

    it('strips trailing closing parenthesis from named step', () => {
      expect(extractStepHeader('Rollback) Handle rollback')).toEqual({
        name: 'Rollback',
        isDynamic: false,
        description: 'Handle rollback',
      });
    });

    it('strips multiple trailing separators from named step', () => {
      expect(extractStepHeader('Rollback.) Handle rollback')).toEqual({
        name: 'Rollback',
        isDynamic: false,
        description: 'Handle rollback',
      });
    });

    it('handles named step with trailing separator and no description', () => {
      expect(extractStepHeader('Rollback.')).toEqual({
        name: 'Rollback',
        isDynamic: false,
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
      expect(parseStepIdFromString('ErrorHandler.1')).toEqual({ step: 'ErrorHandler', substep: '1' });
    });

    it('parses named step with named substep', () => {
      expect(parseStepIdFromString('ErrorHandler.Recover')).toEqual({ step: 'ErrorHandler', substep: 'Recover' });
    });

    it('parses {N} with named substep', () => {
      expect(parseStepIdFromString('{N}.Recovery')).toEqual({ step: '{N}', substep: 'Recovery' });
    });
  });

  describe('invalid named steps', () => {
    it('returns null for quoted step (names must be identifiers)', () => {
      expect(parseStepIdFromString('"Error Handler"')).toBeNull();
    });

    it('returns null for quoted substep (names must be identifiers)', () => {
      expect(parseStepIdFromString('1."Clean Up"')).toBeNull();
    });

    it('parses NEXT as special target', () => {
      expect(parseStepIdFromString('NEXT')).toEqual({ step: 'NEXT' });
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

describe('parseStepIdFromString dynamic patterns', () => {
  it('parses {N} as step target (restart current dynamic instance)', () => {
    const result = parseStepIdFromString('{N}');
    expect(result).toEqual({ step: '{N}' });
  });

  it('parses {N}.{n} as current step with current substep', () => {
    const result = parseStepIdFromString('{N}.{n}');
    expect(result).toEqual({ step: '{N}', substep: '{n}' });
  });
});

describe('parseStepIdFromString substep {n}', () => {
  it('parses 1.{n} as step 1 with dynamic substep', () => {
    const result = parseStepIdFromString('1.{n}');
    expect(result).toEqual({ step: '1', substep: '{n}' });
  });

  it('parses ErrorHandler.{n} as named step with dynamic substep', () => {
    const result = parseStepIdFromString('ErrorHandler.{n}');
    expect(result).toEqual({ step: 'ErrorHandler', substep: '{n}' });
  });

  it('rejects bare {n} as step', () => {
    const result = parseStepIdFromString('{n}');
    expect(result).toBeNull();
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
        isDynamic: false,
        agentType: undefined,
      });
    });
  });

  describe('dynamic substeps', () => {
    it('extracts {n} substep', () => {
      const result = extractSubstepHeader('{N}.{n} Process item');
      expect(result).toEqual({
        stepRef: '{N}',
        id: '{n}',
        description: 'Process item',
        isDynamic: true,
        agentType: undefined,
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
        isDynamic: false,
        agentType: undefined,
      });
    });

    it('extracts named substep of named step', () => {
      const result = extractSubstepHeader('ErrorHandler.Recover Recovery logic');
      expect(result).toEqual({
        stepRef: 'ErrorHandler',
        id: 'Recover',
        description: 'Recovery logic',
        isDynamic: false,
        agentType: undefined,
      });
    });

    it('extracts named substep of {N} step', () => {
      const result = extractSubstepHeader('{N}.Recovery Handle recovery');
      expect(result).toEqual({
        stepRef: '{N}',
        id: 'Recovery',
        description: 'Handle recovery',
        isDynamic: false,
        agentType: undefined,
      });
    });

    it('extracts substep with minimal single-word description', () => {
      const result = extractSubstepHeader('1.A Do');
      expect(result).toEqual({
        stepRef: '1',
        id: 'A',
        description: 'Do',
        isDynamic: false,
        agentType: undefined,
      });
    });

    it('rejects reserved word as substep name', () => {
      expect(extractSubstepHeader('1.NEXT Invalid')).toBeNull();
    });
  });
});

describe('parseAction GOTO NEXT with target', () => {
  it('parses GOTO NEXT {N} as qualified NEXT (advance step)', () => {
    const result = parseAction('GOTO NEXT {N}');
    expect(result).toEqual({
      type: 'GOTO',
      target: { step: 'NEXT', qualifier: { step: '{N}' } }
    });
  });

  it('parses GOTO NEXT {N}.{n} as qualified NEXT (advance substep, same step)', () => {
    const result = parseAction('GOTO NEXT {N}.{n}');
    expect(result).toEqual({
      type: 'GOTO',
      target: { step: 'NEXT', qualifier: { step: '{N}', substep: '{n}' } }
    });
  });

  it('parses GOTO NEXT 1.{n} as qualified NEXT to substep', () => {
    const result = parseAction('GOTO NEXT 1.{n}');
    expect(result).toEqual({
      type: 'GOTO',
      target: { step: 'NEXT', qualifier: { step: '1', substep: '{n}' } }
    });
  });

  it('parses GOTO NEXT ErrorHandler.{n}', () => {
    const result = parseAction('GOTO NEXT ErrorHandler.{n}');
    expect(result).toEqual({
      type: 'GOTO',
      target: { step: 'NEXT', qualifier: { step: 'ErrorHandler', substep: '{n}' } }
    });
  });
});

describe('validateNEXTUsage with dynamic substeps', () => {
  const makeConditional = (action: { type: string; target?: { step: string } }): ParsedConditional => ({
    type: 'pass',
    action: action as any,
    modifier: null,
    raw: 'test'
  });

  it('allows NEXT in dynamic substep of static step', () => {
    expect(() => {
      validateNEXTUsage(
        [makeConditional({ type: 'GOTO', target: { step: 'NEXT' } })],
        false,  // step is NOT dynamic
        true    // substep IS dynamic
      );
    }).not.toThrow();
  });

  it('rejects NEXT in static substep of static step', () => {
    expect(() => {
      validateNEXTUsage(
        [makeConditional({ type: 'GOTO', target: { step: 'NEXT' } })],
        false,  // step is NOT dynamic
        false   // substep is NOT dynamic
      );
    }).toThrow('NEXT action is only allowed in dynamic contexts');
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
    expect(stepIdToString({ step: 'ErrorHandler', substep: 'Recover' })).toBe('ErrorHandler.Recover');
  });

  it('formats dynamic step', () => {
    expect(stepIdToString({ step: '{N}' })).toBe('{N}');
  });

  it('formats dynamic step with substep', () => {
    expect(stepIdToString({ step: '{N}', substep: '{n}' })).toBe('{N}.{n}');
  });

  it('formats NEXT target', () => {
    expect(stepIdToString({ step: 'NEXT' })).toBe('NEXT');
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
});

describe('parseStepIdFromString edge cases', () => {
  describe('quoted strings', () => {
    it('returns null for quoted step name (names must be identifiers)', () => {
      expect(parseStepIdFromString('"Step Name"')).toBeNull();
    });
  });

  describe('requireSeparator option', () => {
    it('parses {N}.1 with separator requirement when followed by space', () => {
      const result = parseStepIdFromString('{N}.1 Description', { requireSeparator: true });
      expect(result).toEqual({ step: '{N}', substep: '1' });
    });

    it('parses {N}.{n} with separator requirement when followed by colon', () => {
      const result = parseStepIdFromString('{N}.{n}:text', { requireSeparator: true });
      expect(result).toEqual({ step: '{N}', substep: '{n}' });
    });

    it('parses {N}.abc without explicit separator since abc is a valid identifier', () => {
      // Valid identifiers match before requireSeparator check
      const result = parseStepIdFromString('{N}.abc', { requireSeparator: true });
      expect(result).toEqual({ step: '{N}', substep: 'abc' });
    });

    it('parses {N}.Name with separator when followed by space', () => {
      const result = parseStepIdFromString('{N}.Name Description', { requireSeparator: true });
      expect(result).toEqual({ step: '{N}', substep: 'Name' });
    });
  });

  describe('malformed dynamic patterns', () => {
    it('returns null for malformed {N}abc (no dot separator)', () => {
      expect(parseStepIdFromString('{N}abc')).toBeNull();
    });

    it('returns null for {N}123 without dot', () => {
      expect(parseStepIdFromString('{N}123')).toBeNull();
    });
  });

  describe('zero step/substep validation', () => {
    it('returns null for step 0', () => {
      expect(parseStepIdFromString('0')).toBeNull();
    });

    it('returns null for substep 0 in numeric step', () => {
      expect(parseStepIdFromString('1.0')).toBeNull();
    });

    it('returns null for substep 0 in dynamic step', () => {
      expect(parseStepIdFromString('{N}.0')).toBeNull();
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

  describe('bare {n} rejection', () => {
    it('rejects bare {n} as step (only valid as substep)', () => {
      expect(parseStepIdFromString('{n}')).toBeNull();
    });
  });

  describe('empty input', () => {
    it('returns null for empty string', () => {
      expect(parseStepIdFromString('')).toBeNull();
    });
  });

  describe('{N}.numeric substep', () => {
    it('parses {N}.1 as dynamic step with numeric substep', () => {
      expect(parseStepIdFromString('{N}.1')).toEqual({ step: '{N}', substep: '1' });
    });

    it('parses {N}.99 as dynamic step with numeric substep', () => {
      expect(parseStepIdFromString('{N}.99')).toEqual({ step: '{N}', substep: '99' });
    });
  });

  describe('invalid {N}.xxx patterns', () => {
    it('returns null for {N}.@invalid (invalid character)', () => {
      expect(parseStepIdFromString('{N}.@invalid')).toBeNull();
    });

    it('returns null for {N}.-dash (starts with dash)', () => {
      expect(parseStepIdFromString('{N}.-dash')).toBeNull();
    });
  });
});

// Phase 3: formatAction, parseAction error cases, parseConditional error cases
import { formatAction, convertToTransitions } from '../src/helpers.js';

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
    expect(formatAction({ type: 'GOTO', target: { step: 'ErrorHandler' } })).toBe('GOTO ErrorHandler');
  });

  it('formats RETRY with max', () => {
    expect(formatAction({ type: 'RETRY', max: 3, then: { type: 'STOP' } })).toBe('RETRY 3');
  });

  it('formats RETRY without max as "RETRY"', () => {
    // This tests the case where max is undefined/falsy
    expect(formatAction({ type: 'RETRY', max: 0, then: { type: 'STOP' } } as any)).toBe('RETRY');
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

  it('throws for nested RETRY (RETRY in RETRY)', () => {
    expect(() => parseAction('RETRY 3 RETRY 2')).toThrow('RETRY actions cannot contain another RETRY');
  });
});

describe('parseConditional error cases', () => {
  it('throws for PASS with invalid action', () => {
    expect(() => parseConditional('PASS: UNKNOWN')).toThrow('Invalid PASS transition');
  });

  it('throws for FAIL with invalid action', () => {
    expect(() => parseConditional('FAIL: INVALID')).toThrow('Invalid FAIL transition');
  });

  it('throws for YES with invalid action', () => {
    expect(() => parseConditional('YES: BADACTION')).toThrow('Invalid YES transition');
  });

  it('throws for NO with invalid action', () => {
    expect(() => parseConditional('NO: NOTVALID')).toThrow('Invalid NO transition');
  });
});

describe('convertToTransitions aggregation conflicts', () => {
  it('throws for conflicting ALL/ALL modifiers', () => {
    const conditionals: ParsedConditional[] = [
      { type: 'pass', action: { type: 'CONTINUE' }, modifier: 'ALL', raw: 'CONTINUE' },
      { type: 'fail', action: { type: 'STOP' }, modifier: 'ALL', raw: 'STOP' },
    ];
    expect(() => convertToTransitions(conditionals)).toThrow('Invalid aggregation combination');
  });

  it('throws for conflicting ANY/ANY modifiers', () => {
    const conditionals: ParsedConditional[] = [
      { type: 'pass', action: { type: 'CONTINUE' }, modifier: 'ANY', raw: 'CONTINUE' },
      { type: 'fail', action: { type: 'STOP' }, modifier: 'ANY', raw: 'STOP' },
    ];
    expect(() => convertToTransitions(conditionals)).toThrow('Invalid aggregation combination');
  });

  it('accepts valid PASS ALL + FAIL ANY (pessimistic)', () => {
    const conditionals: ParsedConditional[] = [
      { type: 'pass', action: { type: 'CONTINUE' }, modifier: 'ALL', raw: 'CONTINUE' },
      { type: 'fail', action: { type: 'STOP' }, modifier: 'ANY', raw: 'STOP' },
    ];
    const result = convertToTransitions(conditionals);
    expect(result).not.toBeNull();
    expect(result!.all).toBe(true);
  });

  it('accepts valid PASS ANY + FAIL ALL (optimistic)', () => {
    const conditionals: ParsedConditional[] = [
      { type: 'pass', action: { type: 'CONTINUE' }, modifier: 'ANY', raw: 'CONTINUE' },
      { type: 'fail', action: { type: 'STOP' }, modifier: 'ALL', raw: 'STOP' },
    ];
    const result = convertToTransitions(conditionals);
    expect(result).not.toBeNull();
    expect(result!.all).toBe(false);
  });

  it('defaults to all=true with only PASS modifier ALL', () => {
    const conditionals: ParsedConditional[] = [
      { type: 'pass', action: { type: 'CONTINUE' }, modifier: 'ALL', raw: 'CONTINUE' },
      { type: 'fail', action: { type: 'STOP' }, modifier: null, raw: 'STOP' },
    ];
    const result = convertToTransitions(conditionals);
    expect(result!.all).toBe(true);
  });

  it('defaults to all=false with only PASS modifier ANY', () => {
    const conditionals: ParsedConditional[] = [
      { type: 'pass', action: { type: 'CONTINUE' }, modifier: 'ANY', raw: 'CONTINUE' },
      { type: 'fail', action: { type: 'STOP' }, modifier: null, raw: 'STOP' },
    ];
    const result = convertToTransitions(conditionals);
    expect(result!.all).toBe(false);
  });

  it('defaults to all=true with only FAIL modifier ANY', () => {
    const conditionals: ParsedConditional[] = [
      { type: 'pass', action: { type: 'CONTINUE' }, modifier: null, raw: 'CONTINUE' },
      { type: 'fail', action: { type: 'STOP' }, modifier: 'ANY', raw: 'STOP' },
    ];
    const result = convertToTransitions(conditionals);
    expect(result!.all).toBe(true);
  });

  it('defaults to all=false with only FAIL modifier ALL', () => {
    const conditionals: ParsedConditional[] = [
      { type: 'pass', action: { type: 'CONTINUE' }, modifier: null, raw: 'CONTINUE' },
      { type: 'fail', action: { type: 'STOP' }, modifier: 'ALL', raw: 'STOP' },
    ];
    const result = convertToTransitions(conditionals);
    expect(result!.all).toBe(false);
  });

  it('returns null for empty conditionals array', () => {
    expect(convertToTransitions([])).toBeNull();
  });

  it('provides default STOP for missing fail action', () => {
    const conditionals: ParsedConditional[] = [
      { type: 'pass', action: { type: 'COMPLETE' }, modifier: null, raw: 'COMPLETE' },
    ];
    const result = convertToTransitions(conditionals);
    expect(result).not.toBeNull();
    expect(result!.fail.action).toEqual({ type: 'STOP' });
  });

  it('provides default CONTINUE for missing pass action', () => {
    const conditionals: ParsedConditional[] = [
      { type: 'fail', action: { type: 'STOP' }, modifier: null, raw: 'STOP' },
    ];
    const result = convertToTransitions(conditionals);
    expect(result).not.toBeNull();
    expect(result!.pass.action).toEqual({ type: 'CONTINUE' });
  });
});

describe('validateNEXTUsage with RETRY containing NEXT', () => {
  const makeConditionalWithRetry = (): ParsedConditional => ({
    type: 'pass',
    action: {
      type: 'RETRY',
      max: 3,
      then: { type: 'GOTO', target: { step: 'NEXT' } }
    } as any,
    modifier: null,
    raw: 'test'
  });

  it('allows RETRY with NEXT fallback in dynamic context', () => {
    expect(() => {
      validateNEXTUsage(
        [makeConditionalWithRetry()],
        true,  // dynamic step
        false
      );
    }).not.toThrow();
  });

  it('rejects RETRY with NEXT fallback in static context', () => {
    expect(() => {
      validateNEXTUsage(
        [makeConditionalWithRetry()],
        false, // NOT dynamic
        false
      );
    }).toThrow('NEXT action is only allowed in dynamic contexts');
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

import { isExecutableCodeBlock, extractSubstepHeader } from '../src/helpers.js';

describe('extractSubstepHeader edge cases', () => {
  it('returns null for empty string', () => {
    expect(extractSubstepHeader('')).toBeNull();
  });

  it('returns null for string without dot', () => {
    expect(extractSubstepHeader('NoDot')).toBeNull();
  });

  it('returns null for string starting with dot', () => {
    expect(extractSubstepHeader('.1 Something')).toBeNull();
  });

  it('returns null for invalid step reference', () => {
    expect(extractSubstepHeader('@invalid.1 Something')).toBeNull();
  });

  it('returns null for nothing after dot', () => {
    expect(extractSubstepHeader('1.')).toBeNull();
  });

  it('returns null for invalid substep id', () => {
    expect(extractSubstepHeader('1.@invalid Something')).toBeNull();
  });

  it('extracts agent type from parentheses at end', () => {
    const result = extractSubstepHeader('1.1 Run tests (test-agent)');
    expect(result).toEqual({
      stepRef: '1',
      id: '1',
      description: 'Run tests',
      isDynamic: false,
      agentType: 'test-agent',
    });
  });

  it('extracts agent type without description', () => {
    const result = extractSubstepHeader('1.1 (code-agent)');
    expect(result).toEqual({
      stepRef: '1',
      id: '1',
      description: '',
      isDynamic: false,
      agentType: 'code-agent',
    });
  });

  it('parses substep with no description after id', () => {
    const result = extractSubstepHeader('1.1');
    expect(result).toEqual({
      stepRef: '1',
      id: '1',
      description: '',
      isDynamic: false,
      agentType: undefined,
    });
  });
});

describe('parseAction RETRY fallback edge cases', () => {
  it('parses RETRY with quoted message as STOP message', () => {
    const result = parseAction('RETRY 3 "failed after retries"');
    expect(result).toEqual({
      type: 'RETRY',
      max: 3,
      then: { type: 'STOP', message: 'failed after retries' }
    });
  });

  it('parses RETRY with COMPLETE fallback with message', () => {
    const result = parseAction('RETRY 2 COMPLETE "done"');
    expect(result).toEqual({
      type: 'RETRY',
      max: 2,
      then: { type: 'COMPLETE', message: 'done' }
    });
  });

  it('parses RETRY with STOP fallback with message', () => {
    const result = parseAction('RETRY 2 STOP "error"');
    expect(result).toEqual({
      type: 'RETRY',
      max: 2,
      then: { type: 'STOP', message: 'error' }
    });
  });

  it('returns null for RETRY COMPLETE with unclosed quote', () => {
    expect(parseAction('RETRY 3 COMPLETE "unclosed')).toBeNull();
  });

  it('returns null for RETRY STOP with unclosed quote', () => {
    expect(parseAction('RETRY 3 STOP "unclosed')).toBeNull();
  });
});

describe('parseConditional with modifier', () => {
  it('parses PASS ALL: CONTINUE', () => {
    const result = parseConditional('PASS ALL: CONTINUE');
    expect(result).toEqual({
      type: 'pass',
      action: { type: 'CONTINUE' },
      modifier: 'ALL',
      raw: 'CONTINUE',
    });
  });

  it('parses FAIL ANY: STOP', () => {
    const result = parseConditional('FAIL ANY: STOP');
    expect(result).toEqual({
      type: 'fail',
      action: { type: 'STOP' },
      modifier: 'ANY',
      raw: 'STOP',
    });
  });
});
