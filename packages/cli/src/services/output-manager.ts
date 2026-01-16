import { OutputWriter, ConsoleWriter } from '@rundown/core';
import { formatTable, Column } from '../helpers/table-formatter.js';

export interface OutputManagerOptions {
  json?: boolean;
  writer?: OutputWriter;
}

export interface ListOptions<T, U = T> {
  /** Message to display if list is empty (text mode only) */
  emptyMessage?: string;
  /** Optional mapper to transform data for JSON output */
  jsonMapper?: (item: T) => U;
}

/**
 * Manages CLI output rendering, handling switching between
 * human-readable (Text/Table) and machine-readable (JSON) formats.
 */
export class OutputManager {
  private json: boolean;
  private writer: OutputWriter;

  constructor(options: OutputManagerOptions = {}) {
    this.json = options.json ?? false;
    this.writer = options.writer ?? new ConsoleWriter();
  }

  /**
   * Output a list of items.
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
   */
  isJson(): boolean {
    return this.json;
  }

  /**
   * Get the underlying writer.
   */
  getWriter(): OutputWriter {
    return this.writer;
  }
}
