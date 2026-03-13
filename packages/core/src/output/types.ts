/**
 * Output event type definitions for format-agnostic CLI output.
 *
 * These types enable the Output Emitter pattern where commands emit structured
 * data events and renderers decide how to format them (text vs JSON) at render time.
 *
 * @module output/types
 */

import type { StepPosition, ActionBlockData, RunbookMetadata } from '../cli/types.js';
import type { RunbookEventV1 } from '../events/types.js';

// ============================================================================
// Column Definition for Lists
// ============================================================================

/**
 * Column definition for tabular list output.
 *
 * @template T - The type of items in the list
 */
export interface ColumnDef<T> {
  /** Column header text (displayed uppercase in text mode) */
  header: string;
  /** Key path or accessor function to extract cell value */
  key: keyof T | ((item: T) => string | number | boolean | undefined);
  /** Alignment for the column (defaults to 'left') */
  align?: 'left' | 'right';
}

// ============================================================================
// Output Event Types
// ============================================================================

/**
 * Base interface for all output events.
 */
interface BaseOutputEvent {
  /** Discriminator for the event type */
  type: string;
}

/**
 * Event for outputting a list of items in tabular format.
 *
 * @template T - The type of items being listed
 * @template U - The type of items after JSON mapping (defaults to T)
 */
export interface ListOutput<T = unknown, U = T> extends BaseOutputEvent {
  type: 'list';
  /** Items to display */
  items: T[];
  /** Column definitions for text mode display */
  columns: ColumnDef<T>[];
  /** Message to display when list is empty */
  emptyMessage?: string;
  /** Optional mapper to transform items for JSON output */
  jsonMapper?: (item: T) => U;
}

/**
 * Event for outputting detailed information about a single item.
 *
 * Used for commands like `status`, `scenario show`, `echo`, `prompt`, `check`, etc.
 */
export interface DetailOutput extends BaseOutputEvent {
  type: 'detail';
  /** The format/template to use for text rendering */
  format:
    | 'metadata'
    | 'step'
    | 'scenario'
    | 'scenario_result'
    | 'status'
    | 'echo'
    | 'prompt'
    | 'check'
    | 'resolve'
    | 'custom';
  /** Structured data for the detail view */
  data: Record<string, unknown>;
}

/**
 * Event for outputting metadata about a runbook.
 */
export interface MetadataOutput extends BaseOutputEvent {
  type: 'metadata';
  /** Runbook metadata */
  metadata: RunbookMetadata;
}

/**
 * Event for outputting operation status/result.
 *
 * Used for commands that complete an operation and report success/failure.
 */
export interface StatusOutput extends BaseOutputEvent {
  type: 'status';
  /** The action that was performed */
  action: string;
  /** Human-readable message about the result */
  message?: string;
  /** Additional structured data about the operation */
  data?: Record<string, unknown>;
}

/**
 * Event for outputting a state transition action.
 *
 * Used by pass, fail, goto commands to show the action taken
 * and the resulting state transition.
 */
export interface ActionOutput extends BaseOutputEvent {
  type: 'action';
  /** The action block data showing the transition */
  block: ActionBlockData;
  /** Whether this resulted in runbook completion */
  complete?: boolean;
  /** Whether this resulted in runbook stopping */
  stopped?: boolean;
}

/**
 * Event for outputting a step separator with position.
 */
export interface StepSeparatorOutput extends BaseOutputEvent {
  type: 'step_separator';
  /** Current position in the runbook */
  position: StepPosition;
}

/**
 * Event for outputting a simple informational message.
 *
 * Used for status messages, warnings, and general information.
 */
export interface MessageOutput extends BaseOutputEvent {
  type: 'message';
  /** The message text */
  text: string;
  /** Message level for styling in text mode */
  level: 'info' | 'success' | 'warning' | 'error' | 'dim';
}

/**
 * Event for outputting an error.
 *
 * Used for structured error reporting with consistent format.
 */
export interface ErrorOutput extends BaseOutputEvent {
  type: 'error';
  /** Error message */
  message: string;
  /** Error code for programmatic handling */
  code?: string;
  /** Additional error details */
  details?: Record<string, unknown>;
}

/**
 * Event for outputting runbook completion.
 */
export interface CompleteOutput extends BaseOutputEvent {
  type: 'complete';
  /** Optional completion message */
  message?: string;
  /** Step position at completion */
  position?: StepPosition;
}

/**
 * Event for outputting runbook stopped state.
 */
export interface StoppedOutput extends BaseOutputEvent {
  type: 'stopped';
  /** Optional stop message */
  message?: string;
  /** Step position where stopped */
  position?: StepPosition;
}

/**
 * Event for "no active runbook" message.
 *
 * Optional action and code fields enable consistent JSON output
 * that includes the triggering command and error code.
 */
export interface NoActiveRunbookOutput extends BaseOutputEvent {
  type: 'no_active_runbook';
  /** The action/command that triggered this (e.g., 'pass', 'fail', 'goto') */
  action?: string;
  /** Error code for programmatic handling */
  code?: string;
}

/**
 * Event for bridging execution events to the output system.
 *
 * Used to stream execution events through the unified output architecture,
 * allowing both text and JSON renderers to handle runbook execution events.
 */
export interface ExecutionEventOutput extends BaseOutputEvent {
  type: 'execution_event';
  /** The wrapped execution event */
  event: RunbookEventV1;
}

// ============================================================================
// Discriminated Union
// ============================================================================

/**
 * Union type of all possible output events.
 *
 * Commands emit these events and renderers decide how to format them.
 */
export type OutputEvent =
  | ListOutput
  | DetailOutput
  | MetadataOutput
  | StatusOutput
  | ActionOutput
  | StepSeparatorOutput
  | MessageOutput
  | ErrorOutput
  | CompleteOutput
  | StoppedOutput
  | NoActiveRunbookOutput
  | ExecutionEventOutput;

/**
 * Type guard to check if an event is a ListOutput.
 *
 * @param event - The event to check
 * @returns True if the event is a ListOutput
 */
export function isListOutput(event: OutputEvent): event is ListOutput {
  return event.type === 'list';
}

/**
 * Type guard to check if an event is a DetailOutput.
 *
 * @param event - The event to check
 * @returns True if the event is a DetailOutput
 */
export function isDetailOutput(event: OutputEvent): event is DetailOutput {
  return event.type === 'detail';
}

/**
 * Type guard to check if an event is a StatusOutput.
 *
 * @param event - The event to check
 * @returns True if the event is a StatusOutput
 */
export function isStatusOutput(event: OutputEvent): event is StatusOutput {
  return event.type === 'status';
}

/**
 * Type guard to check if an event is an ActionOutput.
 *
 * @param event - The event to check
 * @returns True if the event is an ActionOutput
 */
export function isActionOutput(event: OutputEvent): event is ActionOutput {
  return event.type === 'action';
}

/**
 * Type guard to check if an event is a MessageOutput.
 *
 * @param event - The event to check
 * @returns True if the event is a MessageOutput
 */
export function isMessageOutput(event: OutputEvent): event is MessageOutput {
  return event.type === 'message';
}

/**
 * Type guard to check if an event is an ErrorOutput.
 *
 * @param event - The event to check
 * @returns True if the event is an ErrorOutput
 */
export function isErrorOutput(event: OutputEvent): event is ErrorOutput {
  return event.type === 'error';
}
