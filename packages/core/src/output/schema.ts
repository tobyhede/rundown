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
  // Resolve schemas
  ResolveSourceInfoSchema,
  ResolveResponseSchema,
  // Scenario schemas
  StepAssertionInputSchema,
  CapturedTransitionSchema,
  ScenarioStepAssertionResultSchema,
  ScenarioEntrySchema,
  ScenarioDetailSchema,
  ScenarioListSchema,
  ScenarioRunResponseSchema,
  ScenarioErrorResponseSchema,
  // Suite schemas
  ScenarioSuiteCaseEntrySchema,
  ScenarioSuiteListSchema,
  ScenarioSuiteCaseDetailSchema,
  ScenarioSuiteRunResponseSchema,
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
  // Delegate/Claim schemas
  DelegateResponseSchema,
  ClaimResponseSchema,
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
  type ResolveSourceInfo,
  type ResolveResponse,
  type StepAssertionInput,
  type CapturedTransition,
  type ScenarioStepAssertionResult,
  type ScenarioEntry,
  type ScenarioDetail,
  type ScenarioRunResponse,
  type ScenarioSuiteCaseEntry,
  type ScenarioSuiteCaseDetail,
  type ScenarioSuiteRunResponse,
  type EchoResponse,
  type PruneResponse,
  type StashResponse,
  type PopResponse,
  type ExecutionSummary,
  type RunCommandResponse,
  type AbortResponse,
  type DelegateResponse,
  type ClaimResponse,
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
  ResolveResponse,
} from './zod-schemas.js';

/**
 * Type guard to check if a response is an error response.
 *
 * @param response - The response to check
 * @returns True if the response is an ErrorResponse
 */
export function isErrorResponse(response: CLIResponse | ErrorResponse): response is ErrorResponse {
  return 'kind' in response && response.kind === 'error';
}

/**
 * Type guard to check if a response is an action response.
 *
 * @param response - The response to check
 * @returns True if the response is an ActionResponse
 */
export function isActionResponse(response: CLIResponse): response is ActionResponse {
  return 'kind' in response && response.kind === 'action';
}

/**
 * Type guard to check if a response is a status response.
 *
 * @param response - The response to check
 * @returns True if the response is a StatusResponse
 */
export function isStatusResponse(response: CLIResponse): response is StatusResponse {
  return 'kind' in response && response.kind === 'status';
}

/**
 * Type guard to check if a response is a check response.
 *
 * Discriminates on the `kind` field to distinguish from ResolveResponse,
 * which shares the same `valid`/`errors` shape.
 *
 * @param response - The response to check
 * @returns True if the response is a CheckResponse
 */
export function isCheckResponse(response: CLIResponse): response is CheckResponse {
  return 'kind' in response && response.kind === 'check';
}

/**
 * Type guard to check if a response is a resolve response.
 *
 * Discriminates on the `kind` field to distinguish from CheckResponse.
 *
 * @param response - The response to check
 * @returns True if the response is a ResolveResponse
 */
export function isResolveResponse(response: CLIResponse): response is ResolveResponse {
  return 'kind' in response && response.kind === 'resolve';
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
