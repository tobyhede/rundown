import { OutputWriter, ConsoleWriter } from '@rundown/core';
import { formatTable, Column } from '../helpers/table-formatter.js';

export interface OutputManagerOptions {
  /** Whether to output in JSON format */
  json?: boolean;
  /** Custom writer to use (default: ConsoleWriter) */
  writer?: OutputWriter;
}

/**
 * Options for configuring list output behavior in both text and JSON modes.
 */
export interface ListOptions<T, U = T> {
  /** Message to display if list is empty (text mode only) */
  emptyMessage?: string;
  /** Optional mapper to transform data for JSON output */
  jsonMapper?: (item: T) => U;
}

/**
 * Manages CLI output rendering, handling switching between
 * human-readable (Text/Table) and machine-readable (JSON) formats.
 * 
 * This service allows commands to be output-agnostic. It routes data
 * to either a structured JSON stream or formatted text output based
 * on the configuration.
 */
export class OutputManager {
  private json: boolean;
  private writer: OutputWriter;

  /**
   * Create a new OutputManager.
   * @param options - Configuration options for the manager
   */
  constructor(options: OutputManagerOptions = {}) {
    this.json = options.json ?? false;
    this.writer = options.writer ?? new ConsoleWriter();
  }

  /**
   * Output a list of items.
   * 
   * In JSON mode, outputs a JSON array of items (mapped if jsonMapper provided).
   * In Text mode, outputs a formatted ASCII table.
   * 
   * @param items - The list of items to output
   * @param columns - Column definitions for table output
   * @param options - Additional options for handling empty lists or JSON mapping
   */
  list<T, U = T>(items: T[], columns: Column<T>[], options?: ListOptions<T, U>): void {
    if (this.json) {
      const data = options?.jsonMapper ? items.map(options.jsonMapper) : items;
      this.writer.writeJson(data);
      return;
    }

    if (items.length === 0) {
      if (options?.emptyMessage) {
        this.writer.writeLine(options.emptyMessage);
      }
      return;
    }

    // Use formatTable to get lines and write them using the configured writer
    const lines = formatTable(items, columns);
    this.writer.writeLines(lines);
  }

  /**
   * Check if JSON mode is enabled.
   * @returns True if JSON output is enabled
   */
  isJson(): boolean {
    return this.json;
  }

  /**
   * Get the underlying writer.
   * @returns The configured OutputWriter instance
   */
  getWriter(): OutputWriter {
    return this.writer;
  }
}
