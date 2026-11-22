/**
 * Zod schemas for CLI JSON output - Single Source of Truth.
 *
 * This module defines Zod schemas for all CLI response types. TypeScript types
 * are derived from these schemas using z.infer<>, eliminating duplication
 * between runtime validation and compile-time types.
 *
 * Design principles:
 * - Flat structure: Action-specific fields merged at top level (no nesting)
 * - Predictable: Required fields present in all responses
 * - Actionable: Error responses include machine-readable codes and contextual details
 * - Agent-friendly: Optimized for AI agent consumption (kubectl-inspired patterns)
 *
 * @module output/zod-schemas
 */

import { z } from 'zod';
import { TemplateVarValueSchema } from '../schemas.js';
import { RUN_ID_PATTERN } from '../runbook/run-id.js';
import { PublicArtifactRecordSchema } from '../runbook/artifact-schema.js';
import { RunbookRefSchema } from '../runbook/runbook-ref.js';
import { ErrorCodes } from '../errors/codes.js';

// ============================================================================
// CLI Error Codes
// ============================================================================

/**
 * Every RD-NNN error code registered in the {@link ErrorCodes} factory table.
 *
 * These are the machine-readable codes carried by thrown `RundownError`
 * envelopes. Exposed so drift guards can assert that a documented error code is
 * a registered one (see the docs ↔ enum drift test for `docs/spec/cli-output.md`).
 */
export const RundownErrorCodeValues = Object.values(ErrorCodes).map((code) => code.code) as [
  string,
  ...string[],
];

/**
 * CLI-only symbolic error codes emitted outside the `RundownError` factory path.
 *
 * These codes originate in command validation paths rather than the RD-NNN
 * factory table. Exposed alongside {@link RundownErrorCodeValues} so drift
 * guards can treat the union as the full set of registered CLI error codes.
 */
export const CLISymbolicErrorCodeValues = [
  'RUNBOOK_NOT_FOUND',
  'STEP_NOT_FOUND',
  'INVALID_SYNTAX',
  'VALIDATION_ERROR',
  'INVALID_RUN_ID',
  // One writer per run (ADR 0005): every mutating command names its Owner Token.
  // A bare mutation is refused `TOKEN_REQUIRED`; a token no run carries is
  // `UNKNOWN_TOKEN`; a token on a finished run is RD-303/RD-304.
  'TOKEN_REQUIRED',
  'UNKNOWN_TOKEN',
  // `rundown run` refuses a runbook with a substep listing more than one
  // runbook; a child run whose runbook does so is refused at launch or claim.
  'RUNBOOK_COMPOSITION_UNSUPPORTED',
  // An inline child could not be launched for a reason with no code of its
  // own (#903); preparation failures report their own code.
  'INLINE_CHILD_LAUNCH_FAILED',
  'CONCURRENT_MODIFICATION',
  // Delegation (#904): `claim` of a ticket no reservation carries, or of a
  // child already claimed; a Delegation's command once its parent no longer
  // counts it or finished; `collect` on a step that delegates nothing.
  'UNKNOWN_TICKET',
  'ALREADY_CLAIMED',
  'DELEGATION_CANCELLED',
  'PARENT_RUN_FINISHED',
  'NOTHING_TO_COLLECT',
  // Delegation recovery (#905): `retry` of a substep with no Delegation its
  // parent still counts; `release` by an agent other than the claim's, of a
  // run that is not a Delegation, or of a run id no run carries.
  'NOTHING_TO_RETRY',
  'AGENT_MISMATCH',
  'NOT_A_DELEGATION',
  // Prune protection and the human escape hatch (#906): `prune --token` naming
  // a Current Child its parent still counts; `stop --run` with no human at an
  // interactive terminal, declined by the human, or naming a Child Run.
  'CURRENT_CHILD_PROTECTED',
  'INTERACTIVE_REQUIRED',
  'NOT_CONFIRMED',
  'NOT_A_TOP_LEVEL_RUN',
  // The execution lease (#902): a live attempt holds the run's step, or the
  // attempt that held it died and the decision would pass it.
  'EXECUTION_IN_PROGRESS',
  'EXECUTION_INTERRUPTED',
  // `pass` named a step whose command Run Progression owes but never ran.
  'EXECUTION_PENDING',
  'RUN_TARGET_UNAVAILABLE',
  'INVALID_STEP',
  'INVALID_INDEX',
  'UNSUPPORTED_OPTION',
  'ARTIFACT_CHANNEL_COLLISION',
  'INVALID_ARTIFACT_INPUT',
  'CONFLICTING_INDEX',
  'ENGINE_INIT_FAILED',
  'INVALID_AT_TARGET',
  'SCENARIO_NOT_FOUND',
  'OBSERVATION_DELIVERY_FAILED',
  // Every remaining `PrepareFailure['code']` arm. These reach an envelope
  // verbatim from `prepareRunbook`, through `rundown run` (`run.ts` emits
  // `prepResult.code` directly) and `rundown resolve` — so this is not one
  // command's gap. `RUNBOOK_NOT_FOUND`,
  // `VALIDATION_ERROR`, `ARTIFACT_CHANNEL_COLLISION` and `INVALID_ARTIFACT_INPUT`
  // are the four arms that were already registered above (#834).
  'PARSE_ERROR',
  'RUNBOOK_REF_RESOLUTION_ERROR',
  'VARIABLE_RESOLUTION_ERROR',
  'POLICY_DENIED',
  'MISSING_REQUIRED_VARS',
  'UNKNOWN_ERROR',
] as const;

/**
 * CLI-only symbolic error codes emitted outside the RundownError factory path.
 */
export const CLISymbolicErrorCodes = Object.fromEntries(
  CLISymbolicErrorCodeValues.map((code) => [code, code]),
) as { readonly [Code in (typeof CLISymbolicErrorCodeValues)[number]]: Code };

/**
 * Machine-readable error codes for CLI JSON output.
 *
 * Thrown RundownError envelopes use RD-NNN values from ErrorCodes. Some
 * command validation paths still emit CLI-only symbolic codes directly.
 */
export const CLIErrorCodes = {
  /** No runbook is currently active */
  NO_ACTIVE_RUNBOOK: ErrorCodes.NO_ACTIVE_RUNBOOK.code,
  /** Specified runbook file doesn't exist */
  RUNBOOK_NOT_FOUND: ErrorCodes.FILE_NOT_FOUND.code,
  /** Target step doesn't exist */
  STEP_NOT_FOUND: 'STEP_NOT_FOUND',
  /** Runbook has syntax errors */
  INVALID_SYNTAX: ErrorCodes.SYNTAX_ERROR.code,
  /** Input validation failed */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** Run id format is invalid */
  INVALID_RUN_ID: 'INVALID_RUN_ID',
  /** A mutating command was issued without `--token` (ADR 0005) */
  TOKEN_REQUIRED: 'TOKEN_REQUIRED',
  /** The presented Owner Token matches no run */
  UNKNOWN_TOKEN: 'UNKNOWN_TOKEN',
  /** The runbook composes other runbooks in a form this build does not run (DELEGATE, or a multi-runbook inline substep) */
  RUNBOOK_COMPOSITION_UNSUPPORTED: 'RUNBOOK_COMPOSITION_UNSUPPORTED',
  /** The explicit --run target names no run */
  RUN_TARGET_UNAVAILABLE: 'RUN_TARGET_UNAVAILABLE',
  /** Run-state conditional write lost to a concurrent writer; refused, never retried */
  CONCURRENT_STATE_MODIFICATION: ErrorCodes.CONCURRENT_STATE_MODIFICATION.code,
  /** Scenario not found */
  SCENARIO_NOT_FOUND: ErrorCodes.SCENARIO_NOT_FOUND.code,
  /**
   * A Run Progression activation ended because its observation reporting
   * channel threw (#853). The run rests at its last committed boundary;
   * re-activate once the reporting channel is repaired.
   */
  OBSERVATION_DELIVERY_FAILED: 'OBSERVATION_DELIVERY_FAILED',
  /** Unknown or unexpected error */
  UNKNOWN_ERROR: ErrorCodes.UNKNOWN_ERROR.code,
} as const;

/**
 * Machine-readable warning codes for CLI JSON output.
 *
 * These codes enable programmatic handling of non-error conditions.
 */
export const CLIWarningCodes = {
  /** No runbook is currently active */
  NO_ACTIVE_RUNBOOK: 'NO_ACTIVE_RUNBOOK',
  /** Runbook is already in a terminal lifecycle (idempotent no-op) */
  RUNBOOK_NOT_RUNNING: 'RUNBOOK_NOT_RUNNING',
} as const;

/**
 * Zod schema for error codes.
 */
export const ErrorCodeSchema = z
  .enum([...RundownErrorCodeValues, ...CLISymbolicErrorCodeValues] as [string, ...string[]])
  .describe('Error code identifying the type of error that occurred');

/**
 * Zod schema for warning codes.
 */
export const WarningCodeSchema = z
  // Derived from the single-source CLIWarningCodes const, but typed as the
  // literal value tuple so `z.infer` stays the `CLIWarningCode` union rather
  // than widening to `string`.
  .enum(Object.values(CLIWarningCodes) as [CLIWarningCode, ...CLIWarningCode[]])
  .describe('Warning code identifying the non-error condition that occurred');

/**
 * Union type of all valid CLI error codes.
 */
export type CLIErrorCode =
  | (typeof CLIErrorCodes)[keyof typeof CLIErrorCodes]
  | (typeof CLISymbolicErrorCodes)[keyof typeof CLISymbolicErrorCodes];

/**
 * Union type of all valid CLI warning codes.
 */
export type CLIWarningCode = (typeof CLIWarningCodes)[keyof typeof CLIWarningCodes];

// ============================================================================
// Shared Schemas
// ============================================================================

/**
 * Position within a runbook.
 */
export const PositionSchema = z
  .object({
    /** Current step identifier (e.g., "1", "2", "ErrorHandler") */
    current: z.string().describe('Current step number or identifier'),
    /** Total number of steps */
    total: z.number().describe('Total number of steps'),
    /** Current substep identifier if applicable */
    substep: z.string().optional().describe('Optional substep identifier'),
    /** Expanded execution location (for example "1.2.1") */
    at: z.string().optional().describe('Expanded execution location'),
    /** Active FOR loop scope for loop-scoped positions */
    for: z
      .object({
        /** Current 1-based loop iteration */
        index: z.number().int().positive().describe('Current loop iteration index'),
        /** Optional inclusive loop bound (undefined for open-ended loops) */
        end: z.number().int().positive().optional().describe('Optional loop bound'),
      })
      .optional()
      .describe('Loop scope for this position'),
    /** Active execution frame key (`step|iteration`) */
    frameKey: z.string().optional().describe('Active execution frame key'),
    /** Active execution entry for the frame */
    entry: z.number().int().positive().optional().describe('Active frame entry'),
    /** Count of unresolved substeps in the active frame */
    unresolved: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Number of unresolved substeps in the active frame'),
  })
  .describe('Current position within the runbook execution');

/**
 * Runbook context information included in responses.
 */
export const RunbookContextSchema = z
  .object({
    /** Runbook filename (relative path) */
    file: z.string().describe('Path to the runbook file'),
    /** SQLite run/session authority path. */
    state: z.string().describe('Path to the SQLite run/session authority'),
    /** Run id this context describes; `state` is the same constant for every run. */
    runId: z.string().regex(RUN_ID_PATTERN).optional().describe('Run id this context describes'),
    /** Whether runbook is in prompted mode (waiting for user input) */
    prompted: z.boolean().optional().describe('Whether the runbook is awaiting user input'),
  })
  .describe('Context information about the active runbook');

/**
 * Actionable error details.
 */
export const ErrorDetailsSchema = z
  .object({
    /** The value that was requested but invalid/not found */
    requested: z.string().optional().describe('The item or resource that was requested'),
    /** Available valid options */
    available: z.array(z.string()).optional().describe('List of available options'),
    /** Suggested command to run */
    suggestion: z.string().optional().describe('Suggested resolution or alternative'),
    /** File path related to the error */
    path: z.string().optional().describe('File path related to the error'),
    /** Locations that were searched */
    searchedLocations: z.array(z.string()).optional().describe('Locations that were searched'),
    /** Line number where error occurred */
    line: z.number().optional().describe('Line number where the error occurred'),
    /**
     * Runs whose execution outcome must be recovered, on an
     * `AGGREGATE_RECOVERY_REQUIRED` refusal only.
     *
     * Declared rather than left to `.loose()`: this is the one structured
     * detail payload a refusal carries, and an undeclared field is invisible to
     * every consumer generating a client from the schema.
     */
    runs: z
      .array(
        z.object({
          /** Run whose effect outcome is ambiguous */
          runId: z
            .string()
            .regex(RUN_ID_PATTERN)
            .describe('Run whose execution outcome is unknown'),
          /**
           * Execution epoch that crossed the effect boundary.
           *
           * A recovery consumer addresses a run by `(runId, epoch)`, so both
           * halves must be shapes it can act on: an unconstrained number would
           * admit a fractional or negative epoch that names no attempt.
           */
          epoch: z
            .number()
            .int()
            .nonnegative()
            .describe('Execution epoch that crossed the effect boundary'),
        }),
      )
      .optional()
      .describe('Runs that must be recovered before the refused workflow can resume'),
  })
  .describe('Additional details about an error')
  .loose();

// ============================================================================
// Base Response Schemas
// ============================================================================

/**
 * Base schema for all CLI responses.
 */
export const BaseResponseSchema = z.object({});

/**
 * Successful response base with optional context.
 */
export const SuccessResponseSchema = BaseResponseSchema.extend({
  /** The action performed (e.g., "CONTINUE", "GOTO 3", "stopped") */
  action: z.string().optional().describe('The action performed'),
  /** Runbook context when applicable */
  runbook: RunbookContextSchema.optional().describe('Runbook context'),
});

/**
 * Error response schema.
 */
export const ErrorResponseSchema = z
  .object({
    /** Response kind discriminant */
    kind: z.literal('error').describe('Response type discriminant'),
    /** Human-readable error message */
    error: z.string().describe('Error message describing what went wrong'),
    /** Machine-readable error code for programmatic handling */
    code: ErrorCodeSchema.optional().describe('Error code for programmatic handling'),
    /** CLI command that triggered the error (e.g., 'pass', 'fail', 'goto') */
    command: z.string().optional().describe('CLI command that triggered the error'),
    /** Actionable context to help resolve the error */
    details: ErrorDetailsSchema.optional().describe('Additional error context'),
  })
  .describe('Error response indicating command execution failure')
  .loose();

/**
 * Warning response schema.
 *
 * Used for conditions that are not errors but merit attention — for example,
 * commands run when no runbook is active (exit 0, but no work was performed).
 *
 * Unlike `ErrorResponseSchema`, warning responses exit 0 and carry a `message`
 * field rather than an `error` field. The `code` field is scoped to
 * machine-readable warning codes.
 */
export const WarningResponseSchema = z
  .object({
    /** Response kind discriminant */
    kind: z.literal('warning').describe('Response type discriminant'),
    /** Human-readable warning message */
    message: z.string().describe('Warning message describing the condition'),
    /** Machine-readable warning code for programmatic handling */
    code: WarningCodeSchema.optional().describe('Warning code for programmatic handling'),
    /** CLI command that triggered the warning (e.g., 'pass', 'fail', 'goto') */
    command: z.string().optional().describe('CLI command that triggered the warning'),
  })
  .describe('Warning response for conditions that are not errors but merit attention')
  .loose();

// ============================================================================
// Action Command Schemas (pass, fail, goto, stop, complete)
// ============================================================================

/**
 * Action response schema.
 *
 * Used by: pass, fail, goto, stop, complete
 *
 * The `action` field shows the transition (e.g., "CONTINUE", "GOTO 3", "RETRY").
 * The `stepResult` field shows the step outcome (PASS or FAIL).
 */
export const ActionResponseSchema = z
  .object({
    /** Response kind discriminant */
    kind: z.literal('action').describe('Response type discriminant'),
    /** Step outcome (PASS or FAIL) */
    stepResult: z.enum(['PASS', 'FAIL']).optional().describe('Step outcome (PASS or FAIL)'),
    /** The action that was performed (e.g., "CONTINUE", "GOTO 3", "RETRY") */
    action: z.string().describe('Type of action performed'),
    /** The command that was executed */
    command: z.string().optional().describe('Command executed for this action'),
    /** Step position before the transition (qualified ID) */
    from: z.string().optional().describe('Step position before the transition (qualified ID)'),
    /** Step position after the transition (qualified ID) */
    at: z.string().optional().describe('Step position after the transition (qualified ID)'),
    /** Whether this resulted in runbook completion */
    complete: z.boolean().optional().describe('Whether the runbook completed'),
    /** Whether this resulted in runbook stopping */
    stopped: z.boolean().optional().describe('Whether the runbook was stopped'),
    /** The running Inline Children the human escape hatch stopped with the run (#906) */
    stoppedInline: z
      .array(z.string().regex(RUN_ID_PATTERN))
      .optional()
      .describe('Running inline children stopped with the run by `stop --run`, nearest first'),
    /** Runbook context */
    runbook: RunbookContextSchema.optional().describe('Runbook context information'),
    // Flat format fields
    file: z.string().optional().describe('Path to the runbook file'),
    state: z.string().optional().describe('Path to the SQLite run/session authority'),
    runId: z.string().regex(RUN_ID_PATTERN).optional().describe('Run id this action describes'),
    prompted: z.boolean().optional().describe('Whether awaiting user input'),
    message: z.string().optional().describe('Status message from the action'),
    /** Idempotency status for action-family responses */
    status: z.enum(['already-resolved']).optional().describe('Idempotency status'),
    position: PositionSchema.optional().describe('Current position after action'),
  })
  .describe('Response from a step action command')
  .loose();

// ============================================================================
// Status Command Schema
// ============================================================================

/**
 * Status response schema.
 */
/**
 * A run's execution condition while its step holds the execution lease (#902).
 *
 * Present only while a lease is held. `in_progress`: the process that started
 * the step's command is alive. `interrupted`: that process is gone, so the
 * command's outcome is unknown; Rundown never repeats it and the owner decides
 * with `fail`, `goto` or `stop`. Never carries a token.
 */
export const ExecutionStatusSchema = z
  .object({
    condition: z
      .enum(['in_progress', 'interrupted'])
      .describe('In Progress (holder alive) or Interrupted (holder gone)'),
    step: z.string().describe('Step (`step` or `step.substep`) whose command holds the lease'),
    attempt: z.number().int().describe('The attempt holding the lease'),
    pid: z.number().int().describe('Process that started the command'),
    startedAt: z.string().describe('ISO-8601 time the command started'),
  })
  .describe('Execution lease condition of the run');

/**
 * A Child Run's parent coordinate as status shows it (#903). Run ids and step
 * labels only: status never shows a token or ticket.
 */
export const ParentLinkStatusSchema = z
  .object({
    runId: z.string().regex(RUN_ID_PATTERN).describe('The parent run'),
    step: z.string().describe('Parent unit (`step.substep`) the child runs for'),
    kind: z
      .enum(['inline', 'delegation'])
      .describe('How the child is owned relative to its parent'),
  })
  .describe("The run's parent, when it is a Child Run");

/**
 * The Current Child a run's step counts, as status shows it (#903).
 *
 * `reserved` means the parent reserved the child but no child row exists yet
 * (its launch has not happened, or was refused).
 */
export const CurrentChildStatusSchema = z
  .object({
    runId: z.string().regex(RUN_ID_PATTERN).describe('The reserved child run id'),
    kind: z.literal('inline').describe('How the child is owned relative to this run'),
    status: z
      .enum(['reserved', 'running', 'completed', 'stopped', 'abandoned'])
      .describe('The child lifecycle, or reserved before its row exists'),
  })
  .describe("The Current Child of the run's step");

/**
 * One Delegation of a run's active entry, as status shows it (#904): by id,
 * lifecycle and result only — never a Claim Ticket.
 */
export const DelegationChildStatusSchema = z
  .object({
    runId: z.string().regex(RUN_ID_PATTERN).describe('The reserved child run id'),
    step: z.string().describe('Parent unit (`step.substep`) the child runs for'),
    index: z.number().int().positive().optional().describe('FOR iteration, inside a loop'),
    status: z
      .enum(['reserved', 'running', 'completed', 'stopped', 'abandoned'])
      .describe('The child lifecycle, or reserved before any agent claimed it'),
    result: z.enum(['pass', 'fail']).optional().describe('The Child Result, once terminal'),
  })
  .describe("One Delegation of the run's active entry");

export const StatusResponseSchema = z
  .object({
    /** Response kind discriminant */
    kind: z.literal('status').describe('Response type discriminant'),
    /** Whether the described run is running (detail form) */
    active: z.boolean().describe('Whether the described run is running'),
    /** Runbook context (when active) - for backwards compatibility */
    runbook: RunbookContextSchema.optional().describe('Runbook context'),
    /** Current position in the runbook (when active) */
    position: PositionSchema.optional().describe('Current step position'),
    /**
     * Alias for position.
     * @deprecated Use `position` instead. Will be removed in a future version.
     */
    step: z
      .union([
        PositionSchema,
        z.object({
          name: z.string().describe('Step name or identifier'),
          description: z.string().optional().describe('Step description'),
        }),
      ])
      .optional()
      .describe('Step position or details (deprecated: use position)'),
    /** Current step details */
    currentStep: z
      .object({
        /** Step description/title */
        description: z.string().optional().describe('Step description'),
        /** Command to execute */
        command: z.string().optional().describe('Command to execute'),
      })
      .optional()
      .describe('Current step details'),
    /** Last action performed */
    lastAction: z
      .object({
        /** The action that was performed */
        action: z.string().describe('Last action performed'),
        /** Step outcome of the last action */
        result: z.enum(['PASS', 'FAIL']).optional().describe('Step outcome of the last action'),
      })
      .optional()
      .describe('Last action information'),
    // Flat structure fields
    file: z.string().optional().describe('Path to the active runbook file'),
    state: z.string().optional().describe('Path to the SQLite run authority'),
    runId: z.string().regex(RUN_ID_PATTERN).optional().describe('Run id this status describes'),
    /** Every persisted run (bare `rundown status` list form) */
    runs: z
      .array(z.lazy(() => ActiveRunbookEntrySchema))
      .optional()
      .describe('Every persisted run, when status was asked for no run in particular'),
    prompted: z.boolean().optional().describe('Whether awaiting user input'),
    execution: ExecutionStatusSchema.optional().describe(
      'Present while the run holds the execution lease (In Progress or Interrupted)',
    ),
    parent: ParentLinkStatusSchema.optional(),
    child: CurrentChildStatusSchema.optional(),
    children: z
      .array(DelegationChildStatusSchema)
      .optional()
      .describe("The Delegations of the run's active entry (#904)"),
    humanStop: z
      .object({
        at: z.string().describe('When the human confirmed the stop (ISO 8601)'),
        user: z.string().describe('Login name of the user at the terminal'),
        host: z.string().describe('Host the terminal was on'),
        message: z.string().optional().describe('The stop message: the human’s reason'),
      })
      .optional()
      .describe('Present on a run stopped by the human escape hatch, `stop --run` (#906)'),
    vars: z
      .record(z.string(), z.string())
      .optional()
      .describe('Effective status variables rendered as strings'),
    artifacts: z
      .record(
        z.string(),
        z.union([PublicArtifactRecordSchema, z.array(PublicArtifactRecordSchema)]),
      )
      .optional()
      .describe('Effective artifact variables with uri and path projections'),
  })
  .describe('Response from the status command')
  .loose();

/**
 * One artifact alias bound to a single record, projected for CLI output.
 *
 * Intersects {@link PublicArtifactRecordSchema} with the resolving `alias`, so
 * the entry's `kind` (`artifact-record` / `file-artifact-record`) comes from the
 * underlying record and doubles as its response discriminant.
 */
export const ArtifactAliasEntrySchema = z.intersection(
  PublicArtifactRecordSchema,
  z.object({
    alias: z.string().describe('Artifact alias from the effective variable map'),
  }),
);

/**
 * One artifact alias bound to multiple records, projected for CLI output.
 *
 * Array entries carry a dedicated `kind: 'artifact-array'` discriminant (scalar
 * entries borrow the record's own `kind`) so every non-list artifact response
 * can be narrowed by `kind` alone, per docs/spec/cli-output.md.
 */
export const ArtifactAliasArrayEntrySchema = z.object({
  kind: z.literal('artifact-array').describe('Response discriminant for array-bound aliases'),
  alias: z.string().describe('Artifact alias from the effective variable map'),
  items: z.array(PublicArtifactRecordSchema).describe('Artifacts bound to this alias'),
});

/**
 * Response for `rd artifact ls`: a raw array of scalar and array alias entries.
 *
 * List responses carry no top-level `kind`; each element is self-describing via
 * its own discriminant ({@link ArtifactAliasEntrySchema} /
 * {@link ArtifactAliasArrayEntrySchema}).
 */
export const ArtifactLsResponseSchema = z.array(
  z.union([ArtifactAliasEntrySchema, ArtifactAliasArrayEntrySchema]),
);

/**
 * Response for `rd artifact path`: an alias entry (scalar or array) or a bare
 * manifest-backed record when an exact `rd://` URI is projected. Every member
 * carries a `kind` discriminant.
 */
export const ArtifactPathResponseSchema = z.union([
  ArtifactAliasEntrySchema,
  ArtifactAliasArrayEntrySchema,
  PublicArtifactRecordSchema,
]);

/**
 * Response for `rd artifact uri`: an alias entry (scalar or array). Bare records
 * are not produced because the command always resolves through an alias.
 */
export const ArtifactUriResponseSchema = z.union([
  ArtifactAliasEntrySchema,
  ArtifactAliasArrayEntrySchema,
]);

/**
 * Response for `rd artifact inspect`: an alias entry (scalar or array) or a bare
 * manifest-backed record for an exact `rd://` URI. Every member carries a `kind`
 * discriminant.
 */
export const ArtifactInspectResponseSchema = z.union([
  ArtifactAliasEntrySchema,
  ArtifactAliasArrayEntrySchema,
  PublicArtifactRecordSchema,
]);

// ============================================================================
// List Command Schemas
// ============================================================================

/**
 * Active runbook entry in ls output.
 */
export const ActiveRunbookEntrySchema = z
  .object({
    /**
     * Unique run id. Both producers (`rundown ls`, `rundown prune`) read ids
     * through the store's `assertRunId` edge, so every emitted value is a run
     * id — validated here as one, matching the newer `runId` fields.
     */
    id: z.string().regex(RUN_ID_PATTERN).describe('Unique run identifier'),
    /** Runbook filename */
    runbook: z.string().describe('Runbook filename'),
    /** Current step display (e.g., "1/5", "Step") */
    step: z.string().optional().describe('Current step number'),
    /** Status of the runbook */
    status: z
      .string()
      .optional()
      .describe('Run lifecycle (running, complete, stopped, abandoned, or invalid)'),
    /** Total number of steps */
    total: z.number().optional().describe('Total number of steps'),
    /** Runbook title from metadata */
    title: z.string().optional().describe('Runbook title from metadata'),
    /** Execution lease condition, present while the run holds the lease (#902) */
    execution: ExecutionStatusSchema.optional().describe(
      'Present while the run holds the execution lease (In Progress or Interrupted)',
    ),
    /** The parent coordinate, present for a Child Run (#903) */
    parent: ParentLinkStatusSchema.optional(),
  })
  .describe('Active runbook state entry');

/**
 * Available runbook entry in ls --all output.
 */
export const AvailableRunbookEntrySchema = z
  .object({
    /** Runbook name from frontmatter */
    name: z.string().describe('Runbook name from metadata or filename'),
    /** Runbook description */
    description: z.string().optional().describe('Runbook description from metadata'),
    /** Path to runbook file */
    path: z.string().describe('File path to the runbook'),
  })
  .describe('Available runbook file entry');

/**
 * List of active runbooks.
 */
export const ActiveRunbookListSchema = z
  .array(ActiveRunbookEntrySchema)
  .describe('List of active runbook state entries');

/**
 * List of available runbooks.
 */
export const AvailableRunbooksListSchema = z
  .array(AvailableRunbookEntrySchema)
  .describe('List of available runbook files');

// ============================================================================
// Check Command Schemas
// ============================================================================

/**
 * Validation error from runbook validation (check command).
 */
export const CheckValidationErrorSchema = z
  .object({
    /** Human-readable error message */
    message: z.string().describe('Error message'),
    /** Line number where error occurred (if applicable) */
    line: z.number().optional().describe('Line number where error occurred'),
  })
  .describe('Validation error entry');

/**
 * Runbook statistics from validation.
 */
export const RunbookStatsSchema = z
  .object({
    /** Total number of steps */
    steps: z.number().describe('Total number of steps'),
    /** Total number of substeps */
    substeps: z.number().describe('Total number of substeps'),
  })
  .describe('Runbook statistics');

/**
 * Validation warning from runbook validation (check command).
 */
export const CheckValidationWarningSchema = z
  .object({
    /** Human-readable warning message */
    message: z.string().describe('Warning message'),
    /** Line number where warning occurred (if applicable) */
    line: z.number().optional().describe('Line number where warning occurred'),
    /** Warning category for type-safe filtering */
    kind: z.string().optional().describe('Warning kind for type-safe filtering'),
  })
  .describe('Validation warning entry');

/**
 * Check response schema.
 */
export const CheckResponseSchema = z
  .object({
    /** Response kind discriminant */
    kind: z.literal('check').describe('Response type discriminant'),
    /** Whether the runbook is valid */
    valid: z.boolean().describe('Whether the runbook is valid'),
    /** List of validation errors (empty if valid) */
    errors: z.array(CheckValidationErrorSchema).describe('List of validation errors'),
    /** List of validation warnings */
    warnings: z
      .array(CheckValidationWarningSchema)
      .optional()
      .describe('List of validation warnings'),
    /** Runbook statistics (only present when valid) */
    stats: RunbookStatsSchema.optional().describe('Runbook statistics'),
  })
  .describe('Response from the check command');

// ============================================================================
// Resolve Command Schemas
// ============================================================================

/**
 * Data source information from resolve command.
 */
export const ResolveSourceInfoSchema = z.discriminatedUnion('kind', [
  z
    .object({
      /** Source type: in-memory array */
      kind: z.literal('array').describe('In-memory array source'),
      /** Number of items in the source */
      items: z.number().int().nonnegative().describe('Number of items in the source'),
    })
    .describe('Array data source'),
  z
    .object({
      /** Source type: file-backed */
      kind: z.literal('file').describe('File-backed source'),
      /** File path for file-backed sources */
      path: z.string().describe('File path for file-backed sources'),
      /** File format for file-backed sources */
      format: z.enum(['text', 'jsonl']).describe('File format for file-backed sources'),
    })
    .describe('File data source'),
]);

/**
 * Resolve response schema.
 *
 * Result of running the full variable/source resolution pipeline
 * without executing the runbook.
 */
export const ResolveResponseSchema = z
  .object({
    /** Response kind discriminant */
    kind: z.literal('resolve').describe('Response type discriminant'),
    /** Whether the runbook resolved without errors */
    valid: z.boolean().describe('Whether the runbook resolved without errors'),
    /** Structural and resolution errors */
    errors: z
      .array(CheckValidationErrorSchema)
      .describe('List of validation and resolution errors'),
    /** Warnings (including unresolved variables) */
    warnings: z.array(CheckValidationWarningSchema).optional().describe('List of warnings'),
    /** Runbook statistics (only present when structurally valid) */
    stats: RunbookStatsSchema.optional().describe('Runbook statistics'),
    /** Resolved template variables */
    variables: z
      .record(z.string(), TemplateVarValueSchema)
      .optional()
      .describe('Resolved template variables'),
    /** Data sources for FOR loop iteration */
    sources: z
      .record(z.string(), ResolveSourceInfoSchema)
      .optional()
      .describe('Resolved data sources'),
    /** Unresolved template variable names */
    unresolved: z.array(z.string()).optional().describe('Unresolved template variable names'),
  })
  .describe('Response from the resolve command');

// ============================================================================
// Scenario Command Schemas
// ============================================================================

/**
 * Scenario entry in scenario ls output.
 */
export const ScenarioEntrySchema = z
  .object({
    /** Scenario name */
    name: z.string().describe('Scenario name'),
    /** Expected result (e.g., "COMPLETE", "STOPPED") */
    expected: z.string().describe('Expected scenario outcome'),
    /** Scenario description */
    description: z.string().optional().describe('Scenario description'),
    /** Tags as comma-separated string */
    tags: z.string().optional().describe('Comma-separated scenario tags'),
  })
  .describe('Scenario definition');

/**
 * Detailed scenario information from scenario show.
 */
export const ScenarioDetailSchema = ScenarioEntrySchema.extend({
  /** Commands to execute */
  commands: z.array(z.string()).optional().describe('List of commands in the scenario'),
}).describe('Response from scenario show command');

/**
 * Scenario list.
 */
export const ScenarioListSchema = z
  .array(ScenarioEntrySchema)
  .describe('List of scenarios in a runbook');

/**
 * Schema for a single step transition assertion as specified in the scenario.
 */
export const StepAssertionInputSchema = z
  .object({
    /** Current step position */
    at: z.string().optional().describe('Current step position'),
    /** Previous step position */
    from: z.string().optional().describe('Previous step position'),
    /** Transition action */
    action: z.string().optional().describe('Transition action type'),
    /** Step result */
    result: z.enum(['PASS', 'FAIL']).optional().describe('Step result'),
    /** Command executed */
    command: z.string().optional().describe('Command executed'),
    /** Whether the transition was produced by aggregation */
    aggregated: z.boolean().optional().describe('Whether transition came from aggregation'),
  })
  .describe('Step transition assertion from scenario definition');

/**
 * Schema for a captured step transition event from JSON output.
 */
export const CapturedTransitionSchema = z
  .object({
    /** Transition action */
    action: z.string().optional().describe('Transition action type'),
    /** Previous step position */
    from: z.string().optional().describe('Previous step position'),
    /** Current step position */
    at: z.string().optional().describe('Current step position'),
    /** Step result */
    result: z.enum(['PASS', 'FAIL']).optional().describe('Step result'),
    /** Command executed */
    command: z.string().optional().describe('Command executed'),
    /** Whether the transition was produced by aggregation */
    aggregated: z.boolean().optional().describe('Whether transition came from aggregation'),
  })
  .describe('Captured step transition from execution');

/**
 * Step assertion result from matching against the event stream.
 */
export const ScenarioStepAssertionResultSchema = z
  .object({
    /** The assertion that was evaluated */
    assertion: StepAssertionInputSchema.describe('The assertion that was evaluated'),
    /** Whether a matching event was found */
    matched: z.boolean().describe('Whether a matching event was found'),
    /** The event that matched (if any) */
    matchedEvent: CapturedTransitionSchema.optional().describe('The event that matched'),
  })
  .describe('Result of matching a step assertion against the event stream');

/**
 * Schema for a single JSON error assertion as specified in the scenario.
 */
export const ErrorAssertionInputSchema = z
  .object({
    /** Error code */
    code: z.string().optional().describe('Error code'),
    /** CLI command that triggered the error */
    command: z.string().optional().describe('Command that triggered the error'),
    /** Error message substring */
    error: z.string().optional().describe('Error message substring'),
  })
  .describe('Error assertion from scenario definition');

/**
 * Schema for a captured JSON error response.
 */
export const CapturedErrorSchema = z
  .object({
    /** Error code */
    code: z.string().optional().describe('Error code'),
    /** Human-readable error message */
    error: z.string().optional().describe('Error message'),
    /** CLI command that triggered the error */
    command: z.string().optional().describe('Command that triggered the error'),
  })
  .describe('Captured error response from command execution');

/**
 * Error assertion result from matching against JSON error responses.
 */
export const ScenarioErrorAssertionResultSchema = z
  .object({
    /** The assertion that was evaluated */
    assertion: ErrorAssertionInputSchema.describe('The assertion that was evaluated'),
    /** Whether a matching error was found */
    matched: z.boolean().describe('Whether a matching error was found'),
    /** The error that matched (if any) */
    matchedError: CapturedErrorSchema.optional().describe('The error that matched'),
  })
  .describe('Result of matching an error assertion against captured errors');

/**
 * Schema for a single JSON warning assertion as specified in the scenario.
 */
export const WarningAssertionInputSchema = z
  .object({
    /** Warning code */
    code: z.string().optional().describe('Warning code'),
    /** CLI command that triggered the warning */
    command: z.string().optional().describe('Command that triggered the warning'),
    /** Warning message substring */
    message: z.string().optional().describe('Warning message substring'),
  })
  .describe('Warning assertion from scenario definition');

/**
 * Schema for a captured JSON warning response.
 */
export const CapturedWarningSchema = z
  .object({
    /** Warning code */
    code: z.string().optional().describe('Warning code'),
    /** Human-readable warning message */
    message: z.string().optional().describe('Warning message'),
    /** CLI command that triggered the warning */
    command: z.string().optional().describe('Command that triggered the warning'),
  })
  .describe('Captured warning response from command execution');

/**
 * Warning assertion result from matching against JSON warning responses.
 */
export const ScenarioWarningAssertionResultSchema = z
  .object({
    /** The assertion that was evaluated */
    assertion: WarningAssertionInputSchema.describe('The assertion that was evaluated'),
    /** Whether a matching warning was found */
    matched: z.boolean().describe('Whether a matching warning was found'),
    /** The warning that matched (if any) */
    matchedWarning: CapturedWarningSchema.optional().describe('The warning that matched'),
  })
  .describe('Result of matching a warning assertion against captured warnings');

/**
 * Schema for a single artifact assertion as specified in the scenario.
 */
export const ArtifactAssertionInputSchema = z
  .object({
    /** Qualified entered step position (normalized to string by the CLI parser) */
    at: z.string().optional().describe('Entered step position'),
    /** ARTIFACTS alias to match (non-empty; CLI parser rejects empty aliases) */
    alias: z.string().min(1).describe('Artifact alias'),
    /** Artifact record kind to match */
    kind: z
      .enum(['artifact-record', 'file-artifact-record'])
      .optional()
      .describe('Artifact record kind'),
    /** Artifact key to match */
    key: z.string().optional().describe('Artifact key'),
    /** Runbook path suffix to match */
    runbook: z.string().optional().describe('Runbook path suffix'),
    /** Expected file existence */
    exists: z.boolean().optional().describe('Expected file existence'),
    /** Expected number of records for the alias */
    count: z.number().int().nonnegative().optional().describe('Expected artifact count'),
  })
  .describe('Artifact assertion from scenario definition');

/**
 * Schema for a captured step-entered artifact working set.
 */
export const CapturedArtifactEntrySchema = z
  .object({
    /** Qualified entered step position */
    at: z.string().optional().describe('Entered step position'),
    /** Artifact working set keyed by ARTIFACTS alias */
    artifacts: z
      .record(
        z.string(),
        z.union([PublicArtifactRecordSchema, z.array(PublicArtifactRecordSchema)]),
      )
      .describe('Artifact working set keyed by alias'),
    /** Runbook that produced the entered event */
    runbook: RunbookRefSchema.optional().describe('Runbook that produced the event'),
  })
  .describe('Captured artifact working set from a step_entered event');

/**
 * Artifact assertion result from matching against step-entered artifact working sets.
 */
export const ScenarioArtifactAssertionResultSchema = z
  .object({
    /** The assertion that was evaluated */
    assertion: ArtifactAssertionInputSchema.describe('The assertion that was evaluated'),
    /** Whether a matching artifact working set was found */
    matched: z.boolean().describe('Whether a matching artifact was found'),
    /** The artifact entry that matched (if any) */
    matchedEntry: CapturedArtifactEntrySchema.optional().describe('The entry that matched'),
    /** The artifact records that matched (if any) */
    matchedRecords: z
      .array(PublicArtifactRecordSchema)
      .optional()
      .describe('The artifact records that matched'),
  })
  .describe('Result of matching an artifact assertion against captured artifacts');

/**
 * Scenario run result.
 */
export const ScenarioRunResponseSchema = z
  .object({
    /** Response kind discriminant */
    kind: z.literal('scenario_run').describe('Response type discriminant'),
    /** Whether the scenario passed */
    result: z.boolean().describe('Whether the scenario passed'),
    /** Scenario name */
    scenario: z.string().describe('Scenario name'),
    /** Expected outcome */
    expected: z.string().describe('Expected outcome'),
    /** Actual outcome */
    actual: z.string().describe('Actual outcome'),
    /** Detailed message */
    message: z.string().optional().describe('Additional status message'),
    /** Per-step assertion results (present when expect.steps block is used) */
    stepAssertions: z
      .array(ScenarioStepAssertionResultSchema)
      .optional()
      .describe('Per-step assertion results'),
    /** Per-error assertion results (present when expect.errors block is used) */
    errorAssertions: z
      .array(ScenarioErrorAssertionResultSchema)
      .optional()
      .describe('Per-error assertion results'),
    /** Per-warning assertion results (present when expect.warnings block is used) */
    warningAssertions: z
      .array(ScenarioWarningAssertionResultSchema)
      .optional()
      .describe('Per-warning assertion results'),
    /** Warnings emitted by commands that were not matched by expect.warnings */
    unassertedWarnings: z
      .array(CapturedWarningSchema)
      .optional()
      .describe('Warnings not covered by warning assertions'),
    /** Per-artifact assertion results (present when expect.artifacts block is used) */
    artifactAssertions: z
      .array(ScenarioArtifactAssertionResultSchema)
      .optional()
      .describe('Per-artifact assertion results'),
  })
  .describe('Response from scenario run command');

/**
 * Scenario error response.
 */
export const ScenarioErrorResponseSchema = z
  .object({
    error: z.literal(true).describe('Always true for error responses'),
    message: z.string().describe('Error message'),
    available: z.array(z.string()).optional().describe('Available scenarios'),
  })
  .describe('Scenario error response');

// ============================================================================
// Echo Command Schema
// ============================================================================

/**
 * Echo response schema.
 */
export const EchoResponseSchema = z
  .object({
    /** Response kind discriminant */
    kind: z.literal('echo').describe('Response type discriminant'),
    /** Whether the operation succeeded */
    result: z.boolean().describe('Whether the echo command succeeded'),
    /** The echoed output */
    output: z.string().optional().describe('Echoed output text'),
    /** Error message if failed */
    error: z.string().optional().describe('Error message if command failed'),
    /** Exit code */
    exitCode: z.number().optional().describe('Exit code of the echo command'),
  })
  .describe('Response from the echo command');

// ============================================================================
// Prune Command Schema
// ============================================================================

/**
 * Prune response schema.
 *
 * Uses the `ls` entry shape plus an optional `retained` reason, one row per
 * run that was (or would be) pruned or was selected but kept.
 */
export const PruneResponseSchema = z
  .array(
    ActiveRunbookEntrySchema.extend({
      /**
       * Present on a run that was selected but kept (#906): `"token required"`
       * for a running top-level run no `--token` names and no human at a
       * terminal confirmed, `"not confirmed"` for one the human declined,
       * `"child run"` for a running child run (never offered for
       * confirmation), `"uncollected"` for a terminal Current Child whose
       * running parent has not Collected it, `"current child"` for a running
       * one, `"parent unreadable"` for a delegation whose running parent's
       * runbook could not be parsed, and `"execution in progress"` for a run
       * with an attempt In Progress in its inline chain.
       */
      retained: z
        .enum([
          'token required',
          'not confirmed',
          'child run',
          'uncollected',
          'current child',
          'parent unreadable',
          'execution in progress',
        ])
        .optional()
        .describe('Why a selected run was kept rather than deleted'),
      /**
       * With `retained: "child run"`, the recoveries that reach the child;
       * with `"parent unreadable"`, why the parent could not be read.
       */
      detail: z
        .string()
        .optional()
        .describe('What to do about a retained child run, or why its parent is unreadable'),
      /**
       * On a running run deleted without its Owner Token: the human who
       * confirmed it at an interactive terminal. The row is gone, so the
       * command's output is the record.
       */
      confirmedBy: z
        .object({
          at: z.string().describe('ISO-8601 time the human confirmed the delete'),
          user: z.string().describe('Login name of the user at the terminal'),
          host: z.string().describe('Host the terminal was on'),
        })
        .strict()
        .optional()
        .describe('The human who confirmed deleting this running run without its token'),
    }),
  )
  .describe('Runs that were/would be pruned, plus each selected run retained, with its reason');

// ============================================================================
// Execution Summary Schema
// ============================================================================

/**
 * Execution summary schema.
 *
 * Output from commands that use JSONSubscriber.getSummary() like goto.
 * Note: events is required because getSummary() always returns it.
 */
export const ExecutionSummarySchema = z
  .object({
    /** Response kind discriminant */
    kind: z.literal('execution_summary').describe('Response type discriminant'),
    runbookId: z.string().optional().describe('Runbook state identifier'),
    runbook: z.string().optional().describe('Runbook filename'),
    status: z.enum(['complete', 'stopped', 'running']).describe('Execution status'),
    stepsExecuted: z.number().describe('Number of steps executed'),
    commandsRun: z.number().describe('Number of commands run'),
    commandsFailed: z.number().describe('Number of commands that failed'),
    finalPosition: PositionSchema.optional().describe('Final execution position'),
    message: z.string().optional().describe('Execution message'),
    events: z.array(z.any()).describe('Execution events (RunbookEventV1 objects)'),
  })
  .describe('Response from commands with execution summary')
  .loose();

/**
 * Combined run command response schema.
 */
export const RunCommandResponseSchema = ExecutionSummarySchema.extend({
  /** Response kind discriminant (overrides base execution_summary) */
  kind: z.literal('run').describe('Response type discriminant'),
}).describe('Response from the run command');

// ============================================================================
// Scenario Suite Schemas
// ============================================================================

/**
 * Scenario suite case entry for ls output.
 */
export const ScenarioSuiteCaseEntrySchema = z
  .object({
    /** Case name */
    name: z.string().describe('Case name'),
    /** Target runbook file */
    file: z.string().describe('Target runbook file path'),
    /** Expected result */
    expected: z.string().describe('Expected scenario outcome'),
    /** Case description */
    description: z.string().optional().describe('Case description'),
    /** Tags as comma-separated string */
    tags: z.string().optional().describe('Comma-separated case tags'),
  })
  .describe('Scenario suite case entry');

/**
 * Scenario suite list output.
 */
export const ScenarioSuiteListSchema = z
  .array(ScenarioSuiteCaseEntrySchema)
  .describe('List of cases in a scenario suite');

/**
 * Scenario suite case detail (includes commands).
 */
export const ScenarioSuiteCaseDetailSchema = ScenarioSuiteCaseEntrySchema.extend({
  /** Commands to execute */
  commands: z.array(z.string()).optional().describe('List of commands in the case'),
}).describe('Detailed case information from a scenario suite');

/**
 * Scenario suite run aggregate response.
 */
export const ScenarioSuiteRunResponseSchema = z
  .object({
    /** Response kind discriminant */
    kind: z.literal('scenario_suite_run').describe('Response type discriminant'),
    /** Whether all cases passed */
    result: z.boolean().describe('Whether all cases passed'),
    /** Suite name */
    suite: z.string().describe('Suite name'),
    /** Total number of cases run */
    total: z.number().int().nonnegative().describe('Total cases run'),
    /** Number of cases that passed */
    passed: z.number().int().nonnegative().describe('Cases passed'),
    /** Number of cases that failed */
    failed: z.number().int().nonnegative().describe('Cases failed'),
    /** Per-case results */
    cases: z.array(ScenarioRunResponseSchema).describe('Individual case results'),
  })
  .superRefine((data, ctx) => {
    if (data.total !== data.cases.length) {
      ctx.addIssue({
        code: 'custom',
        message: `total (${String(data.total)}) must equal cases.length (${String(data.cases.length)})`,
        path: ['total'],
      });
    }
    if (data.passed + data.failed !== data.total) {
      ctx.addIssue({
        code: 'custom',
        message: `passed (${String(data.passed)}) + failed (${String(data.failed)}) must equal total (${String(data.total)})`,
        path: ['passed'],
      });
    }
    const actualPassed = data.cases.filter((c) => c.result).length;
    if (data.passed !== actualPassed) {
      ctx.addIssue({
        code: 'custom',
        message: `passed (${String(data.passed)}) must equal number of cases with result === true (${String(actualPassed)})`,
        path: ['passed'],
      });
    }
    const actualFailed = data.cases.filter((c) => !c.result).length;
    if (data.failed !== actualFailed) {
      ctx.addIssue({
        code: 'custom',
        message: `failed (${String(data.failed)}) must equal number of cases with result === false (${String(actualFailed)})`,
        path: ['failed'],
      });
    }
  })
  .describe('Aggregate response from running a scenario suite');

// ============================================================================
// Derived TypeScript Types
// ============================================================================

/** Position within a runbook */
export type Position = z.infer<typeof PositionSchema>;

/** Runbook context information */
export type RunbookContext = z.infer<typeof RunbookContextSchema>;

/** Actionable error details */
export type ErrorDetails = z.infer<typeof ErrorDetailsSchema>;

/** Base response with result field */
export type BaseResponse = z.infer<typeof BaseResponseSchema>;

/** Successful response */
export type SuccessResponse = z.infer<typeof SuccessResponseSchema>;

/** Error response */
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/** Warning response (non-error, exit 0 conditions) */
export type WarningResponse = z.infer<typeof WarningResponseSchema>;

/** Action response (pass, fail, goto, stop, complete) */
export type ActionResponse = z.infer<typeof ActionResponseSchema>;

/** Status response */
export type StatusResponse = z.infer<typeof StatusResponseSchema>;
/** Execution lease condition rendered by `status` (#902). */
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;
/** A Child Run's parent coordinate in status output (#903). */
export type ParentLinkStatus = z.infer<typeof ParentLinkStatusSchema>;
/** The Current Child of a run's step in status output (#903). */
export type CurrentChildStatus = z.infer<typeof CurrentChildStatusSchema>;

/** Artifact alias entry response item */
export type ArtifactAliasEntry = z.infer<typeof ArtifactAliasEntrySchema>;

/** Artifact alias array entry response item */
export type ArtifactAliasArrayEntry = z.infer<typeof ArtifactAliasArrayEntrySchema>;

/** Artifact ls response */
export type ArtifactLsResponse = z.infer<typeof ArtifactLsResponseSchema>;

/** Artifact path response */
export type ArtifactPathResponse = z.infer<typeof ArtifactPathResponseSchema>;

/** Artifact uri response */
export type ArtifactUriResponse = z.infer<typeof ArtifactUriResponseSchema>;

/** Artifact inspect response */
export type ArtifactInspectResponse = z.infer<typeof ArtifactInspectResponseSchema>;

/** Active runbook entry */
export type ActiveRunbookEntry = z.infer<typeof ActiveRunbookEntrySchema>;

/** Available runbook entry */
export type AvailableRunbookEntry = z.infer<typeof AvailableRunbookEntrySchema>;

/** List response type */
export type ListResponse = ActiveRunbookEntry[] | AvailableRunbookEntry[];

/** Validation error from check command */
export type CheckValidationError = z.infer<typeof CheckValidationErrorSchema>;

/** Validation warning from check command */
export type CheckValidationWarning = z.infer<typeof CheckValidationWarningSchema>;

/** Runbook statistics */
export type RunbookStats = z.infer<typeof RunbookStatsSchema>;

/** Check response */
export type CheckResponse = z.infer<typeof CheckResponseSchema>;

/** Resolve source info */
export type ResolveSourceInfo = z.infer<typeof ResolveSourceInfoSchema>;

/** Resolve response */
export type ResolveResponse = z.infer<typeof ResolveResponseSchema>;

/** Scenario entry */
export type ScenarioEntry = z.infer<typeof ScenarioEntrySchema>;

/** Scenario detail */
export type ScenarioDetail = z.infer<typeof ScenarioDetailSchema>;

/** Step assertion input */
export type StepAssertionInput = z.infer<typeof StepAssertionInputSchema>;

/** Captured transition */
export type CapturedTransition = z.infer<typeof CapturedTransitionSchema>;

/** Step assertion result */
export type ScenarioStepAssertionResult = z.infer<typeof ScenarioStepAssertionResultSchema>;

/** Artifact assertion input */
export type ArtifactAssertionInput = z.infer<typeof ArtifactAssertionInputSchema>;

/** Captured artifact working set */
export type CapturedArtifactEntry = z.infer<typeof CapturedArtifactEntrySchema>;

/** Artifact assertion result */
export type ScenarioArtifactAssertionResult = z.infer<typeof ScenarioArtifactAssertionResultSchema>;

/** Scenario run response */
export type ScenarioRunResponse = z.infer<typeof ScenarioRunResponseSchema>;

/** Scenario suite case entry */
export type ScenarioSuiteCaseEntry = z.infer<typeof ScenarioSuiteCaseEntrySchema>;

/** Scenario suite case detail */
export type ScenarioSuiteCaseDetail = z.infer<typeof ScenarioSuiteCaseDetailSchema>;

/** Scenario suite run response */
export type ScenarioSuiteRunResponse = z.infer<typeof ScenarioSuiteRunResponseSchema>;

/** Echo response */
export type EchoResponse = z.infer<typeof EchoResponseSchema>;

/** Prune response (same as active runbook list) */
export type PruneResponse = z.infer<typeof PruneResponseSchema>;

/** Execution summary */
export type ExecutionSummary = z.infer<typeof ExecutionSummarySchema>;

/** Run command response */
export type RunCommandResponse = z.infer<typeof RunCommandResponseSchema>;

/** Union of all CLI responses */
export type CLIResponse =
  | ActionResponse
  | ErrorResponse
  | WarningResponse
  | StatusResponse
  | CheckResponse
  | ResolveResponse
  | ScenarioRunResponse
  | ScenarioSuiteRunResponse
  | EchoResponse;

/** Union of list outputs */
export type CLIListResponse =
  | ListResponse
  | ScenarioEntry[]
  | ScenarioSuiteCaseEntry[]
  | PruneResponse;
