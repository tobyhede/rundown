/**
 * Shared table formatting utilities for CLI output.
 * Follows Linux CLI conventions: UPPERCASE headers, left-aligned text,
 * 2-space separators, last column extends to end.
 */

/**
 * Column definition for table formatting.
 */
export interface Column {
  /** Column header text (will be uppercased) */
  header: string;
  /** Key to extract value from row object */
  key: string;
  /** Alignment for this column (default: left) */
  align?: 'left' | 'right';
}

/**
 * Options for table formatting.
 */
export interface TableOptions {
  /** Separator between columns (default: '  ') */
  separator?: string;
}

/**
 * Format data as an aligned table with headers.
 *
 * @param rows - Array of row objects
 * @param columns - Column definitions
 * @param options - Formatting options
 * @returns Array of formatted lines (header + data rows)
 *
 * @example
 * ```ts
 * const lines = formatTable(
 *   [{ name: 'foo', desc: 'A foo' }],
 *   [{ header: 'NAME', key: 'name' }, { header: 'DESCRIPTION', key: 'desc' }]
 * );
 * // ['NAME  DESCRIPTION', 'foo   A foo']
 * ```
 */
export function formatTable(
  rows: Record<string, string | number | boolean | null | undefined>[],
  columns: Column[],
  options?: TableOptions
): string[] {
  const separator = options?.separator ?? '  ';

  // Calculate max width for each column (except last)
  const widths = columns.map((col, i) => {
    // Last column doesn't need padding
    if (i === columns.length - 1) return 0;

    const headerLen = col.header.length;
    const maxDataLen = rows.reduce((max, row) => {
      const value = String(row[col.key] ?? '');
      return Math.max(max, value.length);
    }, 0);
    return Math.max(headerLen, maxDataLen);
  });

  // Format header row
  const headerParts = columns.map((col, i) => {
    const header = col.header.toUpperCase();
    if (i === columns.length - 1) return header;
    return col.align === 'right' ? header.padStart(widths[i]) : header.padEnd(widths[i]);
  });
  const headerLine = headerParts.join(separator);

  // Format data rows
  const dataLines = rows.map((row) => {
    const parts = columns.map((col, i) => {
      const value = String(row[col.key] ?? '');
      if (i === columns.length - 1) return value;
      return col.align === 'right' ? value.padStart(widths[i]) : value.padEnd(widths[i]);
    });
    return parts.join(separator);
  });

  return [headerLine, ...dataLines];
}

/**
 * Print a table to stdout.
 *
 * @param rows - Array of row objects
 * @param columns - Column definitions
 * @param options - Formatting options
 */
export function printTable(
  rows: Record<string, string | number | boolean | null | undefined>[],
  columns: Column[],
  options?: TableOptions
): void {
  const lines = formatTable(rows, columns, options);
  for (const line of lines) {
    console.log(line);
  }
}
