import { describe, it, expect } from '@jest/globals';
import { parseAction, extractWorkflowList, isPromptCodeBlock, parseQuotedOrIdentifier, RESERVED_WORDS, isReservedWord, parseStepIdFromString, extractStepHeader, extractSubstepHeader, parseConditional, convertToTransitions, type ParsedConditional } from '../src/index.js';

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

describe('extractWorkflowList', () => {
  it('should extract workflow files from markdown list', () => {
    const content = `### 1.{n} Dispatch agents
 - verify-review.runbook.md
 - security-review.runbook.md

Some other content`;

    const result = extractWorkflowList(content);
    expect(result).toEqual(['verify-review.runbook.md', 'security-review.runbook.md']);
  });

  it('should return empty array if no workflows', () => {
    const content = `### 1.{n} Dispatch agents

Just a description, no workflows.`;

    const result = extractWorkflowList(content);
    expect(result).toEqual([]);
  });

  it('should only match .runbook.md files', () => {
    const content = `### 1.{n}
 - valid.runbook.md
 - not-a-workflow.md
 - another.runbook.md`;

    const result = extractWorkflowList(content);
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
