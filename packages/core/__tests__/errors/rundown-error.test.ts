import { describe, it, expect } from '@jest/globals';
import { RundownError, Errors, ErrorCodes, ErrorCategory } from '../../src/errors.js';

describe('RundownError', () => {
  describe('construction', () => {
    it('creates error with code and context', () => {
      const error = new RundownError('FILE_NOT_FOUND', { file: 'test.md' });

      expect(error.code).toBe('RD-101');
      expect(error.message).toBe('Workflow file not found: test.md');
      expect(error.context.file).toBe('test.md');
    });

    it('includes step in message', () => {
      const error = new RundownError('GOTO_TARGET_NOT_FOUND', {
        step: '5',
      });

      expect(error.message).toContain('at step 5');
    });

    it('includes substep in message', () => {
      const error = new RundownError('GOTO_TARGET_NOT_FOUND', {
        step: '5',
        substep: '2',
      });

      expect(error.message).toContain('at step 5.2');
    });

    it('includes line number in message', () => {
      const error = new RundownError('SYNTAX_ERROR', { line: 42 });

      expect(error.message).toContain('(line 42)');
    });

    it('includes message detail from context', () => {
      const error = new RundownError('SYNTAX_ERROR', {
        message: 'Unexpected token',
        line: 10,
      });

      expect(error.message).toContain('- Unexpected token');
      expect(error.message).toContain('(line 10)');
    });

    it('includes expected and found for validation errors', () => {
      const error = new RundownError('INVALID_STEP_SEQUENCE', {
        expected: '3',
        found: '5',
      });

      expect(error.message).toContain('(expected 3, found 5)');
    });

    it('includes value for format errors', () => {
      const error = new RundownError('INVALID_STEP_FORMAT', {
        value: 'abc',
      });

      expect(error.message).toContain(': "abc"');
    });

    it('preserves cause', () => {
      const cause = new Error('original');
      const error = new RundownError('UNKNOWN_ERROR', {}, cause);

      expect(error.cause).toBe(cause);
    });
  });

  describe('code', () => {
    it('returns error code string', () => {
      const error = new RundownError('NO_ACTIVE_WORKFLOW');
      expect(error.code).toBe('RD-301');
    });
  });

  describe('docsUrl', () => {
    it('returns documentation URL', () => {
      const error = new RundownError('FILE_NOT_FOUND', { file: 'test.md' });
      expect(error.docsUrl).toBe(
        'https://rundown.dev/docs/errors/file-not-found'
      );
    });
  });

  describe('toCliString', () => {
    it('returns basic format by default', () => {
      const error = new RundownError('FILE_NOT_FOUND', { file: 'test.md' });
      const output = error.toCliString();

      expect(output).toBe('Error RD-101: Workflow file not found: test.md');
    });

    it('includes description and docs URL when verbose', () => {
      const error = new RundownError('FILE_NOT_FOUND', { file: 'test.md' });
      const output = error.toCliString(true);

      expect(output).toContain('Error RD-101:');
      expect(output).toContain('does not exist or cannot be accessed');
      expect(output).toContain('Documentation:');
    });
  });

  describe('toJSON', () => {
    it('returns structured error object', () => {
      const error = new RundownError('FILE_NOT_FOUND', { file: 'test.md' });
      const json = error.toJSON();

      expect(json).toEqual({
        code: 'RD-101',
        category: 'FILE_IO',
        title: 'Workflow file not found',
        message: 'Workflow file not found: test.md',
        context: { file: 'test.md' },
        docsUrl: 'https://rundown.dev/docs/errors/file-not-found',
      });
    });
  });
});

describe('Errors factory', () => {
  it('fileNotFound creates correct error', () => {
    const error = Errors.fileNotFound('workflow.md');

    expect(error).toBeInstanceOf(RundownError);
    expect(error.code).toBe('RD-101');
    expect(error.context.file).toBe('workflow.md');
    expect(error.message).toBe('Workflow file not found: workflow.md');
  });

  it('noActiveWorkflow creates correct error', () => {
    const error = Errors.noActiveWorkflow();

    expect(error.code).toBe('RD-301');
    expect(error.message).toBe('No active workflow');
  });

  it('invalidStepFormat creates correct error with value', () => {
    const error = Errors.invalidStepFormat('abc');

    expect(error.code).toBe('RD-601');
    expect(error.context.value).toBe('abc');
    expect(error.message).toBe('Invalid step ID format: "abc"');
  });

  it('gotoTargetNotFound includes step and substep', () => {
    const error = Errors.gotoTargetNotFound('5', '2');

    expect(error.code).toBe('RD-401');
    expect(error.message).toContain('at step 5.2');
  });

  it('syntaxError includes file, message detail, and line', () => {
    const error = Errors.syntaxError('Unexpected token at position 5', 'test.md', 10);

    expect(error.code).toBe('RD-204');
    // File is primary (no specific identifier), message and line are appended
    expect(error.message).toBe(
      'Workflow syntax error: test.md - Unexpected token at position 5 (line 10)'
    );
  });

  it('syntaxError works with just message', () => {
    const error = Errors.syntaxError('Invalid YAML');

    expect(error.code).toBe('RD-204');
    expect(error.message).toBe('Workflow syntax error - Invalid YAML');
  });

  it('invalidStepSequence includes expected and found', () => {
    const error = Errors.invalidStepSequence(3, 5, 42);

    expect(error.code).toBe('RD-402');
    expect(error.message).toContain('(expected 3, found 5)');
    expect(error.message).toContain('(line 42)');
  });

  it('unknown includes message from wrapped error', () => {
    const error = Errors.unknown('Something went wrong');

    expect(error.code).toBe('RD-999');
    expect(error.message).toContain('- Something went wrong');
  });

  it('scenarioNotFound includes scenario name and file', () => {
    const error = Errors.scenarioNotFound('happy-path', 'test.md');

    expect(error.code).toBe('RD-603');
    expect(error.message).toBe('Scenario not found: happy-path in test.md');
  });

  it('scenarioNotFound works without file', () => {
    const error = Errors.scenarioNotFound('happy-path');

    expect(error.code).toBe('RD-603');
    expect(error.message).toBe('Scenario not found: happy-path');
  });
});

describe('ErrorCodes', () => {
  it('has correct structure for all codes', () => {
    for (const [_key, def] of Object.entries(ErrorCodes)) {
      expect(def.code).toMatch(/^RD-\d{3}$/);
      expect(Object.values(ErrorCategory)).toContain(def.category);
      expect(def.title).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(def.docSlug).toBeTruthy();
    }
  });

  it('has unique codes', () => {
    const codes = Object.values(ErrorCodes).map((d) => d.code);
    const uniqueCodes = new Set(codes);
    expect(uniqueCodes.size).toBe(codes.length);
  });

  it('has unique docSlugs', () => {
    const slugs = Object.values(ErrorCodes).map((d) => d.docSlug);
    const uniqueSlugs = new Set(slugs);
    expect(uniqueSlugs.size).toBe(slugs.length);
  });
});
