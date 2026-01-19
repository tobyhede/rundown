import { describe, it, expect } from '@jest/globals';
import { Errors, RundownError } from '../../src/errors.js';

/**
 * Extended tests for Errors factory functions.
 * Complements the tests in rundown-error.test.ts with additional factory coverage.
 */
describe('Errors factory - extended coverage', () => {
  describe('File/IO errors', () => {
    it('fileNotReadable creates correct error', () => {
      const error = Errors.fileNotReadable('config.yaml');

      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-102');
      expect(error.context.file).toBe('config.yaml');
      expect(error.message).toContain('config.yaml');
    });

    it('stateDirNotAccessible creates correct error', () => {
      const error = Errors.stateDirNotAccessible('/path/to/.claude/rundown');

      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-103');
      expect(error.context.file).toBe('/path/to/.claude/rundown');
    });
  });

  describe('Parse/Syntax errors', () => {
    it('emptyRunbook creates correct error', () => {
      const error = Errors.emptyRunbook('empty.runbook.md');

      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-201');
      expect(error.context.file).toBe('empty.runbook.md');
    });

    it('noStepsFound creates correct error', () => {
      const error = Errors.noStepsFound('no-steps.runbook.md');

      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-202');
      expect(error.context.file).toBe('no-steps.runbook.md');
    });

    it('invalidFrontmatter creates error with file only', () => {
      const error = Errors.invalidFrontmatter('test.runbook.md');

      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-203');
      expect(error.context.file).toBe('test.runbook.md');
    });

    it('invalidFrontmatter creates error with message', () => {
      const error = Errors.invalidFrontmatter('test.runbook.md', 'Invalid YAML: missing colon');

      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-203');
      expect(error.context.file).toBe('test.runbook.md');
      expect(error.context.message).toBe('Invalid YAML: missing colon');
      expect(error.message).toContain('Invalid YAML: missing colon');
    });
  });

  describe('State errors', () => {
    it('stateParseError creates error with file only', () => {
      const error = Errors.stateParseError('state.json');

      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-302');
      expect(error.context.file).toBe('state.json');
    });

    it('stateParseError creates error with message', () => {
      const error = Errors.stateParseError('state.json', 'Unexpected token at position 42');

      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-302');
      expect(error.context.message).toBe('Unexpected token at position 42');
    });

    it('runbookCompleted creates error without file', () => {
      const error = Errors.runbookCompleted();

      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-303');
    });

    it('runbookCompleted creates error with file', () => {
      const error = Errors.runbookCompleted('deploy.runbook.md');

      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-303');
      expect(error.context.file).toBe('deploy.runbook.md');
    });

    it('runbookStopped creates error without file', () => {
      const error = Errors.runbookStopped();

      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-304');
    });

    it('runbookStopped creates error with file', () => {
      const error = Errors.runbookStopped('deploy.runbook.md');

      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-304');
      expect(error.context.file).toBe('deploy.runbook.md');
    });
  });

  describe('Validation errors', () => {
    it('gotoTargetNotFound creates error with step only', () => {
      const error = Errors.gotoTargetNotFound('10');

      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-401');
      expect(error.context.step).toBe('10');
      expect(error.context.substep).toBeUndefined();
    });

    it('gotoNextNotAllowedViaCli creates correct error', () => {
      const error = Errors.gotoNextNotAllowedViaCli();

      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-403');
    });
  });

  describe('Execution errors', () => {
    it('engineInitFailed creates error without cause', () => {
      const error = Errors.engineInitFailed();

      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-501');
      expect(error.cause).toBeUndefined();
    });

    it('engineInitFailed creates error with cause', () => {
      const cause = new Error('XState initialization failed');
      const error = Errors.engineInitFailed(cause);

      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-501');
      expect(error.cause).toBe(cause);
    });

    it('runbookHasNoSteps creates error without file', () => {
      const error = Errors.runbookHasNoSteps();

      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-502');
    });

    it('runbookHasNoSteps creates error with file', () => {
      const error = Errors.runbookHasNoSteps('empty.runbook.md');

      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-502');
      expect(error.context.file).toBe('empty.runbook.md');
    });

    it('childRunbookActive creates error without childId', () => {
      const error = Errors.childRunbookActive();

      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-503');
    });

    it('childRunbookActive creates error with childId', () => {
      const error = Errors.childRunbookActive('abc-123');

      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-503');
      expect(error.context.childId).toBe('abc-123');
    });
  });

  describe('Command errors', () => {
    it('missingRequiredArg creates correct error', () => {
      const error = Errors.missingRequiredArg('file');

      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-602');
      expect(error.context.argName).toBe('file');
      expect(error.message).toContain('file');
    });
  });

  describe('Agent errors', () => {
    it('noPendingStep creates correct error', () => {
      const error = Errors.noPendingStep();

      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-701');
    });

    it('agentNotBound creates error without agentId', () => {
      const error = Errors.agentNotBound();

      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-702');
    });

    it('agentNotBound creates error with agentId', () => {
      const error = Errors.agentNotBound('agent-xyz');

      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-702');
      expect(error.context.agentId).toBe('agent-xyz');
    });
  });

  describe('Generic errors', () => {
    it('unknown preserves cause', () => {
      const cause = new Error('Original error');
      const error = Errors.unknown('Unexpected failure', cause);

      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-999');
      expect(error.cause).toBe(cause);
      expect(error.context.message).toBe('Unexpected failure');
    });
  });
});
