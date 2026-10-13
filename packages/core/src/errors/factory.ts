import { RundownError, type InvalidRunStateDefect } from './rundown-error.js';

/**
 * Factory functions for creating typed errors.
 * Provides better IDE autocomplete and type safety.
 */
export const Errors = {
  // File/IO
  fileNotFound: (file: string): RundownError => new RundownError('FILE_NOT_FOUND', { file }),

  fileNotReadable: (file: string): RundownError => new RundownError('FILE_NOT_READABLE', { file }),

  stateDirNotAccessible: (path: string): RundownError =>
    new RundownError('STATE_DIR_NOT_ACCESSIBLE', { file: path }),

  // Parse/Syntax
  emptyRunbook: (file: string): RundownError => new RundownError('EMPTY_RUNBOOK', { file }),

  noStepsFound: (file: string): RundownError => new RundownError('NO_STEPS_FOUND', { file }),

  invalidFrontmatter: (file: string, message?: string): RundownError =>
    new RundownError('INVALID_FRONTMATTER', { file, message }),

  syntaxError: (message: string, file?: string, line?: number): RundownError =>
    new RundownError('SYNTAX_ERROR', { file, line, message }),

  // State
  noActiveRunbook: (): RundownError => new RundownError('NO_ACTIVE_RUNBOOK'),

  stateParseError: (file: string, message?: string): RundownError =>
    new RundownError('STATE_PARSE_ERROR', { file, message }),

  runbookCompleted: (file?: string): RundownError =>
    new RundownError('RUNBOOK_COMPLETED', { file }),

  runbookStopped: (file?: string): RundownError => new RundownError('RUNBOOK_STOPPED', { file }),

  incompatibleStateSchema: (foundVersion: number, expectedVersion: number): RundownError =>
    new RundownError('INCOMPATIBLE_STATE_SCHEMA', {
      foundVersion,
      expectedVersion,
      message:
        `found version ${String(foundVersion)}, expected ${String(expectedVersion)}. ` +
        `Any in-flight runs in this database are unrecoverable — delete ` +
        `.rundown/rundown.db and restart your runbooks from source`,
    }),

  // The candidate causes are spelled into the MESSAGE, not left to the code's
  // `description`: the description reaches an operator only through `--text
  // --verbose`, and never appears in the JSON envelope that is the default
  // output. Listing them without asserting one is the whole point — a temporary
  // database and an in-transaction connection reach the same fallback, so naming
  // a network filesystem as THE cause sends an operator on local disk looking in
  // the wrong place.
  //
  // The list must match `WalJournalModeUnavailableError`'s own message, and every
  // entry on it must be a condition under which `PRAGMA journal_mode = WAL`
  // ANSWERS with a non-WAL mode — that answer is the only thing that reaches this
  // code. A read-only file or directory is therefore excluded and said to be
  // excluded: measured on Node 24.18.1 / SQLite 3.53.1 both THROW instead
  // (errcode 8 `SQLITE_READONLY`, errcode 1544 `SQLITE_READONLY_DIRECTORY`), so
  // they surface as RD-307, whose description lists them. Naming them here sent
  // an operator to `chmod` for a fault that cannot produce this error.
  walJournalModeUnavailable: (effectiveMode: string | undefined): RundownError => {
    const modeOutcome =
      effectiveMode === undefined
        ? 'The pragma returned no readable journal mode.'
        : 'SQLite returned the non-WAL mode it kept instead of failing.';
    return new RundownError('WAL_JOURNAL_MODE_UNAVAILABLE', {
      effectiveMode,
      message:
        `effective mode: ${effectiveMode ?? 'unknown'}. WAL mode is required for ` +
        `supported multi-process operation. SQLite still serializes cross-process ` +
        `writers using file locks in rollback-journal mode, but rollback-journal ` +
        `mode does not provide WAL's reader/writer concurrency and is not a ` +
        `validated Rundown deployment mode. ${modeOutcome} This narrows the cause ` +
        `to one of: a ` +
        `filesystem whose VFS provides no shared memory (a network mount such as ` +
        `NFS or SMB is the common one), a temporary database opened with no ` +
        `filename, or a connection already inside a write transaction. A read-only ` +
        `database file or directory is NOT among them — that fails the pragma ` +
        `outright and surfaces as RD-307`,
    });
  },

  // The store-open refusals reach every command that accesses persisted run
  // state, including read-only state commands. Commands such as `rundown check`
  // do not open the store and cannot reach this factory arm. The driver's own
  // message is the only thing that distinguishes a read-only file from a locked
  // database from a missing `node:sqlite`, so it rides in `message` where the
  // default JSON envelope carries it; the code's `description` reaches an
  // operator only under `--text --verbose`.
  stateStoreUnavailable: (detail: string, driverCode?: string, cause?: Error): RundownError =>
    new RundownError('STATE_STORE_UNAVAILABLE', { message: detail, driverCode }, cause),

  concurrentStateModification: (runId: string, detail: string): RundownError =>
    new RundownError('CONCURRENT_STATE_MODIFICATION', { runId, message: detail }),

  // The pre-consume twin of `frontierDisclosureFailed`: the same entry render
  // failed, but on a turn that consumed nothing, so the run keeps its cursor
  // and re-activation re-renders. Context names the run and preserves the
  // render failure that must be fixed first.
  runProgressionEntryFailed: (runId: string, detail: string): RundownError =>
    new RundownError('RUN_PROGRESSION_ENTRY_FAILED', { runId, message: detail }),

  // The recovery is spelled into the MESSAGE, not left to the code's
  // `description`, for the same reason `walJournalModeUnavailable` spells its
  // candidate causes there: the description reaches an operator only through
  // `--text --verbose` and never appears in the default JSON envelope, which is
  // the agent-facing surface. CLAUDE.md requires this condition to "prompt the
  // user to finish or prune"; a prompt that only renders under a flag agents are
  // told never to pass is not a prompt.
  //
  // `detail` is the store's own diagnosis ("invalid schemaVersion", "missing
  // templateVars", "schema validation failed", the legacy-snapshot wording) and
  // is preserved verbatim ahead of the recovery — it is what identifies WHICH
  // run and WHY, and the recovery alone cannot be acted on without it.
  //
  // The prune form names `--inactive` because the bare command cannot clear the
  // run this error is about: an unfiltered `rundown prune` selects completed and
  // stopped runs out of `RunbookStateManager.list`, which swallows the
  // validation failure and skips every invalid row, so the run reaches
  // `prune.ts` only through the invalid-id path gated on `--inactive` / `--all`.
  // The bare form therefore exits 0 having pruned nothing. `--inactive` also
  // discards other orphaned runs — see docs/reference/cli.md's RD-309 row.
  //
  // `defect` carries the same facts as FIELDS. RD-309 is the only 3xx state
  // error scoped to a single run, and it was the only one whose `context` held
  // nothing but `message` — its siblings already do better (RD-306
  // `effectiveMode`, RD-307 `driverCode`, RD-308 `runId`), so a consumer
  // wanting to know which run had to parse English out of `error`. The found
  // schema version is not even in the prose. The values are threaded from the
  // throw site rather than pattern-matched back out of `detail`, which is the
  // shape this exists to remove.
  //
  // None of the defect keys is on `RundownError.formatMessage`'s render
  // whitelist, so this is purely additive: the rendered message is byte-for-byte
  // what it was before the defect existed (pinned in `factory.test.ts`).
  invalidPersistedRunState: (detail: string, defect?: InvalidRunStateDefect): RundownError => {
    const cause = detail.trim();
    const terminated = cause.endsWith('.') ? cause : `${cause}.`;
    return new RundownError('INVALID_PERSISTED_RUN_STATE', {
      ...(defect === undefined
        ? {}
        : {
            runId: defect.runId,
            reason: defect.reason,
            // Omitted rather than emitted as `null` when the refusal is not a
            // version mismatch: an absent key says "not applicable", where a
            // null would claim the row asserts nothing.
            ...(defect.schemaVersion === undefined ? {} : { schemaVersion: defect.schemaVersion }),
          }),
      message:
        `${terminated} Rundown never migrates persisted state, so this run ` +
        `cannot be resumed, completed or stopped: discard it with ` +
        `"rundown prune --inactive", then re-run the runbook from source.`,
    });
  },

  // Validation
  gotoTargetNotFound: (step: string, substep?: string): RundownError =>
    new RundownError('GOTO_TARGET_NOT_FOUND', { step, substep }),

  invalidStepSequence: (expected: number, found: number, line?: number): RundownError =>
    new RundownError('INVALID_STEP_SEQUENCE', {
      expected: String(expected),
      found: String(found),
      line,
    }),

  // Execution
  engineInitFailed: (cause?: Error): RundownError =>
    new RundownError('ENGINE_INIT_FAILED', {}, cause),

  runbookHasNoSteps: (file?: string): RundownError =>
    new RundownError('RUNBOOK_HAS_NO_STEPS', { file }),

  // Command
  invalidStepFormat: (value: string): RundownError =>
    new RundownError('INVALID_STEP_FORMAT', { value }),

  missingRequiredArg: (argName: string): RundownError =>
    new RundownError('MISSING_REQUIRED_ARG', { argName }),

  scenarioNotFound: (scenario: string, file?: string): RundownError =>
    new RundownError('SCENARIO_NOT_FOUND', { scenario, file }),

  // Generic
  unknown: (message: string, cause?: Error): RundownError =>
    new RundownError('UNKNOWN_ERROR', { message }, cause),
};
