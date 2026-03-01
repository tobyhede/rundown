/**
 * CLI JSON Output Schema - Standardized response format for machine-readable output.
 *
 * This module re-exports types derived from Zod schemas (single source of truth)
 * and provides type guards for runtime type checking.
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
// Re-export Zod Schemas (Single Source of Truth)
// ============================================================================

export {
  // Error codes
  CLIErrorCodes,
  ErrorCodeSchema,
  type CLIErrorCode,
  // Shared schemas
  PositionSchema,
  RunbookContextSchema,
  ErrorDetailsSchema,
  // Base response schemas
  BaseResponseSchema,
  SuccessResponseSchema,
  ErrorResponseSchema,
  // Action schemas
  ActionResponseSchema,
  StatusResponseSchema,
  DelegationStatusEntrySchema,
  // List schemas
  ActiveRunbookEntrySchema,
  AvailableRunbookEntrySchema,
  ActiveRunbookListSchema,
  AvailableRunbooksListSchema,
  // Check schemas
  CheckValidationErrorSchema,
  CheckValidationWarningSchema,
  RunbookStatsSchema,
  CheckResponseSchema,
  // Scenario schemas
  ScenarioEntrySchema,
  ScenarioDetailSchema,
  ScenarioListSchema,
  ScenarioRunResponseSchema,
  ScenarioErrorResponseSchema,
  // Echo schema
  EchoResponseSchema,
  // Prune schema (same format as ls output)
  PruneResponseSchema,
  // Stash/Pop schemas
  StashResponseSchema,
  PopResponseSchema,
  // Execution schemas
  ExecutionSummarySchema,
  RunCommandResponseSchema,
  // Abort schema
  AbortResponseSchema,
  // Derived TypeScript types
  type Position,
  type RunbookContext,
  type ErrorDetails,
  type BaseResponse,
  type SuccessResponse,
  type ErrorResponse,
  type ActionResponse,
  type DelegationStatusEntry,
  type StatusResponse,
  type ActiveRunbookEntry,
  type AvailableRunbookEntry,
  type ListResponse,
  type CheckValidationError,
  type CheckValidationWarning,
  type RunbookStats,
  type CheckResponse,
  type ScenarioEntry,
  type ScenarioDetail,
  type ScenarioRunResponse,
  type EchoResponse,
  type PruneResponse,
  type StashResponse,
  type PopResponse,
  type ExecutionSummary,
  type RunCommandResponse,
  type AbortResponse,
  type CLIResponse,
  type CLIListResponse,
} from './zod-schemas.js';

// ============================================================================
// Type Guards
// ============================================================================

import type {
  CLIResponse,
  ErrorResponse,
  ActionResponse,
  StatusResponse,
  CheckResponse,
} from './zod-schemas.js';

/**
 * Type guard to check if a response is an error response.
 *
 * @param response - The response to check
 * @returns True if the response is an ErrorResponse
 */
export function isErrorResponse(response: CLIResponse | ErrorResponse): response is ErrorResponse {
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
export function isActionResponse(response: CLIResponse): response is ActionResponse {
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
export function isStatusResponse(response: unknown): response is StatusResponse {
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
export function isCheckResponse(response: unknown): response is CheckResponse {
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
