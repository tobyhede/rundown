/**
 * Output event system for format-agnostic CLI output.
 *
 * This module exports two complementary type systems:
 *
 * ## OutputEvent Types (from types.ts)
 * Internal event types used for emitter/renderer communication. Commands emit
 * these structured events (list, detail, status, action, error) through the
 * OutputEmitter, and renderers (TextRenderer, JSONRenderer) handle formatting.
 * These types are implementation details - not part of the public API contract.
 *
 * ## Schema Types (from schema.ts / zod-schemas.ts)
 * Formal specification for CLI JSON output - the public API contract for
 * machine-readable output. All `--json` command output should conform to these
 * interfaces. These types are what external tools and AI agents parse.
 *
 * The Zod schemas are the single source of truth - TypeScript types are derived
 * from them using z.infer<>. This eliminates drift between runtime validation
 * and compile-time types.
 *
 * @module output
 */

export type {
  ColumnDef,
  OutputEvent,
  ListOutput,
  DetailOutput,
  MetadataOutput,
  StatusOutput,
  ActionOutput,
  StepSeparatorOutput,
  MessageOutput,
  ErrorOutput,
  CompleteOutput,
  StoppedOutput,
  NoActiveRunbookOutput,
  ExecutionEventOutput,
} from './types.js';

export {
  isListOutput,
  isDetailOutput,
  isStatusOutput,
  isActionOutput,
  isMessageOutput,
  isErrorOutput,
} from './types.js';

// ============================================================================
// Schema exports (Zod schemas + derived types)
// ============================================================================

// Error codes
export {
  CLIErrorCodes,
  ErrorCodeSchema,
  type CLIErrorCode,
} from './schema.js';

// Shared schemas
export {
  PositionSchema,
  RunbookContextSchema,
  ErrorDetailsSchema,
  type RunbookContext,
  type Position,
  type ErrorDetails,
} from './schema.js';

// Base response schemas and types
export {
  BaseResponseSchema,
  SuccessResponseSchema,
  ErrorResponseSchema,
  type BaseResponse,
  type SuccessResponse,
  type ErrorResponse,
} from './schema.js';

// Action and status schemas
export {
  ActionResponseSchema,
  StatusResponseSchema,
  DelegationStatusEntrySchema,
  type ActionResponse,
  type DelegationStatusEntry,
  type StatusResponse as SchemaStatusResponse,
} from './schema.js';

// List schemas
export {
  ActiveRunbookEntrySchema,
  AvailableRunbookEntrySchema,
  ActiveRunbookListSchema,
  AvailableRunbooksListSchema,
  type ActiveRunbookEntry,
  type AvailableRunbookEntry,
  type ListResponse,
} from './schema.js';

// Check schemas
export {
  CheckValidationErrorSchema,
  CheckValidationWarningSchema,
  RunbookStatsSchema,
  CheckResponseSchema,
  type CheckValidationError,
  type CheckValidationWarning,
  type RunbookStats,
  type CheckResponse,
} from './schema.js';

// Scenario schemas
export {
  ScenarioEntrySchema,
  ScenarioDetailSchema,
  ScenarioListSchema,
  ScenarioRunResponseSchema,
  ScenarioErrorResponseSchema,
  type ScenarioEntry,
  type ScenarioDetail,
  type ScenarioRunResponse,
} from './schema.js';

// Echo schema
export {
  EchoResponseSchema,
  type EchoResponse,
} from './schema.js';

// Prune schema (same format as ls output)
export {
  PruneResponseSchema,
  type PruneResponse,
} from './schema.js';

// Stash/Pop schemas
export {
  StashResponseSchema,
  PopResponseSchema,
  type StashResponse,
  type PopResponse,
} from './schema.js';

// Execution schemas
export {
  ExecutionSummarySchema,
  StepQueuedResponseSchema,
  AgentBoundResponseSchema,
  RunCommandResponseSchema,
  type ExecutionSummary,
  type StepQueuedResponse,
  type AgentBoundResponse,
  type RunCommandResponse,
} from './schema.js';

// Union types
export type { CLIResponse, CLIListResponse } from './schema.js';

// Type guards
export {
  isErrorResponse,
  isActionResponse,
  isStatusResponse as isSchemaStatusResponse,
  isCheckResponse,
  isListResponse,
} from './schema.js';
