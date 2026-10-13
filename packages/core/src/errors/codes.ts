/**
 * Error categories for Rundown CLI.
 */
export enum ErrorCategory {
  FILE_IO = 'FILE_IO',
  PARSE_SYNTAX = 'PARSE_SYNTAX',
  STATE = 'STATE',
  VALIDATION = 'VALIDATION',
  EXECUTION = 'EXECUTION',
  COMMAND = 'COMMAND',
  AGENT = 'AGENT',
  DELEGATION = 'DELEGATION',
}

/**
 * Error code definition with metadata.
 */
export interface ErrorCodeDefinition {
  /** Unique error code (e.g., 'RD-101') */
  readonly code: string;
  /** Error category */
  readonly category: ErrorCategory;
  /** Short human-readable title */
  readonly title: string;
  /** Detailed description with resolution guidance */
  readonly description: string;
  /**
   * Stable documentation slug for this code (e.g., `'file-not-found'`).
   *
   * **Deliberately has no runtime consumer today, and that is not an
   * oversight — do not "clean it up".** `RundownError` used to render it as
   * `https://rundown.dev/docs/errors/<docSlug>` in `--verbose` text and in the
   * JSON error envelope's `details`. That link was dead for every one of the
   * codes below: `rundown.dev` does not resolve at all, the real site is
   * `rundown.cool` (`site/astro.config.mjs`), and neither host has ever served
   * a `/docs/errors/` route. A URL that has never resolved for any code is
   * worse than no URL, so the field that emitted it was removed.
   *
   * The slug itself survives because it is the durable identifier a future
   * `/docs/errors/` route would key on. Deleting it would be a large mechanical
   * diff with no behavioural benefit, and re-deriving the slugs later would be
   * guesswork. Keep one on every new code, and keep it stable.
   */
  readonly docSlug: string;
}

/**
 * All Rundown error codes.
 */
export const ErrorCodes = {
  // File/IO Errors (1xx)
  FILE_NOT_FOUND: {
    code: 'RD-101',
    category: ErrorCategory.FILE_IO,
    title: 'Runbook file not found',
    description: 'The specified runbook file does not exist or cannot be accessed.',
    docSlug: 'file-not-found',
  },
  FILE_NOT_READABLE: {
    code: 'RD-102',
    category: ErrorCategory.FILE_IO,
    title: 'File not readable',
    description: 'The runbook file exists but cannot be read due to permission restrictions.',
    docSlug: 'file-not-readable',
  },
  STATE_DIR_NOT_ACCESSIBLE: {
    code: 'RD-103',
    category: ErrorCategory.FILE_IO,
    title: 'State directory not accessible',
    description: 'The .rundown directory cannot be accessed or created.',
    docSlug: 'state-dir-not-accessible',
  },

  // Parse/Syntax Errors (2xx)
  EMPTY_RUNBOOK: {
    code: 'RD-201',
    category: ErrorCategory.PARSE_SYNTAX,
    title: 'Empty runbook file',
    description: 'The runbook file contains no content.',
    docSlug: 'empty-runbook',
  },
  NO_STEPS_FOUND: {
    code: 'RD-202',
    category: ErrorCategory.PARSE_SYNTAX,
    title: 'No valid steps found',
    description: 'The runbook file does not contain any valid step headings (## headers).',
    docSlug: 'no-steps-found',
  },
  INVALID_FRONTMATTER: {
    code: 'RD-203',
    category: ErrorCategory.PARSE_SYNTAX,
    title: 'Invalid frontmatter',
    description: 'The YAML frontmatter is malformed or contains invalid syntax.',
    docSlug: 'invalid-frontmatter',
  },
  SYNTAX_ERROR: {
    code: 'RD-204',
    category: ErrorCategory.PARSE_SYNTAX,
    title: 'Runbook syntax error',
    description: 'The runbook file contains invalid syntax.',
    docSlug: 'syntax-error',
  },

  // State Errors (3xx)
  NO_ACTIVE_RUNBOOK: {
    code: 'RD-301',
    category: ErrorCategory.STATE,
    title: 'No active runbook',
    description: 'No runbook is currently running. Start a runbook with "rundown run <file>".',
    docSlug: 'no-active-runbook',
  },
  STATE_PARSE_ERROR: {
    code: 'RD-302',
    category: ErrorCategory.STATE,
    title: 'State file parse error',
    description:
      'The runbook state file contains invalid JSON. Try running "rundown prune" to clean up.',
    docSlug: 'state-parse-error',
  },
  RUNBOOK_COMPLETED: {
    code: 'RD-303',
    category: ErrorCategory.STATE,
    title: 'Runbook already completed',
    description: 'This runbook has already been marked as complete. Start a new run.',
    docSlug: 'runbook-completed',
  },
  RUNBOOK_STOPPED: {
    code: 'RD-304',
    category: ErrorCategory.STATE,
    title: 'Runbook stopped',
    description: 'This runbook was stopped. Start a new run.',
    docSlug: 'runbook-stopped',
  },
  INCOMPATIBLE_STATE_SCHEMA: {
    code: 'RD-305',
    category: ErrorCategory.STATE,
    title: 'Incompatible runbook database schema',
    description:
      'The runbook database uses a schema version this build cannot read, and Rundown never migrates persisted state. Any in-flight runs are unrecoverable — delete `.rundown/rundown.db` and restart your runbooks from source.',
    docSlug: 'incompatible-state-schema',
  },
  WAL_JOURNAL_MODE_UNAVAILABLE: {
    code: 'RD-306',
    category: ErrorCategory.STATE,
    title: 'Runbook database is not in WAL journal mode',
    description:
      "The runbook database did not enter WAL journal mode. SQLite still serializes cross-process writers through file locking in rollback-journal mode, but that mode does not provide WAL's reader/writer concurrency and is not a validated Rundown deployment mode. SQLite returned a non-WAL mode or no readable mode, which narrows the cause to one of: a filesystem whose VFS provides no shared memory (a network mount such as NFS or SMB is the common one), a temporary database opened with no filename, or a connection already inside a write transaction. A read-only database file or directory is NOT among them — that fails the pragma outright and surfaces as RD-307. Establish which applies before moving the project directory.",
    docSlug: 'wal-journal-mode-unavailable',
  },
  STATE_STORE_UNAVAILABLE: {
    code: 'RD-307',
    category: ErrorCategory.STATE,
    title: 'Runbook database unavailable',
    description:
      'The runbook database at .rundown/rundown.db could not be opened, so commands that access persisted run state cannot continue; commands that do not open the store, such as rundown check, remain available. The driver reports the underlying cause verbatim: a read-only database file or directory, a file that is not a database, lock contention that outlasted the bounded timeout and retries, or a host whose SQLite adapter cannot be initialized. Retry after transient lock contention; repair the host or file for persistent failures. Rundown never downgrades to the single-writer sql.js adapter outside WebContainer.',
    docSlug: 'state-store-unavailable',
  },
  // The THROWN face of the same condition the CLI renders as the symbolic
  // `CONCURRENT_MODIFICATION` code. The two are not duplicates and must not be
  // collapsed: a command that receives `StateMutationResult` narrows the
  // `concurrent_modification` arm and renders it itself (symbolic code), whereas
  // `RunbookStateManager`'s throwing seam escapes to the top-level CLI error
  // wrapper, which only speaks RD-NNN. Before this code that escape was RD-999
  // "Unknown error" — the one surface where the condition was undiagnosable.
  CONCURRENT_STATE_MODIFICATION: {
    code: 'RD-308',
    category: ErrorCategory.STATE,
    title: 'Runbook state lost to a concurrent writer',
    description:
      'A run-state conditional save found the run changed since it was read: another of the owner\'s commands committed to the same run first. Nothing was written and the persisted state is intact and consistent. It is never retried on your behalf: re-read the run ("rundown status --run <id>") and re-issue the command.',
    docSlug: 'concurrent-state-modification',
  },
  // The ONE persisted-state refusal CLAUDE.md writes a required behaviour for:
  // "The CLI should detect invalid state (via schema version or structural
  // guard) and prompt the user to finish or prune — never silently adapt".
  // Before this code that instruction was unreachable from the error surface,
  // because `InvalidRunbookStateError` and `LegacySnapshotError` — the two
  // classes `RunbookStateManager.load` raises for exactly that detection —
  // reached the CLI wrapper untyped and rendered as RD-999 "Unknown error".
  //
  // NOT RD-305. That code is the whole DATABASE's schema (`PRAGMA user_version`)
  // and its recovery is "delete .rundown/rundown.db"; this is ONE run row inside
  // an otherwise healthy database, where deleting the database would destroy
  // every other run. Nor RD-302, whose title and description name invalid JSON
  // only — one of the four causes here — and still speak of a "state file" that
  // the single-store cutover removed.
  INVALID_PERSISTED_RUN_STATE: {
    code: 'RD-309',
    category: ErrorCategory.STATE,
    title: 'Invalid persisted run state',
    description:
      'A run in the runbook database does not match the state contract this build reads: unparseable persisted state, a schema version this build does not read, a missing required field such as templateVars, or a deprecated dynamic-step snapshot. Rundown never migrates persisted state, so the run cannot be resumed, completed or stopped, and is never silently repaired. Only that run is affected — the database and every other run in it are intact. Recover by discarding it with "rundown prune --inactive" (a bare "rundown prune" cannot, because its default completed/stopped selection never sees an invalid row), then re-run the runbook from source.',
    docSlug: 'invalid-persisted-run-state',
  },

  // Validation Errors (4xx)
  GOTO_TARGET_NOT_FOUND: {
    code: 'RD-401',
    category: ErrorCategory.VALIDATION,
    title: 'GOTO target not found',
    description: 'The specified step or substep does not exist in the runbook.',
    docSlug: 'goto-target-not-found',
  },
  INVALID_STEP_SEQUENCE: {
    code: 'RD-402',
    category: ErrorCategory.VALIDATION,
    title: 'Invalid step sequence',
    description: 'Step numbers must be sequential starting from 1.',
    docSlug: 'invalid-step-sequence',
  },
  MISSING_REQUIRED_VARS: {
    code: 'RD-403',
    category: ErrorCategory.VALIDATION,
    title: 'Missing required variables',
    description:
      'One or more required variables declared in frontmatter were not provided via CLI flags, config, environment, or delegation.',
    docSlug: 'missing-required-vars',
  },

  // Execution Errors (5xx)
  ENGINE_INIT_FAILED: {
    code: 'RD-501',
    category: ErrorCategory.EXECUTION,
    title: 'Failed to initialize runbook engine',
    description: 'The XState runbook engine could not be initialized.',
    docSlug: 'engine-init-failed',
  },
  RUNBOOK_HAS_NO_STEPS: {
    code: 'RD-502',
    category: ErrorCategory.EXECUTION,
    title: 'Runbook has no steps',
    description: 'The runbook file does not contain any executable steps.',
    docSlug: 'runbook-has-no-steps',
  },
  RUN_PROGRESSION_ENTRY_FAILED: {
    code: 'RD-504',
    category: ErrorCategory.EXECUTION,
    title: 'Run Progression could not render the step entry',
    description:
      `Run Progression selected an execution unit and then could not render ` +
      `its STEP_ENTERED entry. Nothing was consumed and nothing terminal was ` +
      `applied: the run keeps the lifecycle and cursor it had, so re-running ` +
      `the command re-renders the same entry once the cause is fixed. The ` +
      `usual cause is a \`--helpers\` helper raising while expanding the ` +
      `unit's description, prompt, or command.`,
    docSlug: 'run-progression-entry-failed',
  },

  // Command Errors (6xx)
  INVALID_STEP_FORMAT: {
    code: 'RD-601',
    category: ErrorCategory.COMMAND,
    title: 'Invalid step ID format',
    description: 'Step ID must be in format "N" (step) or "N.M" (step.substep).',
    docSlug: 'invalid-step-format',
  },
  MISSING_REQUIRED_ARG: {
    code: 'RD-602',
    category: ErrorCategory.COMMAND,
    title: 'Missing required argument',
    description: 'A required argument was not provided.',
    docSlug: 'missing-required-arg',
  },
  SCENARIO_NOT_FOUND: {
    code: 'RD-603',
    category: ErrorCategory.COMMAND,
    title: 'Scenario not found',
    description: 'The specified scenario does not exist in the runbook.',
    docSlug: 'scenario-not-found',
  },

  // Generic
  UNKNOWN_ERROR: {
    code: 'RD-999',
    category: ErrorCategory.EXECUTION,
    title: 'Unknown error',
    description: 'An unexpected error occurred.',
    docSlug: 'unknown-error',
  },
} as const;

/**
 * Type for error code keys.
 */
export type ErrorCodeKey = keyof typeof ErrorCodes;
