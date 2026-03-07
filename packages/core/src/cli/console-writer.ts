import type { OutputWriter, OutputStream } from './writer.js';

/**
 * Default OutputWriter implementation that writes to console.
 *
 * Routes output to stdout/stderr based on stream parameter.
 * This is the production implementation used by CLI commands.
 */
export class ConsoleWriter implements OutputWriter {
  /**
   * Write raw text to the specified output stream.
   *
   * @param text - The text to write
   * @param stream - Target output stream (defaults to stdout)
   */
  write(text: string, stream: OutputStream = 'stdout'): void {
    if (stream === 'stderr') {
      process.stderr.write(text);
    } else {
      process.stdout.write(text);
    }
  }

  /**
   * Write text followed by a newline to the specified output stream.
   *
   * @param text - The text to write (defaults to empty string for blank line)
   * @param stream - Target output stream (defaults to stdout)
   */
  writeLine(text = '', stream: OutputStream = 'stdout'): void {
    this.write(`${text}\n`, stream);
  }

  /**
   * Write multiple lines to the specified output stream.
   *
   * @param lines - Array of text lines to write
   * @param stream - Target output stream (defaults to stdout)
   */
  writeLines(lines: string[], stream: OutputStream = 'stdout'): void {
    for (const line of lines) {
      this.writeLine(line, stream);
    }
  }

  /**
   * Write text to stderr.
   *
   * @param text - The error text to write
   */
  writeError(text: string): void {
    this.writeLine(text, 'stderr');
  }

  /**
   * Write data as JSON to stdout.
   *
   * @param data - The data to serialize to JSON
   * @param pretty - Whether to pretty-print with indentation (defaults to true)
   */
  writeJson(data: unknown, pretty = true): void {
    const json = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
    this.writeLine(json);
  }
}
