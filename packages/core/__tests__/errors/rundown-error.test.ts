import { describe, it, expect } from '@jest/globals';
import { RundownError, Errors, ErrorCodes, ErrorCategory } from '../../src/errors.js';

describe('RundownError', () => {
  describe('construction', () => {
    it('creates error with code and context', () => {
      const error = new RundownError('FILE_NOT_FOUND', { file: 'test.md' });

      expect(error.code).toBe('RD-101');
      expect(error.message).toBe('Runbook file not found: test.md');
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
      const error = new RundownError('NO_ACTIVE_RUNBOOK');
      expect(error.code).toBe('RD-301');
    });
  });

  describe('docsUrl', () => {
    it('returns documentation URL', () => {
      const error = new RundownError('FILE_NOT_FOUND', { file: 'test.md' });
      expect(error.docsUrl).toBe('https://rundown.dev/docs/errors/file-not-found');
    });
  });

  describe('toCliString', () => {
    it('returns basic format by default', () => {
      const error = new RundownError('FILE_NOT_FOUND', { file: 'test.md' });
      const output = error.toCliString();

      expect(output).toBe('Error RD-101: Runbook file not found: test.md');
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
        title: 'Runbook file not found',
        message: 'Runbook file not found: test.md',
        context: { file: 'test.md' },
        docsUrl: 'https://rundown.dev/docs/errors/file-not-found',
      });
    });
  });
});

describe('Errors factory', () => {
  it('fileNotFound creates correct error', () => {
    const error = Errors.fileNotFound('runbook.md');

    expect(error).toBeInstanceOf(RundownError);
    expect(error.code).toBe('RD-101');
    expect(error.context.file).toBe('runbook.md');
    expect(error.message).toBe('Runbook file not found: runbook.md');
  });

  it('noActiveRunbook creates correct error', () => {
    const error = Errors.noActiveRunbook();

    expect(error.code).toBe('RD-301');
    expect(error.message).toBe('No active runbook');
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
      'Runbook syntax error: test.md - Unexpected token at position 5 (line 10)',
    );
  });

  it('syntaxError works with just message', () => {
    const error = Errors.syntaxError('Invalid YAML');

    expect(error.code).toBe('RD-204');
    expect(error.message).toBe('Runbook syntax error - Invalid YAML');
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

  it('describes database-open errors with their actual command scope and recovery', () => {
    const description = ErrorCodes.STATE_STORE_UNAVAILABLE.description;

    expect(description).toContain('commands that access persisted run state');
    expect(description).toContain('Retry after transient lock contention');
    expect(description).toContain('repair the host or file for persistent failures');
    expect(description).not.toContain('no command can read or write run state');
    expect(description).not.toContain('not retrying the command');
  });

  it('describes RD-306 without assuming SQLite returned a readable rollback mode', () => {
    const description = ErrorCodes.WAL_JOURNAL_MODE_UNAVAILABLE.description;

    expect(description).toContain('did not enter WAL journal mode');
    expect(description).toContain('a non-WAL mode or no readable mode');
    expect(description).not.toContain('fell back to a rollback journal');
  });
});

describe('retry idempotency error codes', () => {
  it('registers RD-826/827/828 in the DELEGATION category', () => {
    expect(ErrorCodes.DELEGATION_REPLACEMENT_CONSUMED.code).toBe('RD-826');
    expect(ErrorCodes.DELEGATION_RETRY_IDENTITY_UNMATCHED.code).toBe('RD-827');
    expect(ErrorCodes.DELEGATION_SUPERSESSION_AMBIGUOUS.code).toBe('RD-828');
    for (const key of [
      'DELEGATION_REPLACEMENT_CONSUMED',
      'DELEGATION_RETRY_IDENTITY_UNMATCHED',
      'DELEGATION_SUPERSESSION_AMBIGUOUS',
    ] as const) {
      expect(ErrorCodes[key].category).toBe(ErrorCategory.DELEGATION);
    }
  });

  it('leaves RD-829 where it is — the three numbers were reserved for these', () => {
    expect(ErrorCodes.DELEGATION_FRONTIER_CONSUME_FAILED.code).toBe('RD-829');
  });

  it('never carries a bearer token in a refusal envelope', () => {
    // No factory here accepts a raw token, so the redaction class is closed by
    // construction rather than by careful call sites.
    const errors = [
      Errors.delegationReplacementConsumed('2.1', 'claimed'),
      Errors.delegationRetryIdentityUnmatched('2.1'),
      Errors.delegationSupersessionAmbiguous('2.1'),
    ];
    for (const error of errors) {
      expect(JSON.stringify(error.toJSON())).not.toContain('rdtk_');
      expect(error.message).toContain('2.1');
    }
  });

  it('names the consumption reason in the message', () => {
    expect(Errors.delegationReplacementConsumed('2.1', 'entry_superseded').message).toContain(
      'entry_superseded',
    );
    expect(Errors.delegationReplacementConsumed('2.1', 'cancelled').message).toContain('cancelled');
  });

  it('keeps the consumption reason machine-readable, not only interpolated into prose', () => {
    // `RetryReplacementConsumedReason` is a closed discriminant that tells an
    // agent WHICH remedy applies — re-target the current bearer (claimed),
    // re-delegate (cancelled), or re-enter the frame (entry_superseded).
    // Interpolating it into a sentence and nothing else forces the agent to
    // parse prose. `reason` is outside `formatMessage`'s fixed key list, so it
    // rides in `context` (rendered as `details.context` in the CLI envelope)
    // without changing the message.
    for (const reason of ['claimed', 'cancelled', 'entry_superseded'] as const) {
      const error = Errors.delegationReplacementConsumed('2.1', reason);
      expect((error.toJSON() as { context: Record<string, unknown> }).context.reason).toBe(reason);
      // Still prose-visible: the structured key is an addition, not a move.
      expect(error.message).toContain(reason);
    }
  });
});
