/**
 * JSONRenderer - Renders output events as JSON.
 *
 * Accumulates events and outputs a single JSON object on flush().
 * This ensures consistent machine-readable output format.
 *
 * @module renderers/json-renderer
 */

import {
  type OutputEvent,
  type OutputWriter,
  ConsoleWriter,
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
  from?: { current: string; total: number | string; substep?: string };
  to?: { current: string; total: number | string; substep?: string };
  [key: string]: unknown;
}

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

  /**
   * Create a new JSONRenderer.
   *
   * @param options - Renderer configuration options
   */
  constructor(options: RendererOptions = {}) {
    this.writer = options.writer ?? getWriter() ?? new ConsoleWriter();
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
        this.output.position = {
          current: event.position.current,
          total: event.position.total,
          ...(event.position.substep && { substep: event.position.substep }),
        };
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
          this.output.position = {
            current: event.position.current,
            total: event.position.total,
            ...(event.position.substep && { substep: event.position.substep }),
          };
        }
        break;
      case 'stopped':
        this.output.result = false;
        this.output.action = 'stop';
        if (event.message) {
          this.output.message = event.message;
        }
        if (event.position) {
          this.output.position = {
            current: event.position.current,
            total: event.position.total,
            ...(event.position.substep && { substep: event.position.substep }),
          };
        }
        break;
      case 'no_active_runbook':
        this.output.result = false;
        this.output.error = 'No active runbook';
        break;
    }
  }

  /**
   * Flush accumulated output as JSON.
   *
   * For list-only output, returns a raw array. Otherwise returns an object.
   */
  flush(): void {
    if (this.hasOutput) {
      // If only list events were emitted, output raw array
      if (this.isListOnly && this.listItems !== null) {
        this.writer.writeJson(this.listItems);
      } else {
        // Ensure result field exists (default based on error presence)
        this.output.result ??= !this.output.error;
        this.writer.writeJson(this.output);
      }
      this.output = {};
      this.listItems = null;
      this.isListOnly = true;
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
    const items = event.jsonMapper
      ? event.items.map(event.jsonMapper)
      : event.items;

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
    if (block.result) {
      // Set result boolean based on action result (PASS = true, FAIL = false)
      this.output.result = block.result === 'PASS';
    }
    if (block.command) {
      this.output.command = block.command;
    }
    if (block.from) {
      this.output.from = {
        current: block.from.current,
        total: block.from.total,
        ...(block.from.substep && { substep: block.from.substep }),
      };
    }
    if (block.at) {
      this.output.to = {
        current: block.at.current,
        total: block.at.total,
        ...(block.at.substep && { substep: block.at.substep }),
      };
    }

    if (event.complete) {
      this.output.complete = true;
    }
    if (event.stopped) {
      this.output.stopped = true;
    }
  }
}
