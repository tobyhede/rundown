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
 * ## Schema Types (from schema.ts)
 * Formal specification for CLI JSON output - the public API contract for
 * machine-readable output. All `--json` command output should conform to these
 * interfaces. These types are what external tools and AI agents parse.
 *
 * The relationship: OutputEmitter events are internal communication;
 * Schema types define what JSONRenderer ultimately outputs to consumers.
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
} from './types.js';

export {
  isListOutput,
  isDetailOutput,
  isStatusOutput,
  isActionOutput,
  isMessageOutput,
  isErrorOutput,
} from './types.js';

// Schema types for standardized CLI JSON output
export {
  CLIErrorCodes,
  type CLIErrorCode,
  type RunbookContext,
  type Position,
  type BaseResponse,
  type SuccessResponse,
  type ErrorResponse,
  type ErrorDetails,
  type ActionResponse,
  type StatusResponse as SchemaStatusResponse,
  type ActiveRunbookEntry,
  type AvailableRunbookEntry,
  type ListResponse,
  type CheckValidationError,
  type RunbookStats,
  type CheckResponse,
  type ScenarioEntry,
  type ScenarioDetail,
  type ScenarioRunResponse,
  type EchoResponse,
  type PruneEntry,
  type PruneResponse,
  type StashResponse,
  type PopResponse,
  type CLIResponse,
  type CLIListResponse,
  isErrorResponse,
  isActionResponse,
  isStatusResponse as isSchemaStatusResponse,
  isCheckResponse,
  isListResponse,
} from './schema.js';
