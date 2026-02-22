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

// ============================================================================
// CLI Error Codes
// ============================================================================

/**
 * Machine-readable error codes for CLI JSON output.
 *
 * These codes enable programmatic error handling without parsing error messages.
 */
export const CLIErrorCodes = {
  /** No runbook is currently active */
  NO_ACTIVE_RUNBOOK: 'NO_ACTIVE_RUNBOOK',
  /** Specified runbook file doesn't exist */
  RUNBOOK_NOT_FOUND: 'RUNBOOK_NOT_FOUND',
  /** Target step doesn't exist */
  STEP_NOT_FOUND: 'STEP_NOT_FOUND',
  /** Runbook has syntax errors */
  INVALID_SYNTAX: 'INVALID_SYNTAX',
  /** Input validation failed */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** No stashed runbook to restore */
  NO_STASHED_RUNBOOK: 'NO_STASHED_RUNBOOK',
  /** Agent binding operation failed */
  AGENT_BINDING_ERROR: 'AGENT_BINDING_ERROR',
  /** Scenario not found */
  SCENARIO_NOT_FOUND: 'SCENARIO_NOT_FOUND',
  /** File system operation failed */
  FILE_ERROR: 'FILE_ERROR',
  /** Unknown or unexpected error */
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
} as const;

/**
 * Zod schema for error codes.
 */
export const ErrorCodeSchema = z
  .enum([
    'NO_ACTIVE_RUNBOOK',
    'RUNBOOK_NOT_FOUND',
    'STEP_NOT_FOUND',
    'INVALID_SYNTAX',
    'VALIDATION_ERROR',
    'NO_STASHED_RUNBOOK',
    'AGENT_BINDING_ERROR',
    'SCENARIO_NOT_FOUND',
    'FILE_ERROR',
    'UNKNOWN_ERROR',
  ])
  .describe('Error code identifying the type of error that occurred');

/**
 * Union type of all valid CLI error codes.
 */
export type CLIErrorCode = (typeof CLIErrorCodes)[keyof typeof CLIErrorCodes];

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
  .passthrough();

// ============================================================================
// Base Response Schemas
// ============================================================================

/**
 * Base schema for all successful CLI responses.
 */
export const BaseResponseSchema = z.object({
  /** Whether the operation succeeded (true = success, false = failure) */
  result: z.boolean().describe('Whether the operation succeeded'),
});

/**
 * Successful response base with optional context.
 */
export const SuccessResponseSchema = BaseResponseSchema.extend({
  result: z.literal(true).describe('Always true for success responses'),
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
    result: z.literal(false).describe('Always false for error responses'),
    /** Human-readable error message */
    error: z.string().describe('Error message describing what went wrong'),
    /** Machine-readable error code for programmatic handling */
    code: ErrorCodeSchema.optional().describe('Error code for programmatic handling'),
    /** Actionable context to help resolve the error */
    details: ErrorDetailsSchema.optional().describe('Additional error context'),
  })
  .describe('Error response indicating command execution failure')
  .passthrough();

// ============================================================================
// Action Command Schemas (pass, fail, goto, stop, complete)
// ============================================================================

/**
 * Action response schema.
 *
 * Used by: pass, fail, goto, stop, complete
 *
 * Note: `result` boolean indicates action success (PASS = true, FAIL = false).
 * The `action` field shows the transition (e.g., "CONTINUE", "GOTO 3", "RETRY").
 */
export const ActionResponseSchema = z
  .object({
    /** Whether the action succeeded */
    result: z.boolean().describe('Whether the action succeeded'),
    /** The action that was performed (e.g., "CONTINUE", "GOTO 3", "RETRY") */
    action: z.string().describe('Type of action performed'),
    /** The command that was executed */
    command: z.string().optional().describe('Command executed for this action'),
    /** Position before the action */
    from: PositionSchema.optional().describe('Starting position before action'),
    /** Position after the action */
    to: PositionSchema.optional().describe('Position after action execution'),
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
    position: PositionSchema.optional().describe('Current position after action'),
  })
  .describe('Response from a step action command')
  .passthrough();

// ============================================================================
// Status Command Schema
// ============================================================================

/**
 * Status response schema.
 */
export const StatusResponseSchema = z
  .object({
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
        /** The result of the action */
        result: z.boolean().optional().describe('Result of the last action'),
      })
      .optional()
      .describe('Last action information'),
    // Flat structure fields
    file: z.string().optional().describe('Path to the active runbook file'),
    state: z.string().optional().describe('Current runbook execution state'),
    prompted: z.boolean().optional().describe('Whether awaiting user input'),
  })
  .describe('Response from the status command')
  .passthrough();

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
 * Syntax error from runbook validation (check command).
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
 * Syntax warning from runbook validation (check command).
 */
export const CheckValidationWarningSchema = z
  .object({
    /** Human-readable warning message */
    message: z.string().describe('Warning message'),
    /** Line number where warning occurred (if applicable) */
    line: z.number().optional().describe('Line number where warning occurred'),
  })
  .describe('Validation warning entry');

/**
 * Check response schema.
 */
export const CheckResponseSchema = z
  .object({
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
 * Scenario run result.
 */
export const ScenarioRunResponseSchema = z
  .object({
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
    result: z.literal(true).describe('Always true for successful stash'),
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
  .passthrough();

/**
 * Pop response schema.
 *
 * REQUIRED: restoredId - always present on successful pop.
 */
export const PopResponseSchema = z
  .object({
    result: z.literal(true).describe('Always true for successful pop'),
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
  .passthrough();

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
  .passthrough();

/**
 * Step queued response schema (run --step output).
 */
export const StepQueuedResponseSchema = z
  .object({
    action: z.literal('step_queued').describe('Action type for step queue'),
    stepId: z.string().describe('Step identifier that was queued'),
    runbook: z.string().optional().describe('Runbook filename'),
  })
  .describe('Response when a step is queued for execution');

/**
 * Agent bound response schema (run --agent output).
 */
export const AgentBoundResponseSchema = z
  .object({
    action: z.literal('agent_bound').describe('Action type for agent binding'),
    agent: z.string().describe('Agent identifier that was bound'),
    stepId: z.string().describe('Step identifier the agent is bound to'),
  })
  .describe('Response when an agent is bound to a step');

/**
 * Combined run command response schema.
 */
export const RunCommandResponseSchema = z
  .union([ExecutionSummarySchema, StepQueuedResponseSchema, AgentBoundResponseSchema])
  .describe('Response from the run command');

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

/** Action response (pass, fail, goto, stop, complete) */
export type ActionResponse = z.infer<typeof ActionResponseSchema>;

/** Status response */
export type StatusResponse = z.infer<typeof StatusResponseSchema>;

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

/** Scenario entry */
export type ScenarioEntry = z.infer<typeof ScenarioEntrySchema>;

/** Scenario detail */
export type ScenarioDetail = z.infer<typeof ScenarioDetailSchema>;

/** Scenario run response */
export type ScenarioRunResponse = z.infer<typeof ScenarioRunResponseSchema>;

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

/** Step queued response */
export type StepQueuedResponse = z.infer<typeof StepQueuedResponseSchema>;

/** Agent bound response */
export type AgentBoundResponse = z.infer<typeof AgentBoundResponseSchema>;

/** Run command response */
export type RunCommandResponse = z.infer<typeof RunCommandResponseSchema>;

/** Union of all CLI responses */
export type CLIResponse =
  | ActionResponse
  | ErrorResponse
  | StatusResponse
  | CheckResponse
  | ScenarioRunResponse
  | StashResponse
  | PopResponse
  | EchoResponse;

/** Union of list outputs */
export type CLIListResponse = ListResponse | ScenarioEntry[] | PruneResponse;
