/**
 * Output stream types for CLI output routing.
 */
export type OutputStream = 'stdout' | 'stderr';

/**
 * Interface for abstracting CLI output operations.
 *
 * Implementations can target different outputs:
 * - Console (default production)
 * - Test capture (for assertions)
 * - File logging (future)
 *
 * @example
 * ```ts
 * const writer: OutputWriter = getWriter();
 * writer.writeLine('Processing...');
 * writer.writeError('Validation failed');
 * ```
 */
export interface OutputWriter {
  /**
   * Write text without trailing newline.
   *
   * @param text - Text to output
   * @param stream - Target stream (default: 'stdout')
   */
  write(text: string, stream?: OutputStream): void;

  /**
   * Write text followed by newline.
   *
   * @param text - Text to output (empty string for blank line)
   * @param stream - Target stream (default: 'stdout')
   */
  writeLine(text?: string, stream?: OutputStream): void;

  /**
   * Write multiple lines.
   *
   * @param lines - Array of lines to output
   * @param stream - Target stream (default: 'stdout')
   */
  writeLines(lines: string[], stream?: OutputStream): void;

  /**
   * Write error message to stderr.
   *
   * @param text - Error message to output
   */
  writeError(text: string): void;

  /**
   * Write JSON-serialized data.
   *
   * @param data - Data to serialize and output
   * @param pretty - Whether to pretty-print (default: true)
   */
  writeJson(data: unknown, pretty?: boolean): void;
}
