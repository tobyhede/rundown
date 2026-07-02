import { describe, it, expect } from '@jest/globals';
// Import Errors directly from the factory module (not the `../../src/errors.js`
// barrel). Stryker's `enableFindRelatedTests` uses jest's `--findRelatedTests`,
// whose reverse-dependency graph does not traverse the `export *` re-export
// chain (errors.ts → errors/index.ts → errors/factory.ts). Importing the module
// under test directly is what links this test file to factory.ts so its mutants
// are actually exercised. RundownError is imported from its own module for the
// same reason.
import { Errors } from '../../src/errors/factory.js';
import { RundownError } from '../../src/errors/rundown-error.js';

/**
 * Exhaustive tests for the {@link Errors} factory.
 *
 * Every factory function is exercised and each assertion pins a distinct
 * observable: the RundownError class, the mapped error code, every context
 * field the factory writes (including join separators and `String(...)`
 * coercions), any message template authored inside the factory, and the
 * `cause` linkage where applicable. This kills the ArrowFunction (`=> undefined`),
 * string-literal (error-code key), and object-literal (`{ … }` → `{}`) mutants
 * that survive when a factory is either untested or only asserted on `.code`.
 */
describe('Errors factory - exhaustive coverage', () => {
  describe('File/IO errors', () => {
    it('fileNotFound maps file → RD-101', () => {
      const error = Errors.fileNotFound('runbook.md');
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-101');
      expect(error.context.file).toBe('runbook.md');
      expect(error.message).toBe('Runbook file not found: runbook.md');
    });

    it('fileNotReadable maps file → RD-102', () => {
      const error = Errors.fileNotReadable('config.yaml');
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-102');
      expect(error.context.file).toBe('config.yaml');
      expect(error.message).toContain('config.yaml');
    });

    it('stateDirNotAccessible maps path → context.file → RD-103', () => {
      const error = Errors.stateDirNotAccessible('/path/to/.rundown');
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-103');
      expect(error.context.file).toBe('/path/to/.rundown');
      expect(error.message).toContain('/path/to/.rundown');
    });
  });

  describe('Parse/Syntax errors', () => {
    it('emptyRunbook maps file → RD-201', () => {
      const error = Errors.emptyRunbook('empty.runbook.md');
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-201');
      expect(error.context.file).toBe('empty.runbook.md');
    });

    it('noStepsFound maps file → RD-202', () => {
      const error = Errors.noStepsFound('no-steps.runbook.md');
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-202');
      expect(error.context.file).toBe('no-steps.runbook.md');
    });

    it('invalidFrontmatter maps file only → RD-203', () => {
      const error = Errors.invalidFrontmatter('test.runbook.md');
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-203');
      expect(error.context.file).toBe('test.runbook.md');
      expect(error.context.message).toBeUndefined();
    });

    it('invalidFrontmatter maps file + message → RD-203', () => {
      const error = Errors.invalidFrontmatter('test.runbook.md', 'Invalid YAML: missing colon');
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-203');
      expect(error.context.file).toBe('test.runbook.md');
      expect(error.context.message).toBe('Invalid YAML: missing colon');
      expect(error.message).toContain('Invalid YAML: missing colon');
    });

    it('syntaxError maps message + file + line → RD-204', () => {
      const error = Errors.syntaxError('Unexpected token at position 5', 'test.md', 10);
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-204');
      expect(error.context.file).toBe('test.md');
      expect(error.context.message).toBe('Unexpected token at position 5');
      expect(error.context.line).toBe(10);
      expect(error.message).toBe(
        'Runbook syntax error: test.md - Unexpected token at position 5 (line 10)',
      );
    });

    it('syntaxError maps message alone (no file/line) → RD-204', () => {
      const error = Errors.syntaxError('Invalid YAML');
      expect(error.code).toBe('RD-204');
      expect(error.context.message).toBe('Invalid YAML');
      expect(error.context.file).toBeUndefined();
      expect(error.context.line).toBeUndefined();
      expect(error.message).toBe('Runbook syntax error - Invalid YAML');
    });
  });

  describe('State errors', () => {
    it('noActiveRunbook has empty context → RD-301', () => {
      const error = Errors.noActiveRunbook();
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-301');
      expect(error.message).toBe('No active runbook');
    });

    it('stateParseError maps file only → RD-302', () => {
      const error = Errors.stateParseError('state.json');
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-302');
      expect(error.context.file).toBe('state.json');
      expect(error.context.message).toBeUndefined();
    });

    it('stateParseError maps file + message → RD-302', () => {
      const error = Errors.stateParseError('state.json', 'Unexpected token at position 42');
      expect(error.code).toBe('RD-302');
      expect(error.context.file).toBe('state.json');
      expect(error.context.message).toBe('Unexpected token at position 42');
    });

    it('runbookCompleted without file → RD-303', () => {
      const error = Errors.runbookCompleted();
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-303');
      expect(error.context.file).toBeUndefined();
    });

    it('runbookCompleted with file → RD-303', () => {
      const error = Errors.runbookCompleted('deploy.runbook.md');
      expect(error.code).toBe('RD-303');
      expect(error.context.file).toBe('deploy.runbook.md');
    });

    it('runbookStopped without file → RD-304', () => {
      const error = Errors.runbookStopped();
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-304');
      expect(error.context.file).toBeUndefined();
    });

    it('runbookStopped with file → RD-304', () => {
      const error = Errors.runbookStopped('deploy.runbook.md');
      expect(error.code).toBe('RD-304');
      expect(error.context.file).toBe('deploy.runbook.md');
    });
  });

  describe('Validation errors', () => {
    it('gotoTargetNotFound maps step only → RD-401', () => {
      const error = Errors.gotoTargetNotFound('10');
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-401');
      expect(error.context.step).toBe('10');
      expect(error.context.substep).toBeUndefined();
    });

    it('gotoTargetNotFound maps step + substep → RD-401', () => {
      const error = Errors.gotoTargetNotFound('5', '2');
      expect(error.code).toBe('RD-401');
      expect(error.context.step).toBe('5');
      expect(error.context.substep).toBe('2');
      expect(error.message).toContain('at step 5.2');
    });

    it('invalidStepSequence coerces expected/found to strings + maps line → RD-402', () => {
      const error = Errors.invalidStepSequence(3, 5, 42);
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-402');
      // String(expected) / String(found) coercion — assert the string form.
      expect(error.context.expected).toBe('3');
      expect(error.context.found).toBe('5');
      expect(error.context.line).toBe(42);
      expect(error.message).toContain('(expected 3, found 5)');
      expect(error.message).toContain('(line 42)');
    });

    it('invalidStepSequence omits line when not provided', () => {
      const error = Errors.invalidStepSequence(1, 2);
      expect(error.code).toBe('RD-402');
      expect(error.context.expected).toBe('1');
      expect(error.context.found).toBe('2');
      expect(error.context.line).toBeUndefined();
    });
  });

  describe('Execution errors', () => {
    it('engineInitFailed without cause → RD-501', () => {
      const error = Errors.engineInitFailed();
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-501');
      expect(error.cause).toBeUndefined();
    });

    it('engineInitFailed with cause → RD-501', () => {
      const cause = new Error('XState initialization failed');
      const error = Errors.engineInitFailed(cause);
      expect(error.code).toBe('RD-501');
      expect(error.cause).toBe(cause);
    });

    it('runbookHasNoSteps without file → RD-502', () => {
      const error = Errors.runbookHasNoSteps();
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-502');
      expect(error.context.file).toBeUndefined();
    });

    it('runbookHasNoSteps with file → RD-502', () => {
      const error = Errors.runbookHasNoSteps('empty.runbook.md');
      expect(error.code).toBe('RD-502');
      expect(error.context.file).toBe('empty.runbook.md');
    });

    it('childRunbookActive without childId → RD-503', () => {
      const error = Errors.childRunbookActive();
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-503');
      expect(error.context.childId).toBeUndefined();
    });

    it('childRunbookActive with childId → RD-503', () => {
      const error = Errors.childRunbookActive('abc-123');
      expect(error.code).toBe('RD-503');
      expect(error.context.childId).toBe('abc-123');
    });
  });

  describe('Command errors', () => {
    it('invalidStepFormat maps value → RD-601', () => {
      const error = Errors.invalidStepFormat('abc');
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-601');
      expect(error.context.value).toBe('abc');
      expect(error.message).toBe('Invalid step ID format: "abc"');
    });

    it('missingRequiredArg maps argName → RD-602', () => {
      const error = Errors.missingRequiredArg('file');
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-602');
      expect(error.context.argName).toBe('file');
      expect(error.message).toContain('file');
    });

    it('scenarioNotFound maps scenario + file → RD-603', () => {
      const error = Errors.scenarioNotFound('happy-path', 'test.md');
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-603');
      expect(error.context.scenario).toBe('happy-path');
      expect(error.context.file).toBe('test.md');
      expect(error.message).toBe('Scenario not found: happy-path in test.md');
    });

    it('scenarioNotFound maps scenario only → RD-603', () => {
      const error = Errors.scenarioNotFound('happy-path');
      expect(error.code).toBe('RD-603');
      expect(error.context.scenario).toBe('happy-path');
      expect(error.context.file).toBeUndefined();
      expect(error.message).toBe('Scenario not found: happy-path');
    });
  });

  describe('Delegation / substep-targeting errors', () => {
    it('delegationStepNotFound maps step → RD-801', () => {
      const error = Errors.delegationStepNotFound('2');
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-801');
      expect(error.context.step).toBe('2');
    });

    it('delegationStepNotCurrent maps step + current → RD-802', () => {
      const error = Errors.delegationStepNotCurrent('2', '1');
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-802');
      expect(error.context.step).toBe('2');
      expect(error.context.current).toBe('1');
    });

    it('delegationSubstepRequired joins substeps with ", " → RD-803', () => {
      const error = Errors.delegationSubstepRequired('2', ['2.1', '2.2', '2.3']);
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-803');
      expect(error.context.step).toBe('2');
      // Pins the join separator; a mutated separator would not equal this.
      expect(error.context.substeps).toBe('2.1, 2.2, 2.3');
    });

    it('delegationAlreadyExists maps step (+ optional message) → RD-804', () => {
      const withMessage = Errors.delegationAlreadyExists('2', 'already delegated');
      expect(withMessage).toBeInstanceOf(RundownError);
      expect(withMessage.code).toBe('RD-804');
      expect(withMessage.context.step).toBe('2');
      expect(withMessage.context.message).toBe('already delegated');

      const withoutMessage = Errors.delegationAlreadyExists('3');
      expect(withoutMessage.code).toBe('RD-804');
      expect(withoutMessage.context.step).toBe('3');
      expect(withoutMessage.context.message).toBeUndefined();
    });

    it('delegationRunbookNotFound maps runbook → RD-805', () => {
      const error = Errors.delegationRunbookNotFound('child.runbook.md');
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-805');
      expect(error.context.runbook).toBe('child.runbook.md');
    });

    it('delegationRunbookMismatch maps step/requested/authored + message → RD-822', () => {
      const error = Errors.delegationRunbookMismatch('2', 'req.md', 'auth.md');
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-822');
      expect(error.context.step).toBe('2');
      expect(error.context.requested).toBe('req.md');
      expect(error.context.authored).toBe('auth.md');
      // Interpolated message template authored inside the factory.
      expect(error.context.message).toBe('requested req.md, authored auth.md');
      expect(error.message).toContain('requested req.md, authored auth.md');
    });

    it('delegationSubstepNotFound joins available with ", " → RD-806', () => {
      const error = Errors.delegationSubstepNotFound('2.9', '2', ['2.1', '2.2']);
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-806');
      expect(error.context.substep).toBe('2.9');
      expect(error.context.step).toBe('2');
      expect(error.context.available).toBe('2.1, 2.2');
    });

    it('invalidToken maps token → RD-807', () => {
      const error = Errors.invalidToken('bad_token');
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-807');
      expect(error.context.token).toBe('bad_token');
    });

    it('tokenNotFound maps token → RD-808', () => {
      const error = Errors.tokenNotFound('rdtk_missing');
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-808');
      expect(error.context.token).toBe('rdtk_missing');
    });

    it('tokenCancelled maps token → RD-809', () => {
      const error = Errors.tokenCancelled('rdtk_cancelled');
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-809');
      expect(error.context.token).toBe('rdtk_cancelled');
    });

    it('delegationLockTimeout maps parentRunId → RD-810', () => {
      const error = Errors.delegationLockTimeout('run-123');
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-810');
      expect(error.context.parentRunId).toBe('run-123');
    });

    it('delegationAlreadyClaimed maps step + childRunId → RD-811', () => {
      const error = Errors.delegationAlreadyClaimed('2', 'child-9');
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-811');
      expect(error.context.step).toBe('2');
      expect(error.context.childRunId).toBe('child-9');
    });

    it('delegationInFlight maps step/childRunId + interpolated message → RD-823', () => {
      const error = Errors.delegationInFlight('2', 'child-9');
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-823');
      expect(error.context.step).toBe('2');
      expect(error.context.childRunId).toBe('child-9');
      expect(error.context.message).toBe(
        'child run child-9 is still linked; run "rundown abort <token> --force" before retrying',
      );
      expect(error.message).toContain('child run child-9 is still linked');
    });

    it('delegationAlreadyResolved maps step → RD-812', () => {
      const error = Errors.delegationAlreadyResolved('2');
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-812');
      expect(error.context.step).toBe('2');
    });

    it('delegationNoDelegatableSubstep maps step → RD-813', () => {
      const error = Errors.delegationNoDelegatableSubstep('2');
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-813');
      expect(error.context.step).toBe('2');
    });

    it('delegationSubstepNoRunbook maps substep + step → RD-814', () => {
      const error = Errors.delegationSubstepNoRunbook('2.1', '2');
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-814');
      expect(error.context.substep).toBe('2.1');
      expect(error.context.step).toBe('2');
    });

    it('delegationStepNoSubsteps maps step → RD-815', () => {
      const error = Errors.delegationStepNoSubsteps('2');
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-815');
      expect(error.context.step).toBe('2');
    });

    it('delegationSnapshotStale maps substepId + step → RD-817', () => {
      const error = Errors.delegationSnapshotStale('2.1', '2');
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-817');
      expect(error.context.substepId).toBe('2.1');
      expect(error.context.step).toBe('2');
    });

    it('delegationOwnerLostSubsteps maps substepId + step → RD-818', () => {
      const error = Errors.delegationOwnerLostSubsteps('2.1', '2');
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-818');
      expect(error.context.substepId).toBe('2.1');
      expect(error.context.step).toBe('2');
    });

    it('delegationNestedForbidden maps runId → RD-819', () => {
      const error = Errors.delegationNestedForbidden('run-77');
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-819');
      expect(error.context.runId).toBe('run-77');
    });

    it('delegationInvariantViolated maps reason → RD-821', () => {
      const error = Errors.delegationInvariantViolated('retryDelegation abort result');
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-821');
      expect(error.context.reason).toBe('retryDelegation abort result');
    });
  });

  describe('Retry-hook errors', () => {
    it('retryHookStaleSubstep maps substepId + parentStep → RD-905', () => {
      const error = Errors.retryHookStaleSubstep('2.1', '2');
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-905');
      expect(error.context.substepId).toBe('2.1');
      expect(error.context.parentStep).toBe('2');
    });
  });

  describe('Generic errors', () => {
    it('unknown maps message and omits cause when not given → RD-999', () => {
      const error = Errors.unknown('Something went wrong');
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-999');
      expect(error.context.message).toBe('Something went wrong');
      expect(error.cause).toBeUndefined();
      expect(error.message).toContain('- Something went wrong');
    });

    it('unknown preserves cause → RD-999', () => {
      const cause = new Error('Original error');
      const error = Errors.unknown('Unexpected failure', cause);
      expect(error.code).toBe('RD-999');
      expect(error.context.message).toBe('Unexpected failure');
      expect(error.cause).toBe(cause);
    });
  });
});
