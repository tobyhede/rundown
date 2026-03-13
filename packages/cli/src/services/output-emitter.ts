/**
 * OutputEmitter - Format-agnostic output emitter for CLI commands.
 *
 * Commands emit structured data through this interface. The actual
 * formatting (text vs JSON) is decided at render time by the configured
 * renderer.
 *
 * @module output-emitter
 */

import type {
  OutputWriter,
  ColumnDef,
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
  RunbookMetadata,
  StepPosition,
  ActionBlockData,
  RunbookEventV1,
} from '@rundown-org/core';
import { getWriter } from '@rundown-org/core';
import type { OutputRenderer } from './renderers/types.js';
import { TextRenderer } from './renderers/text-renderer.js';
import { JSONRenderer } from './renderers/json-renderer.js';

/**
 * Options for creating an OutputEmitter.
 */
export interface OutputEmitterOptions {
  /** Whether to output JSON instead of text */
  json?: boolean;
  /** Custom writer to use for output */
  writer?: OutputWriter;
  /** Custom renderer (overrides json option) */
  renderer?: OutputRenderer;
}

/**
 * Options for list output.
 */
export interface ListOptions<T, U = T> {
  /** Message to display when list is empty */
  emptyMessage?: string;
  /** Function to map items for JSON output */
  jsonMapper?: (item: T) => U;
}

/**
 * Format-agnostic output emitter for CLI commands.
 *
 * This class implements the Output Emitter pattern: commands emit
 * structured data events, and the renderer decides how to format them.
 * This eliminates the need for `if (isJson())` conditionals in commands.
 *
 * @example
 * ```typescript
 * const output = new OutputEmitter({ json: options.json });
 *
 * // Emit events without caring about format
 * output.metadata(buildMetadata(state));
 * output.status('stopped', 'Runbook stopped');
 * output.flush();
 * ```
 */
export class OutputEmitter {
  private renderer: OutputRenderer;
  private writer: OutputWriter;

  /**
   * Create a new OutputEmitter.
   *
   * @param options - Emitter configuration options
   */
  constructor(options: OutputEmitterOptions = {}) {
    this.writer = options.writer ?? getWriter();

    if (options.renderer) {
      this.renderer = options.renderer;
    } else if (options.json) {
      this.renderer = new JSONRenderer({ writer: this.writer });
    } else {
      this.renderer = new TextRenderer({ writer: this.writer });
    }
  }

  /**
   * Emit a list of items.
   *
   * @param items - The items to list
   * @param columns - Column definitions for text display
   * @param options - Additional list options
   */
  list<T, U = T>(items: T[], columns: ColumnDef<T>[], options?: ListOptions<T, U>): void {
    // Cast to OutputEvent since ListOutput<T, U> has compatible runtime shape

    const event: ListOutput<any, any> = {
      type: 'list',
      items,
      columns,
      emptyMessage: options?.emptyMessage,
      jsonMapper: options?.jsonMapper,
    };
    this.renderer.render(event);
  }

  /**
   * Emit a detail view.
   *
   * @param data - The data to display
   * @param format - The format/template to use
   */
  detail(
    data: Record<string, unknown>,
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
      | 'custom' = 'custom',
  ): void {
    const event: DetailOutput = {
      type: 'detail',
      format,
      data,
    };
    this.renderer.render(event);
  }

  /**
   * Emit runbook metadata.
   *
   * @param metadata - The metadata to display
   */
  metadata(metadata: RunbookMetadata): void {
    const event: MetadataOutput = {
      type: 'metadata',
      metadata,
    };
    this.renderer.render(event);
  }

  /**
   * Emit an operation status.
   *
   * @param action - The action that was performed
   * @param message - Optional message about the result
   * @param data - Additional structured data
   */
  status(action: string, message?: string, data?: Record<string, unknown>): void {
    const event: StatusOutput = {
      type: 'status',
      action,
      message,
      data,
    };
    this.renderer.render(event);
  }

  /**
   * Emit an action/transition block.
   *
   * @param block - The action block data
   * @param options - Additional options
   * @param options.complete - Whether this action completes the runbook
   * @param options.stopped - Whether this action stops the runbook
   */
  action(block: ActionBlockData, options?: { complete?: boolean; stopped?: boolean }): void {
    const event: ActionOutput = {
      type: 'action',
      block,
      complete: options?.complete,
      stopped: options?.stopped,
    };
    this.renderer.render(event);
  }

  /**
   * Emit a step separator.
   *
   * @param position - The step position
   */
  stepSeparator(position: StepPosition): void {
    const event: StepSeparatorOutput = {
      type: 'step_separator',
      position,
    };
    this.renderer.render(event);
  }

  /**
   * Emit an informational message.
   *
   * @param text - The message text
   * @param level - The message level for styling
   */
  message(text: string, level: 'info' | 'success' | 'warning' | 'error' | 'dim' = 'info'): void {
    const event: MessageOutput = {
      type: 'message',
      text,
      level,
    };
    this.renderer.render(event);
  }

  /**
   * Emit a success message.
   *
   * @param text - The message text
   */
  success(text: string): void {
    this.message(text, 'success');
  }

  /**
   * Emit a warning message.
   *
   * @param text - The message text
   */
  warning(text: string): void {
    this.message(text, 'warning');
  }

  /**
   * Emit an error.
   *
   * Supports two call patterns:
   * - `error(message, code, details)` - Preferred: explicit error code
   * - `error(message, { code, details })` - Legacy: object-style details
   *
   * @param message - The error message
   * @param codeOrDetails - Either an error code string or legacy details object
   * @param details - Additional error details (when using code string)
   */
  error(
    message: string,
    codeOrDetails?: string | { code?: string; details?: Record<string, unknown> },
    details?: Record<string, unknown>,
  ): void {
    let code: string | undefined;
    let errorDetails: Record<string, unknown> | undefined;

    if (typeof codeOrDetails === 'string') {
      // New pattern: error(message, code, details)
      code = codeOrDetails;
      errorDetails = details;
    } else if (codeOrDetails) {
      // Legacy pattern: error(message, { code, details })
      code = codeOrDetails.code;
      errorDetails = codeOrDetails.details;
    }

    const event: ErrorOutput = {
      type: 'error',
      message,
      code,
      details: errorDetails,
    };
    this.renderer.render(event);
  }

  /**
   * Emit runbook completion.
   *
   * @param message - Optional completion message
   * @param position - Optional final position
   */
  complete(message?: string, position?: StepPosition): void {
    const event: CompleteOutput = {
      type: 'complete',
      message,
      position,
    };
    this.renderer.render(event);
  }

  /**
   * Emit runbook stopped.
   *
   * @param message - Optional stop message
   * @param position - Optional stop position
   */
  stopped(message?: string, position?: StepPosition): void {
    const event: StoppedOutput = {
      type: 'stopped',
      message,
      position,
    };
    this.renderer.render(event);
  }

  /**
   * Emit "no active runbook" message.
   *
   * @param action - Optional action/command that triggered this (for JSON output)
   * @param code - Optional error code (defaults to 'NO_ACTIVE_RUNBOOK')
   */
  noActiveRunbook(action?: string, code = 'NO_ACTIVE_RUNBOOK'): void {
    const event: NoActiveRunbookOutput = {
      type: 'no_active_runbook',
      action,
      code,
    };
    this.renderer.render(event);
  }

  /**
   * Bridge an execution event to the renderer.
   *
   * This method allows execution events from ExecutionEventEmitter to be
   * rendered through the unified output system, enabling both text and
   * JSON renderers to handle runbook execution events consistently.
   *
   * @param event - The execution event to render
   */
  executionEvent(event: RunbookEventV1): void {
    const outputEvent: ExecutionEventOutput = {
      type: 'execution_event',
      event,
    };
    this.renderer.render(outputEvent);
  }

  /**
   * Flush any buffered output.
   *
   * This must be called at the end of command execution to ensure
   * JSON output is properly emitted.
   */
  flush(): void {
    this.renderer.flush();
  }

  /**
   * Write raw JSON data directly.
   *
   * Use this for backwards compatibility when a specific JSON format is required.
   * This bypasses the event system and writes JSON directly to the output.
   * Only works in JSON mode - does nothing in text mode.
   *
   * @param data - The data to output as JSON
   */
  json(data: unknown): void {
    this.writer.writeJson(data);
  }

  /**
   * Check if JSON mode is enabled.
   *
   * Use this sparingly - prefer structured output methods when possible.
   *
   * @returns True if JSON output mode is enabled
   */
  isJson(): boolean {
    return this.renderer instanceof JSONRenderer;
  }

  /**
   * Get the underlying writer.
   *
   * @returns The configured OutputWriter
   */
  getWriter(): OutputWriter {
    return this.writer;
  }
}
