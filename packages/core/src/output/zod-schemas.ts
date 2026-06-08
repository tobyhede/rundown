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
import { CLAIM_ID_PATTERN } from '../runbook/claim-id.js';
import { DELEGATION_TOKEN_PATTERN } from '../runbook/delegation-token.js';
import { PublicArtifactRecordSchema } from '../runbook/artifact-schema.js';
import { RunbookRefSchema } from '../runbook/runbook-ref.js';
import { ErrorCodes } from '../errors/codes.js';

// ============================================================================
// CLI Error Codes
// ============================================================================

const RundownErrorCodeValues = Object.values(ErrorCodes).map((code) => code.code) as [
  string,
  ...string[],
];

const CLISymbolicErrorCodeValues = [
  'RUNBOOK_NOT_FOUND',
  'STEP_NOT_FOUND',
  'INVALID_SYNTAX',
  'VALIDATION_ERROR',
  'ALREADY_STASHED',
  'NO_STASHED_RUNBOOK',
  'INVALID_CLAIM_ID',
  'CLAIMED_RUNBOOK_UNAVAILABLE',
  'DELEGATION_RESULT_CONFLICT',
  'CHILD_RUN_MISSING',
  'CHILD_LINKAGE_MISMATCH',
  'INVALID_TOKEN',
  'TOKEN_NOT_FOUND',
  'DELEGATION_CANCELLED',
  'DELEGATION_LOCK_TIMEOUT',
  'INVALID_STEP',
  'INVALID_INDEX',
  'NOT_DELEGATE_STEP',
  'SUBSTEPS_NOT_RESOLVED',
  'DELEGATION_ALREADY_RESOLVED',
  'DELEGATION_ALREADY_EXISTS',
  'CONFLICTING_INDEX',
  'ENGINE_INIT_FAILED',
  'INVALID_AT_TARGET',
  'SCENARIO_NOT_FOUND',
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
  STEP_NOT_FOUND: ErrorCodes.DELEGATION_STEP_NOT_FOUND.code,
  /** Runbook has syntax errors */
  INVALID_SYNTAX: ErrorCodes.SYNTAX_ERROR.code,
  /** Input validation failed */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** A runbook is already stashed */
  ALREADY_STASHED: 'ALREADY_STASHED',
  /** No stashed runbook to restore */
  NO_STASHED_RUNBOOK: 'NO_STASHED_RUNBOOK',
  /** Claim id format is invalid */
  INVALID_CLAIM_ID: 'INVALID_CLAIM_ID',
  /** Claimed runbook is missing, terminal, or otherwise unavailable */
  CLAIMED_RUNBOOK_UNAVAILABLE: 'CLAIMED_RUNBOOK_UNAVAILABLE',
  /** A pass/fail contradicts the terminal outcome of a resolved delegated child */
  DELEGATION_RESULT_CONFLICT: 'DELEGATION_RESULT_CONFLICT',
  /** Child run state file is missing on disk (transient — pruning may help) */
  CHILD_RUN_MISSING: 'CHILD_RUN_MISSING',
  /** Child runbook's persisted parentLinkage diverges from the freshly token-validated linkage (state corruption — operator intervention required) */
  CHILD_LINKAGE_MISMATCH: 'CHILD_LINKAGE_MISMATCH',
  /** Delegation token format is invalid */
  INVALID_TOKEN: ErrorCodes.INVALID_TOKEN.code,
  /** Delegation token was not found */
  TOKEN_NOT_FOUND: ErrorCodes.TOKEN_NOT_FOUND.code,
  /** Delegation token was cancelled */
  DELEGATION_CANCELLED: ErrorCodes.TOKEN_CANCELLED.code,
  /** Delegation lock could not be acquired */
  DELEGATION_LOCK_TIMEOUT: ErrorCodes.DELEGATION_LOCK_TIMEOUT.code,
  /** Nested delegation forbidden (claimed child cannot delegate further) */
  DELEGATION_NESTED_FORBIDDEN: ErrorCodes.DELEGATION_NESTED_FORBIDDEN.code,
  /** Targeted step has no substep marked DELEGATE */
  DELEGATION_NO_DELEGATABLE_SUBSTEP: ErrorCodes.DELEGATION_NO_DELEGATABLE_SUBSTEP.code,
  /** Runbook launch failed */
  LAUNCH_FAILED: ErrorCodes.LAUNCH_FAILED.code,
  /** Fresh claim launch violated write-side invariants */
  CLAIM_INVARIANT_VIOLATED: ErrorCodes.CLAIM_INVARIANT_VIOLATED.code,
  /** Requested child runbook does not match the authored DELEGATE target */
  DELEGATION_RUNBOOK_MISMATCH: ErrorCodes.DELEGATION_RUNBOOK_MISMATCH.code,
  /** Retry refused because a child run is still linked */
  DELEGATION_IN_FLIGHT: ErrorCodes.DELEGATION_IN_FLIGHT.code,
  /** Scenario not found */
  SCENARIO_NOT_FOUND: ErrorCodes.SCENARIO_NOT_FOUND.code,
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
    /** State file path */
    state: z.string().describe('Current runbook state or status'),
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
    /** Runbook context */
    runbook: RunbookContextSchema.optional().describe('Runbook context information'),
    // Flat format fields
    file: z.string().optional().describe('Path to the runbook file'),
    state: z.string().optional().describe('Runbook state after action'),
    prompted: z.boolean().optional().describe('Whether awaiting user input'),
    message: z.string().optional().describe('Status message from the action'),
    /** Idempotency status for action-family responses */
    status: z.enum(['already-resolved']).optional().describe('Idempotency status'),
    position: PositionSchema.optional().describe('Current position after action'),
  })
  .describe('Response from a step action command')
  .loose();

// ============================================================================
// Delegation Status Schema
// ============================================================================

/**
 * Delegation status entry for status display.
 */
export const DelegationStatusEntrySchema = z
  .object({
    /** Substep ID that owns the delegation (e.g., "1.1") */
    substep: z.string().describe('Substep ID owning the delegation'),
    /** Path to the child runbook */
    runbook: z.string().describe('Child runbook path'),
    /** Current delegation state */
    state: z
      .enum(['pending', 'claimed', 'cancelled'])
      .describe('Delegation state: pending, claimed, or cancelled'),
    /** Child run ID (when claimed) */
    childRunId: z.string().optional().describe('Child run ID when delegation is claimed'),
    /** SHA-256 hash of the delegation token for correlation */
    tokenHash: z.string().describe('SHA-256 hash of the delegation token'),
    /** Raw delegation token for pending-token recovery */
    token: z
      .string()
      .regex(DELEGATION_TOKEN_PATTERN)
      .optional()
      .describe('Raw delegation token, present only while the delegation is pending'),
  })
  .refine((entry) => entry.state !== 'claimed' || !!entry.childRunId, {
    message: 'childRunId is required when state is claimed',
    path: ['childRunId'],
  })
  .refine((entry) => entry.state === 'pending' || entry.token === undefined, {
    message: 'token is only available while state is pending',
    path: ['token'],
  })
  .describe('Delegation status entry');

// ============================================================================
// Status Command Schema
// ============================================================================

/**
 * Status response schema.
 */
export const StatusResponseSchema = z
  .object({
    /** Response kind discriminant */
    kind: z.literal('status').describe('Response type discriminant'),
    /** Whether a runbook is currently active */
    active: z.boolean().describe('Whether a runbook is currently active'),
    /** Whether a runbook is stashed */
    stashed: z.boolean().describe('Whether a runbook is stashed'),
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
    /** Active delegations on the current step */
    delegations: z
      .array(DelegationStatusEntrySchema)
      .optional()
      .describe('Active delegations on the current step'),
    /**
     * Parent linkage when the runbook was launched as a child.
     *
     * Discriminated on `kind` so narrowing enforces the contract:
     * - `delegation` variant carries a required `tokenHash`.
     * - `inline` variant omits `tokenHash` entirely.
     */
    parentLinkage: z
      .discriminatedUnion('kind', [
        z.object({
          kind: z.literal('delegation'),
          tokenHash: z.string().describe('SHA-256 hash of the delegation token'),
          parentRunId: z.string().describe('RunId of the parent runbook execution'),
          parentStepId: z.string().describe('Parent substep ID at link time'),
          parentStep: z.string().describe('Parent step name at link time'),
          parentFrameKey: z.string().describe('Parent frame key at link time'),
          parentEntry: z.number().int().positive().describe('Parent frame entry at link time'),
        }),
        z.object({
          kind: z.literal('inline'),
          parentRunId: z.string().describe('RunId of the parent runbook execution'),
          parentStepId: z.string().describe('Parent substep ID at link time'),
          parentStep: z.string().describe('Parent step name at link time'),
          parentFrameKey: z.string().describe('Parent frame key at link time'),
          parentEntry: z.number().int().positive().describe('Parent frame entry at link time'),
        }),
      ])
      .optional()
      .describe('Parent linkage projection when this runbook is a child'),
    // Flat structure fields
    file: z.string().optional().describe('Path to the active runbook file'),
    state: z.string().optional().describe('Current runbook execution state'),
    prompted: z.boolean().optional().describe('Whether awaiting user input'),
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
    /** Unique runbook instance ID */
    id: z.string().describe('Unique state file identifier'),
    /** Runbook filename */
    runbook: z.string().describe('Runbook filename'),
    /** Current step display (e.g., "1/5", "Step") */
    step: z.string().optional().describe('Current step number'),
    /** Status of the runbook */
    status: z
      .string()
      .optional()
      .describe('Runbook status (active, stashed, completed, stale, or orphaned)'),
    /** Total number of steps */
    total: z.number().optional().describe('Total number of steps'),
    /** Runbook title from metadata */
    title: z.string().optional().describe('Runbook title from metadata'),
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
 * Uses the same format as `ls` command - an array of ActiveRunbookEntry objects
 * representing the runbook states that were (or would be) pruned.
 */
export const PruneResponseSchema = ActiveRunbookListSchema.describe(
  'List of runbook states that were/would be pruned',
);

// ============================================================================
// Stash/Pop Command Schemas
// ============================================================================

/**
 * Stash response schema.
 *
 * REQUIRED: stashedId - always present on successful stash.
 */
export const StashResponseSchema = z
  .object({
    /** Response kind discriminant */
    kind: z.literal('stash').describe('Response type discriminant'),
    action: z.literal('stash').describe('Action type'),
    /** ID of the stashed runbook - REQUIRED */
    stashedId: z.string().describe('ID of the stashed runbook'),
    /** Runbook context */
    runbook: RunbookContextSchema.optional().describe('Runbook context'),
    file: z.string().optional().describe('Path to the runbook file'),
    state: z.string().optional().describe('Runbook state'),
    message: z.string().optional().describe('Status message'),
    position: PositionSchema.optional().describe('Position when stashed'),
  })
  .describe('Response from the stash command')
  .loose();

/**
 * Pop response schema.
 *
 * REQUIRED: restoredId - always present on successful pop.
 */
export const PopResponseSchema = z
  .object({
    /** Response kind discriminant */
    kind: z.literal('pop').describe('Response type discriminant'),
    action: z.literal('pop').describe('Action type'),
    /** ID of the restored runbook - REQUIRED */
    restoredId: z.string().describe('ID of the restored runbook'),
    /** Runbook context */
    runbook: RunbookContextSchema.optional().describe('Runbook context'),
    file: z.string().optional().describe('Path to the runbook file'),
    state: z.string().optional().describe('Runbook state'),
    message: z.string().optional().describe('Status message'),
    position: PositionSchema.optional().describe('Position when restored'),
    step: z
      .object({
        name: z.string().optional().describe('Step name'),
        description: z.string().optional().describe('Step description'),
        prompted: z.boolean().optional().describe('Whether waiting for input'),
      })
      .optional()
      .describe('Current step details'),
  })
  .describe('Response from the pop command')
  .loose();

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
// Abort Command Schema
// ============================================================================

/**
 * Abort response schema.
 *
 * Output from `rd abort <token>` command.
 */
export const AbortResponseSchema = z
  .object({
    /** Response kind discriminant */
    kind: z.literal('abort').describe('Response type discriminant'),
    /** Action performed */
    action: z.literal('abort').describe('Action type'),
    /** Abort result status */
    status: z.enum(['cancelled', 'already_cancelled']).describe('Abort result status'),
    /** Truncated token hint */
    token: z.string().describe('Truncated delegation token hint'),
    /** Substep ID owning the delegation */
    substep: z.string().describe('Substep ID'),
    /** Child runbook path */
    runbook: z.string().describe('Child runbook path'),
    /** Parent run ID */
    parentRunId: z.string().describe('Parent run ID'),
    /** Whether --force was used */
    force: z.boolean().optional().describe('Whether force mode was used'),
    /** Child run ID (when force-cancelling claimed delegation) */
    childRunId: z.string().optional().describe('Child run ID when force-cancelling'),
  })
  .describe('Response from the abort command');

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
// Delegate Command Schema
// ============================================================================

/** Fields shared by every delegate response variant. */
const DelegateResponseBase = {
  /** Response kind discriminant */
  kind: z.literal('delegate').describe('Response type discriminant'),
  /** Step or substep ID that was delegated */
  step: z.string().describe('Step or substep ID delegated'),
  /** Child runbook name or path */
  runbook: z.string().describe('Child runbook name or path'),
  /** Full delegation token */
  token: z.string().describe('Delegation token'),
  /** Parent run ID */
  parent_run_id: z.string().describe('Parent run ID'),
} as const;

/**
 * Delegate response schema.
 *
 * Output from `rd delegate <runbook> --step <id>` and its idempotent/retry
 * variants. Discriminated on `action`:
 * - `delegated` — a fresh delegation was issued; carries `token_hash`.
 * - `retried` — an existing delegation was cancelled and re-minted; carries
 *   `token_hash`.
 * - `already-delegated` — an auto-issued delegation already exists and its
 *   plaintext token is echoed; no `token_hash` is recomputed for this path.
 */
export const DelegateResponseSchema = z
  .discriminatedUnion('action', [
    z
      .object({
        action: z.literal('delegated').describe('Action type'),
        ...DelegateResponseBase,
        /** Hash of the delegation token */
        token_hash: z.string().describe('Token hash'),
      })
      .describe('Fresh delegation issued'),
    z
      .object({
        action: z.literal('retried').describe('Action type'),
        ...DelegateResponseBase,
        /** Hash of the re-minted delegation token */
        token_hash: z.string().describe('Token hash'),
      })
      .describe('Existing delegation cancelled and re-minted'),
    z
      .object({
        action: z.literal('already-delegated').describe('Action type'),
        ...DelegateResponseBase,
      })
      // Strict: this arm carries no `token_hash`, so a drifting emitter that
      // leaks one is rejected rather than silently stripped, enforcing at
      // runtime the TypeScript guarantee that `token_hash` is absent here.
      .strict()
      .describe('Existing auto-issued delegation echoed'),
  ])
  .describe('Response from the delegate command');

// ============================================================================
// Claim Command Schema
// ============================================================================

/**
 * Claim response schema.
 *
 * Output from `rd claim <token>` command. Claim launches a child runbook and
 * returns the `claim_id` used for subsequent child-targeting commands; the
 * child does not (in general) run to completion at claim time, so this is its
 * own response type rather than an execution summary. `kind: "claim"` is the
 * primary discriminant — consistent with `stash` / `pop` which also carry
 * distinct lifecycle payloads.
 */
export const ClaimResponseSchema = z
  .object({
    /** Response kind discriminant */
    kind: z.literal('claim').describe('Response type discriminant'),
    /** Action performed */
    action: z.literal('claimed').describe('Action type'),
    /** Truncated delegation token */
    token: z.string().describe('Truncated delegation token'),
    /** Claim ID for explicit child targeting */
    claim_id: z.string().regex(CLAIM_ID_PATTERN).describe('Claim ID for explicit child targeting'),
    /** Child run ID */
    run_id: z.string().describe('Child run ID'),
    /** Child runbook path */
    runbook: z.string().describe('Child runbook path'),
    /** Parent run ID */
    parent_run_id: z.string().describe('Parent run ID'),
    /** Parent step identifier; omitted for bare-step delegations without an at-qualifier */
    parent_step: z.string().optional().describe('Parent step identifier (optional)'),
  })
  .describe('Response from the claim command');

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

/** Delegation status entry */
export type DelegationStatusEntry = z.infer<typeof DelegationStatusEntrySchema>;

/** Status response */
export type StatusResponse = z.infer<typeof StatusResponseSchema>;

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

/** Stash response */
export type StashResponse = z.infer<typeof StashResponseSchema>;

/** Pop response */
export type PopResponse = z.infer<typeof PopResponseSchema>;

/** Execution summary */
export type ExecutionSummary = z.infer<typeof ExecutionSummarySchema>;

/** Run command response */
export type RunCommandResponse = z.infer<typeof RunCommandResponseSchema>;

/** Abort response */
export type AbortResponse = z.infer<typeof AbortResponseSchema>;

/** Delegate response */
export type DelegateResponse = z.infer<typeof DelegateResponseSchema>;

/** Claim response */
export type ClaimResponse = z.infer<typeof ClaimResponseSchema>;

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
  | StashResponse
  | PopResponse
  | EchoResponse
  | AbortResponse
  | DelegateResponse
  | ClaimResponse;

/** Union of list outputs */
export type CLIListResponse =
  | ListResponse
  | ScenarioEntry[]
  | ScenarioSuiteCaseEntry[]
  | PruneResponse;
