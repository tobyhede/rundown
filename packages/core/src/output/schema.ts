/**
 * CLI JSON Output Schema - Standardized response format for machine-readable output.
 *
 * This module defines the formal specification for all CLI JSON output. All commands
 * using `--json` should output responses conforming to these interfaces.
 *
 * Design principles:
 * - Flat structure: Action-specific fields merged at top level (no nesting)
 * - Predictable: Required fields present in all responses
 * - Actionable: Error responses include machine-readable codes and contextual details
 * - Agent-friendly: Optimized for AI agent consumption (kubectl-inspired patterns)
 *
 * @module output/schema
 */

// ============================================================================
// CLI Error Codes (distinct from core ErrorCodes)
// ============================================================================

/**
 * Machine-readable error codes for CLI JSON output.
 *
 * These codes enable programmatic error handling without parsing error messages.
 * Named CLIErrorCodes to avoid conflict with core ErrorCodes.
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
 * Union type of all valid CLI error codes.
 */
export type CLIErrorCode = (typeof CLIErrorCodes)[keyof typeof CLIErrorCodes];

// ============================================================================
// Shared Types
// ============================================================================

/**
 * Runbook context information included in responses.
 *
 * Provides essential metadata about the runbook being operated on.
 */
export interface RunbookContext {
  /** Runbook filename (relative path) */
  file: string;
  /** State file path */
  state: string;
  /** Whether runbook is in prompted mode (waiting for user input) */
  prompted?: boolean;
}

/**
 * Position within a runbook.
 *
 * Represents the current location in the runbook execution.
 */
export interface Position {
  /** Current step identifier (e.g., "1", "2", "ErrorHandler") */
  current: string;
  /** Total number of steps (number or "{N}" for dynamic runbooks) */
  total: number | string;
  /** Current substep identifier if applicable */
  substep?: string;
}

// ============================================================================
// Base Response Types
// ============================================================================

/**
 * Base interface for all successful CLI responses.
 *
 * Contains the required `result` field that all responses must have.
 */
export interface BaseResponse {
  /** Whether the operation succeeded (true = success, false = failure) */
  result: boolean;
}

/**
 * Successful response base with optional context.
 */
export interface SuccessResponse extends BaseResponse {
  result: true;
  /** The action performed (e.g., "CONTINUE", "GOTO 3", "stopped") */
  action?: string;
  /** Runbook context when applicable */
  runbook?: RunbookContext;
}

/**
 * Error response structure.
 *
 * Provides structured error information for programmatic handling.
 */
export interface ErrorResponse extends BaseResponse {
  result: false;
  /** Human-readable error message */
  error: string;
  /** Machine-readable error code for programmatic handling */
  code?: CLIErrorCode;
  /** Actionable context to help resolve the error */
  details?: ErrorDetails;
}

/**
 * Actionable error details.
 *
 * Provides context that helps agents/users resolve the error.
 */
export interface ErrorDetails {
  /** The value that was requested but invalid/not found */
  requested?: string;
  /** Available valid options */
  available?: string[];
  /** Suggested command to run */
  suggestion?: string;
  /** File path related to the error */
  path?: string;
  /** Locations that were searched */
  searchedLocations?: string[];
  /** Line number where error occurred */
  line?: number;
  /** Additional error-specific fields */
  [key: string]: unknown;
}

// ============================================================================
// Action Command Responses (pass, fail, goto, stop, complete)
// ============================================================================

/**
 * Response from state-transition action commands.
 *
 * Used by: pass, fail, goto, stop, complete
 *
 * Note: `result` boolean indicates action success (PASS = true, FAIL = false).
 * The `action` field shows the transition (e.g., "CONTINUE", "GOTO 3", "RETRY").
 *
 * Extends BaseResponse (not SuccessResponse) to allow both true and false results:
 * - pass/complete: result = true
 * - fail/stop: result = false
 */
export interface ActionResponse extends BaseResponse {
  /** The action that was performed (e.g., "CONTINUE", "GOTO 3", "RETRY") */
  action: string;
  /** The command that was executed */
  command?: string;
  /** Position before the action */
  from?: Position;
  /** Position after the action */
  to?: Position;
  /** Whether this resulted in runbook completion */
  complete?: boolean;
  /** Whether this resulted in runbook stopping */
  stopped?: boolean;
}

// ============================================================================
// Status Command Response
// ============================================================================

/**
 * Response from the status command.
 */
export interface StatusResponse {
  /** Whether a runbook is currently active */
  active: boolean;
  /** Whether a runbook is stashed */
  stashed: boolean;
  /** Runbook context (when active) */
  runbook?: RunbookContext;
  /** Current position in the runbook (when active) */
  position?: Position;
  /**
   * Alias for position.
   * @deprecated Use `position` instead. Will be removed in a future version.
   */
  step?: Position;
  /** Current step details */
  currentStep?: {
    /** Step description/title */
    description?: string;
    /** Command to execute */
    command?: string;
  };
  /** Last action performed */
  lastAction?: {
    /** The action that was performed */
    action: string;
    /** The result of the action */
    result: string;
  };
}

// ============================================================================
// List Command Responses
// ============================================================================

/**
 * Active runbook entry in ls output.
 */
export interface ActiveRunbookEntry {
  /** Unique runbook instance ID */
  id: string;
  /** Runbook filename */
  runbook: string;
  /** Current step display (e.g., "1/5", "Step") */
  step: string;
  /** Status of the runbook */
  status?: string;
}

/**
 * Available runbook entry in ls --all output.
 */
export interface AvailableRunbookEntry {
  /** Runbook name from frontmatter */
  name: string;
  /** Runbook description */
  description?: string;
  /** Path to runbook file */
  path: string;
}

/**
 * Type alias for ls command output.
 *
 * ls --json outputs a raw array of active runbooks.
 * ls --all --json outputs a raw array of available runbooks.
 */
export type ListResponse = ActiveRunbookEntry[] | AvailableRunbookEntry[];

// ============================================================================
// Check Command Response
// ============================================================================

/**
 * Syntax error from runbook validation (check command).
 *
 * Named CheckValidationError to avoid conflict with core ValidationError.
 */
export interface CheckValidationError {
  /** Human-readable error message */
  message: string;
  /** Line number where error occurred (if applicable) */
  line?: number;
}

/**
 * Runbook statistics from validation.
 */
export interface RunbookStats {
  /** Total number of steps */
  steps: number;
  /** Total number of substeps */
  substeps: number;
}

/**
 * Response from the check command.
 */
export interface CheckResponse {
  /** Whether the runbook is valid */
  valid: boolean;
  /** List of validation errors (empty if valid) */
  errors: CheckValidationError[];
  /** Runbook statistics (only present when valid) */
  stats?: RunbookStats;
}

// ============================================================================
// Scenario Command Responses
// ============================================================================

/**
 * Scenario entry in scenario ls output.
 */
export interface ScenarioEntry {
  /** Scenario name */
  name: string;
  /** Expected result (e.g., "COMPLETE", "STOPPED") */
  expected: string;
  /** Scenario description */
  description?: string;
  /** Tags as comma-separated string */
  tags?: string;
}

/**
 * Detailed scenario information from scenario show.
 */
export interface ScenarioDetail extends ScenarioEntry {
  /** Commands to execute */
  commands: string[];
}

/**
 * Scenario run result.
 */
export interface ScenarioRunResponse {
  /** Whether the scenario passed */
  result: boolean;
  /** Scenario name */
  scenario: string;
  /** Expected outcome */
  expected: string;
  /** Actual outcome */
  actual: string;
  /** Detailed message */
  message?: string;
}

// ============================================================================
// Echo Command Response
// ============================================================================

/**
 * Response from the echo command.
 */
export interface EchoResponse {
  /** Whether the operation succeeded */
  result: boolean;
  /** The echoed output */
  output?: string;
  /** Error message if failed */
  error?: string;
  /** Exit code */
  exitCode?: number;
}

// ============================================================================
// Prune Command Response
// ============================================================================

/**
 * Entry for a pruned state file.
 */
export interface PruneEntry {
  /** State file ID */
  id: string;
  /** Associated runbook file */
  runbook: string;
  /** Reason for pruning */
  reason: string;
}

/**
 * Type alias for prune command output.
 *
 * prune --json outputs a raw array of pruned entries.
 */
export type PruneResponse = PruneEntry[];

// ============================================================================
// Stash/Pop Command Responses
// ============================================================================

/**
 * Response from stash command.
 */
export interface StashResponse extends SuccessResponse {
  action: 'stash';
  /** ID of the stashed runbook */
  stashedId: string;
  /** Runbook context */
  runbook?: RunbookContext;
}

/**
 * Response from pop command.
 */
export interface PopResponse extends SuccessResponse {
  action: 'pop';
  /** ID of the restored runbook */
  restoredId: string;
  /** Runbook context */
  runbook?: RunbookContext;
}

// ============================================================================
// Union Types
// ============================================================================

/**
 * Union type representing any CLI JSON response.
 *
 * Commands output one of these types based on the operation.
 */
export type CLIResponse =
  | ActionResponse
  | ErrorResponse
  | StatusResponse
  | CheckResponse
  | ScenarioRunResponse
  | StashResponse
  | PopResponse
  | EchoResponse;

/**
 * Union type representing list outputs (raw arrays).
 */
export type CLIListResponse =
  | ListResponse
  | ScenarioEntry[]
  | PruneResponse;

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard to check if a response is an error response.
 *
 * @param response - The response to check
 * @returns True if the response is an ErrorResponse
 */
export function isErrorResponse(
  response: CLIResponse | ErrorResponse
): response is ErrorResponse {
  return 'result' in response && !response.result && 'error' in response;
}

/**
 * Type guard to check if a response is an action response.
 *
 * Action responses have both `result` (boolean) and `action` (string) fields.
 * This distinguishes them from ErrorResponse which has `error` instead of `action`.
 *
 * @param response - The response to check
 * @returns True if the response is an ActionResponse
 */
export function isActionResponse(
  response: CLIResponse
): response is ActionResponse {
  return (
    'result' in response &&
    typeof response.result === 'boolean' &&
    'action' in response &&
    typeof response.action === 'string' &&
    !('stashedId' in response) &&
    !('restoredId' in response)
  );
}

/**
 * Type guard to check if a response is a status response.
 *
 * @param response - The response to check
 * @returns True if the response is a StatusResponse
 */
export function isStatusResponse(
  response: unknown
): response is StatusResponse {
  return (
    typeof response === 'object' &&
    response !== null &&
    'active' in response &&
    typeof (response as StatusResponse).active === 'boolean'
  );
}

/**
 * Type guard to check if a response is a check response.
 *
 * @param response - The response to check
 * @returns True if the response is a CheckResponse
 */
export function isCheckResponse(
  response: unknown
): response is CheckResponse {
  return (
    typeof response === 'object' &&
    response !== null &&
    'valid' in response &&
    typeof (response as CheckResponse).valid === 'boolean' &&
    'errors' in response &&
    Array.isArray((response as CheckResponse).errors)
  );
}

/**
 * Type guard to check if a response is a list response (raw array).
 *
 * @param response - The response to check
 * @returns True if the response is a list (array)
 */
export function isListResponse(response: unknown): response is unknown[] {
  return Array.isArray(response);
}
