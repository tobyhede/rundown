/**
 * JSONRenderer - Renders output events as JSON.
 *
 * Handles two output modes:
 * - Simple commands: Accumulates events and outputs a single JSON object on flush()
 * - Execution events: Streams JSONL (JSON Lines) for real-time output
 *
 * This unified approach allows both simple commands (check, ls) to maintain
 * backward compatibility with single-object JSON output, while execution
 * commands (run, pass, fail) stream events as they happen.
 *
 * @module renderers/json-renderer
 */

import {
  derivePositionAt,
  type OutputEvent,
  type OutputWriter,
  type RunbookEventV1,
  getWriter,
} from '@rundown-org/core';
import type { OutputRenderer, RendererOptions } from './types.js';

type JsonPosition = {
  current: string;
  total: number;
  substep?: string;
  at?: string;
  for?: { index: number; end?: number };
  frameKey?: string;
  entry?: number;
  unresolved?: number;
};

/**
 * Collected JSON output from events.
 */
interface JsonOutput {
  kind?: string;
  stepResult?: 'PASS' | 'FAIL';
  action?: string;
  message?: string;
  error?: string;
  code?: string;
  data?: Record<string, unknown>;
  items?: unknown[];
  from?: JsonPosition | string;
  at?: string;
  [key: string]: unknown;
}

/**
 * Renders output events as JSON.
 *
 * Accumulates events and outputs a single JSON object when flush() is called.
 * This ensures all command output is collected into one JSON response.
 *
 * For list-only output (e.g., `ls`), outputs a raw array instead of
 * wrapping in `{ items: [...] }`.
 */
export class JSONRenderer implements OutputRenderer {
  private writer: OutputWriter;
  private output: JsonOutput = {};
  private hasOutput = false;
  /** Raw list items for list-only output */
  private listItems: unknown[] | null = null;
  /** Track if only list events have been emitted */
  private isListOnly = true;
  /** Track if JSONL streaming has been used */
  private isJsonlMode = false;

  /**
   * Create a new JSONRenderer.
   *
   * @param options - Renderer configuration options
   */
  constructor(options: RendererOptions = {}) {
    this.writer = options.writer ?? getWriter();
  }

  /**
   * Render an output event by accumulating it into the JSON output.
   *
   * @param event - The output event to render
   */
  render(event: OutputEvent): void {
    this.hasOutput = true;

    // Track if any non-list events are emitted
    if (event.type !== 'list') {
      this.isListOnly = false;
    }

    switch (event.type) {
      case 'list':
        this.renderList(event);
        break;
      case 'detail':
        this.renderDetail(event);
        // Derive kind from detail format
        this.deriveKindFromDetail(event);
        break;
      case 'metadata':
        this.output.file = event.metadata.file;
        this.output.state = event.metadata.state;
        if (event.metadata.prompted) {
          this.output.prompted = event.metadata.prompted;
        }
        break;
      case 'status':
        this.output.action = event.action;
        if (event.message) {
          this.output.message = event.message;
        }
        if (event.data) {
          Object.assign(this.output, event.data);
        }
        // Derive kind from status action
        if (event.action === 'stash') {
          this.output.kind = 'stash';
        } else if (event.action === 'pop') {
          this.output.kind = 'pop';
        } else {
          this.output.kind = 'action';
        }
        break;
      case 'action':
        this.renderAction(event);
        this.output.kind = 'action';
        break;
      case 'step_separator':
        // JSON doesn't need separators, but capture position
        this.output.position = this.toJsonPosition(event.position);
        break;
      case 'message':
        if (event.level === 'error') {
          this.output.error = event.text;
        } else if (event.level === 'warning') {
          // Warnings go to stderr — keep JSON stdout clean
          this.writer.writeLine(`Warning: ${event.text}`, 'stderr');
        } else {
          this.output.message = event.text;
        }
        break;
      case 'error':
        this.output.error = event.message;
        this.output.kind = 'error';
        if (event.code) {
          this.output.code = event.code;
        }
        if (event.command) {
          this.output.command = event.command;
        }
        if (event.details) {
          this.output.details = event.details;
        }
        break;
      case 'complete':
        this.output.action = 'complete';
        this.output.complete = true;
        this.output.kind = 'action';
        if (event.message) {
          this.output.message = event.message;
        }
        if (event.position) {
          this.output.position = this.toJsonPosition(event.position);
        }
        break;
      case 'stopped':
        this.output.action = 'stop';
        this.output.stopped = true;
        this.output.kind = 'action';
        if (event.message) {
          this.output.message = event.message;
        }
        if (event.position) {
          this.output.position = this.toJsonPosition(event.position);
        }
        break;
      case 'no_active_runbook':
        this.output.error = 'No active runbook';
        this.output.kind = 'error';
        if (event.command) {
          this.output.command = event.command;
        }
        if (event.code) {
          this.output.code = event.code;
        }
        break;
      case 'execution_event':
        this.renderExecutionEvent(event.event);
        break;
    }
  }

  /**
   * Flush accumulated output as JSON.
   *
   * For list-only output, returns a raw array. Otherwise returns an object.
   * When in JSONL mode (streaming execution events), uses compact JSON
   * to maintain the JSONL contract of one JSON object per line.
   */
  flush(): void {
    if (this.hasOutput) {
      // Use compact JSON in JSONL mode to maintain single-line contract
      const pretty = !this.isJsonlMode;

      // If only list events were emitted, output raw array
      if (this.isListOnly && this.listItems !== null) {
        this.writer.writeJson(this.listItems, pretty);
      } else if (!this.isJsonlMode || Object.keys(this.output).length > 0) {
        // In JSONL mode, events stream directly via writer.writeLine. Action /
        // detail events still accumulate into `this.output`, so flush it when
        // it has content (e.g. the `rd claim` claimed-action object). Skip it
        // only when JSONL streamed everything and the accumulator is empty —
        // otherwise every streamed run would append a stray `{}`.
        this.writer.writeJson(this.output, pretty);
      }
      this.output = {};
      this.listItems = null;
      this.isListOnly = true;
      this.isJsonlMode = false;
      this.hasOutput = false;
    }
  }

  /**
   * Render a list event.
   *
   * Stores items both in the output object (for mixed output) and separately
   * for raw array output when this is the only event type.
   * @param event - The list output event containing items and optional JSON mapper
   */
  private renderList(event: OutputEvent & { type: 'list' }): void {
    const items = event.jsonMapper ? event.items.map(event.jsonMapper) : event.items;

    // Store for raw array output
    this.listItems = items;
    // Also store in output object for mixed output scenarios
    this.output.items = items;
  }

  /**
   * Render a detail event.
   * @param event - The detail output event containing format-specific data
   */
  private renderDetail(event: OutputEvent & { type: 'detail' }): void {
    Object.assign(this.output, event.data);
  }

  /**
   * Derive response kind from a detail event's format.
   *
   * For named formats, maps directly to the corresponding kind.
   * For 'custom' format, the kind should already be set in the data.
   *
   * @param event - The detail output event
   */
  private deriveKindFromDetail(event: OutputEvent & { type: 'detail' }): void {
    switch (event.format) {
      case 'status':
        this.output.kind = 'status';
        return;
      case 'check':
        this.output.kind = 'check';
        return;
      case 'resolve':
        this.output.kind = 'resolve';
        return;
      case 'echo':
        this.output.kind = 'echo';
        return;
      case 'prompt':
        this.output.kind = 'prompt';
        return;
      case 'scenario_result':
        this.output.kind = 'scenario_run';
        return;
      case 'metadata':
      case 'step':
      case 'scenario':
      case 'custom':
        // kind set in data or by caller
        return;
      default: {
        const _exhaustive: never = event.format;
        void _exhaustive;
      }
    }
  }

  /**
   * Render an action event.
   * @param event - The action output event containing transition block data
   */
  private renderAction(event: OutputEvent & { type: 'action' }): void {
    const block = event.block;

    this.output.action = block.action;
    if (block.result !== undefined) {
      this.output.stepResult = block.result;
    }
    if (block.command) {
      this.output.command = block.command;
    }
    if (block.from) {
      this.output.from = block.from;
    }
    if (block.at) {
      this.output.at = block.at;
    }

    if (event.complete) {
      this.output.complete = true;
    }
    if (event.stopped) {
      this.output.stopped = true;
    }
  }

  /**
   * Render an execution event as JSONL.
   *
   * Streams the event immediately as a JSON Lines entry,
   * enabling real-time output for execution commands.
   *
   * Includes envelope fields (runbook, agentId, parentStepId) to enable
   * downstream tooling to attribute events in nested runbook scenarios.
   *
   * @param event - The execution event to render
   */
  private renderExecutionEvent(event: RunbookEventV1): void {
    // Mark as JSONL mode so flush() uses compact JSON
    this.isJsonlMode = true;

    // Convert event type to snake_case for JSON output
    const eventType = this.toSnakeCase(event.type);

    // Build JSONL line with full envelope and payload
    // Include all envelope fields for multi-agent/nested runbook attribution
    const jsonlLine: Record<string, unknown> = {
      type: eventType,
      ...event.payload,
      timestamp: event.ts,
      runbookId: event.runbookId,
      runbook: event.runbook,
      seq: event.seq,
    };

    // Include optional envelope fields when present
    if (event.agentId !== undefined) {
      jsonlLine.agentId = event.agentId;
    }
    if (event.parentStepId !== undefined) {
      jsonlLine.parentStepId = event.parentStepId;
    }

    // Stream immediately - don't buffer
    this.writer.writeLine(JSON.stringify(jsonlLine));
  }

  /**
   * Convert UPPER_SNAKE_CASE to lower_snake_case.
   *
   * @param str - The string to convert
   * @returns The converted string
   */
  private toSnakeCase(str: string): string {
    return str.toLowerCase();
  }

  private toJsonPosition(position: {
    current: string;
    total: number;
    substep?: string;
    for?: { index: number; end?: number };
    frameKey?: string;
    entry?: number;
    unresolved?: number;
  }): JsonPosition {
    return {
      current: position.current,
      total: position.total,
      ...(position.substep ? { substep: position.substep } : {}),
      at: derivePositionAt(position),
      ...(position.for ? { for: position.for } : {}),
      ...(position.frameKey ? { frameKey: position.frameKey } : {}),
      ...(position.entry !== undefined ? { entry: position.entry } : {}),
      ...(position.unresolved !== undefined ? { unresolved: position.unresolved } : {}),
    };
  }
}
