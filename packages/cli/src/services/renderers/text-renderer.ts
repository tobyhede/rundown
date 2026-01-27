/**
 * TextRenderer - Renders output events as human-readable text.
 *
 * Uses the existing print functions from @rundown-org/core for consistent
 * formatting with the established CLI style.
 *
 * @module renderers/text-renderer
 */

import {
  type OutputEvent,
  type OutputWriter,
  type StepPosition,
  getWriter,
  printMetadata,
  printActionBlock,
  printStepSeparator,
  printRunbookComplete,
  printRunbookStopped,
  printRunbookStashed,
  printNoActiveRunbook,
  success,
  failure,
  warning,
  info,
  dim,
} from '@rundown-org/core';
import { formatTable } from '../../helpers/table-formatter.js';
import type { OutputRenderer, RendererOptions } from './types.js';

/**
 * Renders output events as human-readable text.
 *
 * Uses established CLI formatting conventions:
 * - Key-value pairs for detail views
 * - ASCII tables for lists
 * - Color-coded messages by level
 */
export class TextRenderer implements OutputRenderer {
  private writer: OutputWriter;

  /**
   * Create a new TextRenderer.
   *
   * @param options - Renderer configuration options
   */
  constructor(options: RendererOptions = {}) {
    this.writer = options.writer ?? getWriter();
  }

  /**
   * Render an output event as text.
   *
   * @param event - The output event to render
   */
  render(event: OutputEvent): void {
    switch (event.type) {
      case 'list':
        this.renderList(event);
        break;
      case 'detail':
        this.renderDetail(event);
        break;
      case 'metadata':
        printMetadata(event.metadata, this.writer);
        break;
      case 'status':
        this.renderStatus(event);
        break;
      case 'action':
        if (event.block.at) {
          printStepSeparator(event.block.at, this.writer);
        }
        printActionBlock(event.block, this.writer);
        break;
      case 'step_separator':
        printStepSeparator(event.position, this.writer);
        break;
      case 'message':
        this.renderMessage(event);
        break;
      case 'error':
        this.renderError(event);
        break;
      case 'complete':
        printRunbookComplete(event.message, this.writer);
        break;
      case 'stopped':
        printRunbookStopped(event.message, this.writer);
        break;
      case 'no_active_runbook':
        printNoActiveRunbook(this.writer);
        break;
    }
  }

  /**
   * Flush buffered output (no-op for text renderer).
   */
  flush(): void {
    // Text renderer outputs immediately, no buffering needed
  }

  /**
   * Render a list event as an ASCII table.
   */
  private renderList(event: OutputEvent & { type: 'list' }): void {
    if (event.items.length === 0) {
      if (event.emptyMessage) {
        this.writer.writeLine(event.emptyMessage);
      }
      return;
    }

    // Convert ColumnDef to the format expected by formatTable
    // ColumnDef.key can be a string key or a function
    // Column expects key (string) or get (function) as separate properties
    // Use Record<string, unknown> as the generic type to avoid type narrowing issues
    type Row = Record<string, unknown>;
    const columns = event.columns.map(col => {
      if (typeof col.key === 'function') {
        return {
          header: col.header,
          get: col.key as (row: Row) => string | number | boolean | undefined,
          align: col.align,
        };
      }
      return {
        header: col.header,
        key: col.key as keyof Row  ,
        align: col.align,
      };
    });

    const lines = formatTable(event.items as Row[], columns);
    this.writer.writeLines(lines);
  }

  /**
   * Render a detail event as key-value pairs.
   */
  private renderDetail(event: OutputEvent & { type: 'detail' }): void {
    // Format depends on the detail format type
    const data = event.data;

    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined && value !== null) {
        // Format key with padding for alignment
        const formattedKey = `${key.charAt(0).toUpperCase() + key.slice(1)}:`.padEnd(10);
        // Format value based on type - objects use JSON, primitives use String
        let formattedValue: string;
        if (typeof value === 'object') {
          formattedValue = JSON.stringify(value);
        } else if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean'
        ) {
          formattedValue = String(value);
        } else {
          // symbol, bigint, function - use JSON.stringify for safety
          formattedValue = JSON.stringify(value);
        }
        this.writer.writeLine(`${formattedKey}${formattedValue}`);
      }
    }
  }

  /**
   * Render a status event.
   *
   * Handles special cases for 'stash' and 'pop' actions that require
   * position-aware formatting.
   */
  private renderStatus(event: OutputEvent & { type: 'status' }): void {
    // Handle stash action with position data specially
    if (event.action === 'stash' && event.data?.position) {
      const pos = event.data.position as StepPosition;
      printRunbookStashed(pos, this.writer);
      return;
    }

    // Handle pop action - show success message with step info
    if (event.action === 'pop' && event.message) {
      this.writer.writeLine(success(event.message));
      return;
    }

    // Default: render message with appropriate color
    if (event.message) {
      const colorFn = event.result ? success : failure;
      this.writer.writeLine(colorFn(event.message));
    }
  }

  /**
   * Render a message event with appropriate styling.
   */
  private renderMessage(event: OutputEvent & { type: 'message' }): void {
    let coloredText: string;
    switch (event.level) {
      case 'success':
        coloredText = success(event.text);
        break;
      case 'warning':
        coloredText = warning(event.text);
        break;
      case 'error':
        coloredText = failure(event.text);
        break;
      case 'info':
        coloredText = info(event.text);
        break;
      case 'dim':
        coloredText = dim(event.text);
        break;
      default:
        coloredText = event.text;
    }
    this.writer.writeLine(coloredText);
  }

  /**
   * Render an error event.
   */
  private renderError(event: OutputEvent & { type: 'error' }): void {
    this.writer.writeError(failure(`Error: ${event.message}`));
    if (event.code) {
      this.writer.writeError(dim(`Code: ${event.code}`));
    }
  }
}
