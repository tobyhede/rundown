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

    // CLAUDE.md § State Persistence requires the CLI to "prompt the user to
    // finish or prune" on invalid state. The prompt has to live in `message`:
    // the code's `description` reaches an operator only under `--text
    // --verbose`, and never appears in the JSON envelope agents read.
    describe('invalidPersistedRunState → RD-309', () => {
      it('appends the finish / stop / prune recovery to the store diagnosis', () => {
        const error = Errors.invalidPersistedRunState(
          'Invalid runbook state for "rd_abc": invalid schemaVersion; expected schema version 1.',
        );

        expect(error).toBeInstanceOf(RundownError);
        expect(error.code).toBe('RD-309');
        expect(error.message).toContain('invalid schemaVersion');
        expect(error.message).toContain('rundown complete');
        expect(error.message).toContain('rundown stop');
        expect(error.message).toContain('rundown prune');
      });

      // The recovery has to name a prune MODE, not the bare command. An
      // unfiltered `rundown prune` defaults to completed + stopped runs, and an
      // invalid run is in neither list — `RunbookStateManager.list` swallows the
      // validation error and skips the row (`runbook/state.ts`), so `prune.ts`
      // reaches it only through the invalid-id path gated on `--inactive` /
      // `--all`. Naming the bare form sent the operator to a command that cannot
      // clear the run this very error is diagnosing, which is worse than
      // silence: it reports success having pruned nothing.
      //
      // The CLI half — running the command this message names against a real
      // invalid row — is `prune.test.ts` › "RD-309 recovery: the prune mode the
      // error message names".
      it('names a prune mode that can actually select the invalid run', () => {
        const error = Errors.invalidPersistedRunState('Invalid runbook state for "rd_abc".');

        expect(error.message).toContain('rundown prune --inactive');
      });

      it('does not double-punctuate a diagnosis that already ends in a period', () => {
        const error = Errors.invalidPersistedRunState('Something is wrong.');
        expect(error.message).toContain('Something is wrong. Rundown never migrates');
        expect(error.message).not.toContain('wrong.. ');
      });

      it('terminates a diagnosis that does not end in a period', () => {
        const error = Errors.invalidPersistedRunState('Something is wrong');
        expect(error.message).toContain('Something is wrong. Rundown never migrates');
      });

      it('trims surrounding whitespace before joining', () => {
        const error = Errors.invalidPersistedRunState('  Something is wrong  ');
        expect(error.message).toContain('Something is wrong. Rundown never migrates');
      });

      // RD-309 is the only 3xx STATE error scoped to a single run, and it was
      // the only one whose JSON envelope carried `"context": {}` — a consumer
      // wanting to know WHICH run had to parse English out of `error`. Its
      // siblings already do better (RD-306 `effectiveMode`, RD-307
      // `driverCode`, RD-308 `runId`).
      it('lifts the defect facts into context', () => {
        const error = Errors.invalidPersistedRunState(
          'Invalid runbook state for "rd_abc": invalid schemaVersion; expected schema version 1.',
          { runId: 'rd_abc', reason: 'invalid_schema_version', schemaVersion: 2 },
        );

        expect(error.context.runId).toBe('rd_abc');
        expect(error.context.reason).toBe('invalid_schema_version');
        expect(error.context.schemaVersion).toBe(2);
      });

      it('omits schemaVersion when the defect does not carry one', () => {
        const error = Errors.invalidPersistedRunState(
          'Invalid runbook state for "rd_abc": missing templateVars.',
          { runId: 'rd_abc', reason: 'missing_template_vars' },
        );

        expect(error.context.runId).toBe('rd_abc');
        expect(error.context.reason).toBe('missing_template_vars');
        expect(error.context).not.toHaveProperty('schemaVersion');
      });

      // `formatMessage` renders a whitelist of context keys, and none of the
      // defect fields is on it — so structured context must be additive. If
      // this drifts, every RD-309 message gains duplicated facts.
      it('renders the same message with and without a defect', () => {
        const detail = 'Invalid runbook state for "rd_abc": schema validation failed.';

        expect(
          Errors.invalidPersistedRunState(detail, {
            runId: 'rd_abc',
            reason: 'schema_validation_failed',
          }).message,
        ).toBe(Errors.invalidPersistedRunState(detail).message);
      });
    });

    // RD-306 is the one factory arm that BRANCHES, and the branch is the whole
    // point of it: the pragma either answered with a mode Rundown will not run
    // on, or did not answer readably at all. Those are different diagnoses and
    // the message must not blur them. `rundown-error.test.ts` pins the
    // registered `description`; this pins what the factory actually builds,
    // which is the half that reaches the JSON envelope.
    describe('walJournalModeUnavailable → RD-306', () => {
      it('names the kept mode when SQLite answered with one', () => {
        const error = Errors.walJournalModeUnavailable('delete');

        expect(error).toBeInstanceOf(RundownError);
        expect(error.code).toBe('RD-306');
        expect(error.context.effectiveMode).toBe('delete');
        expect(error.message).toContain('effective mode: delete');
        expect(error.message).toContain(
          'SQLite returned the non-WAL mode it kept instead of failing.',
        );
        expect(error.message).not.toContain('The pragma returned no readable journal mode.');
      });

      it('reports an unreadable pragma answer distinctly, as "unknown"', () => {
        const error = Errors.walJournalModeUnavailable(undefined);

        expect(error.code).toBe('RD-306');
        expect(error.context.effectiveMode).toBeUndefined();
        // `?? 'unknown'`, not `&& 'unknown'`: the nullish fallback is what keeps
        // an absent mode from rendering as the literal "undefined".
        expect(error.message).toContain('effective mode: unknown');
        expect(error.message).toContain('The pragma returned no readable journal mode.');
        expect(error.message).not.toContain('SQLite returned the non-WAL mode');
      });

      it('states the WAL requirement without claiming rollback mode loses cross-process serialization', () => {
        const error = Errors.walJournalModeUnavailable('delete');

        // The correction this wording carries: SQLite DOES serialize
        // cross-process writers under a rollback journal, via file locking.
        // What WAL adds is reader/writer concurrency. Saying otherwise sent an
        // operator looking for a corruption risk that is not there.
        expect(error.message).toContain(
          'WAL mode is required for supported multi-process operation.',
        );
        expect(error.message).toContain(
          'SQLite still serializes cross-process writers using file locks in rollback-journal mode',
        );
        expect(error.message).toContain("does not provide WAL's reader/writer concurrency");
        expect(error.message).toContain('is not a validated Rundown deployment mode.');
      });

      it('enumerates the three candidate causes and excludes the read-only one', () => {
        const error = Errors.walJournalModeUnavailable('delete');

        expect(error.message).toContain(
          'This narrows the cause to one of: a filesystem whose VFS provides no shared memory',
        );
        expect(error.message).toContain('a temporary database opened with no filename');
        expect(error.message).toContain('a connection already inside a write transaction');
        // Read-only file/directory THROWS rather than answering the pragma, so
        // it surfaces as RD-307 and must stay named as excluded here.
        expect(error.message).toContain('A read-only database file or directory is NOT among them');
        expect(error.message).toContain('surfaces as RD-307');
      });
    });

    describe('stateStoreUnavailable → RD-307', () => {
      it('carries the driver diagnosis verbatim, plus the driver code and cause', () => {
        const cause = new Error('attempt to write a readonly database');
        const error = Errors.stateStoreUnavailable(
          'Native SQLite (node:sqlite) is unavailable on this multi-process host: attempt to write a readonly database.',
          'SQLITE_READONLY',
          cause,
        );

        expect(error).toBeInstanceOf(RundownError);
        expect(error.code).toBe('RD-307');
        // The driver's own text is the only thing that distinguishes a
        // read-only file from a locked database from a missing adapter, so it
        // must reach `message` — the JSON envelope carries that, not the
        // registered description.
        expect(error.message).toContain('attempt to write a readonly database');
        expect(error.context.driverCode).toBe('SQLITE_READONLY');
        expect(error.cause).toBe(cause);
      });

      it('omits driverCode when the driver reported none', () => {
        const error = Errors.stateStoreUnavailable('could not open database');

        expect(error.code).toBe('RD-307');
        expect(error.context.driverCode).toBeUndefined();
      });
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

  describe('Run Progression errors', () => {
    it('runProgressionEntryFailed maps runId + the entry cause → RD-504', () => {
      // Nothing was consumed before the render failed, so the run keeps its
      // cursor and re-activation re-renders the same entry once the cause is
      // fixed.
      const error = Errors.runProgressionEntryFailed(
        'rd_11111111111111111111111111111111',
        'helper "slugify" threw: boom',
      );
      expect(error).toBeInstanceOf(RundownError);
      expect(error.code).toBe('RD-504');
      expect(error.context.runId).toBe('rd_11111111111111111111111111111111');
      expect(error.context.message).toBe('helper "slugify" threw: boom');
      expect(error.message).toBe(
        'Run Progression could not render the step entry - helper "slugify" threw: boom',
      );
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
