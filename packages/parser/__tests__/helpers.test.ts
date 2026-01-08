import { describe, it, expect } from '@jest/globals';
import { parseAction, extractWorkflowList, isPromptedCodeBlock } from '../src/index.js';

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
      then: { type: 'GOTO', target: { step: 2, substep: undefined } }
    });
  });

  it('parses RETRY GOTO 2 as RETRY 1 GOTO 2', () => {
    const result = parseAction('RETRY GOTO 2');
    expect(result).toEqual({
      type: 'RETRY',
      max: 1,
      then: { type: 'GOTO', target: { step: 2, substep: undefined } }
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
      target: { step: 3, substep: undefined }
    });
  });

  it('parses GOTO 2.1 as step with substep', () => {
    const result = parseAction('GOTO 2.1');
    expect(result).toEqual({
      type: 'GOTO',
      target: { step: 2, substep: '1' }
    });
  });

  it('rejects GOTO 3.0', () => {
    expect(parseAction('GOTO 3.0')).toBeNull();
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

describe('isPromptedCodeBlock', () => {
  describe('executable tags (returns false)', () => {
    it('returns false for bash', () => {
      expect(isPromptedCodeBlock('bash')).toBe(false);
    });

    it('returns false for sh', () => {
      expect(isPromptedCodeBlock('sh')).toBe(false);
    });

    it('returns false for shell', () => {
      expect(isPromptedCodeBlock('shell')).toBe(false);
    });

    it('returns false for BASH (mixed case)', () => {
      expect(isPromptedCodeBlock('BASH')).toBe(false);
    });

    it('returns false for Bash (title case)', () => {
      expect(isPromptedCodeBlock('Bash')).toBe(false);
    });

    it('returns false for bash with attributes', () => {
      expect(isPromptedCodeBlock('bash filename="test.sh"')).toBe(false);
    });
  });

  describe('prompted tags (returns true)', () => {
    it('returns true for prompt', () => {
      expect(isPromptedCodeBlock('prompt')).toBe(true);
    });

    it('returns true for PROMPT (uppercase)', () => {
      expect(isPromptedCodeBlock('PROMPT')).toBe(true);
    });

    it('returns true for Prompt (title case)', () => {
      expect(isPromptedCodeBlock('Prompt')).toBe(true);
    });

    it('returns true for prompt with attributes', () => {
      expect(isPromptedCodeBlock('prompt title="Example"')).toBe(true);
    });
  });

  describe('passive/other tags (returns null)', () => {
    it('returns null for json', () => {
      expect(isPromptedCodeBlock('json')).toBeNull();
    });

    it('returns null for typescript', () => {
      expect(isPromptedCodeBlock('typescript')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(isPromptedCodeBlock('')).toBeNull();
    });

    it('returns null for undefined', () => {
      expect(isPromptedCodeBlock(undefined)).toBeNull();
    });

    it('returns null for null', () => {
      expect(isPromptedCodeBlock(null)).toBeNull();
    });

    it('returns null for whitespace only', () => {
      expect(isPromptedCodeBlock('   ')).toBeNull();
    });
  });
});

// TODO: Implement YES/NO conditional support
describe('parseConditional with YES/NO', () => {
  it.skip('should preserve YES as type', () => {
    const result = parseConditional('YES: CONTINUE');
    expect(result).toEqual({
      type: 'yes',
      action: { type: 'CONTINUE' },
      modifier: null,
      raw: 'CONTINUE',
    });
  });

  it.skip('should preserve NO as type', () => {
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
  it.skip('should preserve yes kind in transitions', () => {
    const conditionals = [
      { type: 'yes', action: { type: 'CONTINUE' }, modifier: null, raw: 'CONTINUE' },
      { type: 'no', action: { type: 'STOP' }, modifier: null, raw: 'STOP' },
    ];
    const result = convertToTransitions(conditionals);
    expect(result.pass.kind).toBe('yes');
    expect(result.fail.kind).toBe('no');
  });

  it.skip('should preserve pass kind in transitions', () => {
    const conditionals = [
      { type: 'pass', action: { type: 'CONTINUE' }, modifier: null, raw: 'CONTINUE' },
      { type: 'fail', action: { type: 'STOP' }, modifier: null, raw: 'STOP' },
    ];
    const result = convertToTransitions(conditionals);
    expect(result.pass.kind).toBe('pass');
    expect(result.fail.kind).toBe('fail');
  });
});
