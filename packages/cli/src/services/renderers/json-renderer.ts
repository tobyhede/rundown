/**
 * JSONRenderer - Renders output events as JSON.
 *
 * Handles two output modes:
 * - Simple commands: Accumulates events and outputs a single JSON object on flush()
 * - Execution events: Streams NDJSON (newline-delimited JSON) for real-time output
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

/**
 * Collected JSON output from events.
 */
interface JsonOutput {
  result?: boolean;
  action?: string;
  message?: string;
  error?: string;
  code?: string;
  data?: Record<string, unknown>;
  items?: unknown[];
  from?: {
    current: string;
    total: number | string;
    substep?: string;
    at?: string;
    for?: { index: number; end?: number };
  };
  to?: {
    current: string;
    total: number | string;
    substep?: string;
    at?: string;
    for?: { index: number; end?: number };
  };
  [key: string]: unknown;
}

type JsonPosition = {
  current: string;
  total: number;
  substep?: string;
  at?: string;
  for?: { index: number; end?: number };
};

/**
 * Renders output events as JSON.
 *
 * Accumulates events and outputs a single JSON object when flush() is called.
 * This ensures all command output is collected into one JSON response.
 *
 * For list-only output (e.g., `ls --json`), outputs a raw array instead of
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
  /** Track if NDJSON streaming has been used */
  private isNdjsonMode = false;

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
        break;
      case 'metadata':
        this.output.file = event.metadata.file;
        this.output.state = event.metadata.state;
        if (event.metadata.prompted) {
          this.output.prompted = event.metadata.prompted;
        }
        break;
      case 'status':
        this.output.result = event.result;
        this.output.action = event.action;
        if (event.message) {
          this.output.message = event.message;
        }
        if (event.data) {
          Object.assign(this.output, event.data);
        }
        break;
      case 'action':
        this.renderAction(event);
        break;
      case 'step_separator':
        // JSON doesn't need separators, but capture position
        this.output.position = this.toJsonPosition(event.position);
        break;
      case 'message':
        // Messages become info field or are captured in message
        if (event.level === 'error') {
          this.output.error = event.text;
        } else {
          this.output.message = event.text;
        }
        break;
      case 'error':
        this.output.result = false;
        this.output.error = event.message;
        if (event.code) {
          this.output.code = event.code;
        }
        if (event.details) {
          this.output.details = event.details;
        }
        break;
      case 'complete':
        this.output.result = true;
        this.output.action = 'complete';
        if (event.message) {
          this.output.message = event.message;
        }
        if (event.position) {
          this.output.position = this.toJsonPosition(event.position);
        }
        break;
      case 'stopped':
        this.output.result = false;
        this.output.action = 'stop';
        if (event.message) {
          this.output.message = event.message;
        }
        if (event.position) {
          this.output.position = this.toJsonPosition(event.position);
        }
        break;
      case 'no_active_runbook':
        this.output.result = false;
        this.output.error = 'No active runbook';
        if (event.action) {
          this.output.action = event.action;
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
   * When in NDJSON mode (streaming execution events), uses compact JSON
   * to maintain the NDJSON contract of one JSON object per line.
   */
  flush(): void {
    if (this.hasOutput) {
      // Use compact JSON in NDJSON mode to maintain single-line contract
      const pretty = !this.isNdjsonMode;

      // If only list events were emitted, output raw array
      if (this.isListOnly && this.listItems !== null) {
        this.writer.writeJson(this.listItems, pretty);
      } else {
        // Ensure result field exists (default based on error presence)
        this.output.result ??= !this.output.error;
        this.writer.writeJson(this.output, pretty);
      }
      this.output = {};
      this.listItems = null;
      this.isListOnly = true;
      this.isNdjsonMode = false;
      this.hasOutput = false;
    }
  }

  /**
   * Render a list event.
   *
   * Stores items both in the output object (for mixed output) and separately
   * for raw array output when this is the only event type.
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
   */
  private renderDetail(event: OutputEvent & { type: 'detail' }): void {
    Object.assign(this.output, event.data);
  }

  /**
   * Render an action event.
   */
  private renderAction(event: OutputEvent & { type: 'action' }): void {
    const block = event.block;

    this.output.action = block.action;
    if (block.result !== undefined) {
      this.output.result = block.result;
    }
    if (block.command) {
      this.output.command = block.command;
    }
    if (block.from) {
      this.output.from = this.toJsonPosition(block.from);
    }
    if (block.at) {
      this.output.to = this.toJsonPosition(block.at);
    }

    if (event.complete) {
      this.output.complete = true;
    }
    if (event.stopped) {
      this.output.stopped = true;
    }
  }

  /**
   * Render an execution event as NDJSON.
   *
   * Streams the event immediately as a newline-delimited JSON line,
   * enabling real-time output for execution commands.
   *
   * Includes full envelope fields (runbook, agentId, parentRunbookId, parentStepId)
   * to enable downstream tooling to attribute events in multi-agent or nested
   * runbook scenarios.
   *
   * @param event - The execution event to render
   */
  private renderExecutionEvent(event: RunbookEventV1): void {
    // Mark as NDJSON mode so flush() uses compact JSON
    this.isNdjsonMode = true;

    // Convert event type to snake_case for JSON output
    const eventType = this.toSnakeCase(event.type);

    // Build NDJSON line with full envelope and payload
    // Include all envelope fields for multi-agent/nested runbook attribution
    const ndjsonLine: Record<string, unknown> = {
      type: eventType,
      ...event.payload,
      timestamp: event.ts,
      runbookId: event.runbookId,
      runbook: event.runbook,
      seq: event.seq,
    };

    // Include optional envelope fields when present
    if (event.agentId !== undefined) {
      ndjsonLine.agentId = event.agentId;
    }
    if (event.parentRunbookId !== undefined) {
      ndjsonLine.parentRunbookId = event.parentRunbookId;
    }
    if (event.parentStepId !== undefined) {
      ndjsonLine.parentStepId = event.parentStepId;
    }

    // Stream immediately - don't buffer
    this.writer.writeLine(JSON.stringify(ndjsonLine));
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
  }): JsonPosition {
    return {
      current: position.current,
      total: position.total,
      ...(position.substep ? { substep: position.substep } : {}),
      at: derivePositionAt(position),
      ...(position.for ? { for: position.for } : {}),
    };
  }
}
