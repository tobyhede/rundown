import type { OutputWriter, OutputStream } from './writer.js';
import { serializeJsonForOutput } from './json-serialization.js';

/**
 * Captured output entry for test assertions.
 */
export interface CapturedOutput {
  text: string;
  stream: OutputStream;
}

/**
 * OutputWriter implementation that captures output for testing.
 *
 * @example
 * ```ts
 * const writer = new TestWriter();
 * printMetadata(metadata, writer);
 *
 * expect(writer.getOutput()).toContain('File:');
 * expect(writer.getLines()).toHaveLength(3);
 * ```
 */
export class TestWriter implements OutputWriter {
  private output: CapturedOutput[] = [];

  /**
   * Capture raw text output.
   *
   * @param text - The text to capture
   * @param stream - Target output stream (defaults to stdout)
   */
  write(text: string, stream: OutputStream = 'stdout'): void {
    this.output.push({ text, stream });
  }

  /**
   * Capture text with a trailing newline.
   *
   * @param text - The text to capture (defaults to empty string for blank line)
   * @param stream - Target output stream (defaults to stdout)
   */
  writeLine(text = '', stream: OutputStream = 'stdout'): void {
    this.output.push({ text: `${text}\n`, stream });
  }

  /**
   * Capture multiple lines of text.
   *
   * @param lines - Array of text lines to capture
   * @param stream - Target output stream (defaults to stdout)
   */
  writeLines(lines: string[], stream: OutputStream = 'stdout'): void {
    for (const line of lines) {
      this.writeLine(line, stream);
    }
  }

  /**
   * Capture error text to stderr.
   *
   * @param text - The error text to capture
   */
  writeError(text: string): void {
    this.writeLine(text, 'stderr');
  }

  /**
   * Capture data as JSON output.
   *
   * @param data - The data to serialize to JSON
   * @param pretty - Whether to pretty-print with indentation (defaults to true)
   */
  writeJson(data: unknown, pretty = true): void {
    this.write(`${serializeJsonForOutput(data, pretty)}\n`);
  }

  // Test helper methods

  /**
   * Get all captured output as a single string.
   *
   * @param stream - Filter by stream (optional)
   * @returns Concatenated output text
   */
  getOutput(stream?: OutputStream): string {
    const filtered = stream ? this.output.filter((o) => o.stream === stream) : this.output;
    return filtered.map((o) => o.text).join('');
  }

  /**
   * Get captured output as array of lines (trimmed, non-empty).
   *
   * @param stream - Filter by stream (optional)
   * @returns Array of non-empty trimmed lines
   */
  getLines(stream?: OutputStream): string[] {
    return this.getOutput(stream)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  /**
   * Get stdout output only.
   *
   * @returns Concatenated stdout output text
   */
  getStdout(): string {
    return this.getOutput('stdout');
  }

  /**
   * Get stderr output only.
   *
   * @returns Concatenated stderr output text
   */
  getStderr(): string {
    return this.getOutput('stderr');
  }

  /**
   * Clear captured output.
   */
  clear(): void {
    this.output = [];
  }

  /**
   * Get raw captured entries for detailed assertions.
   *
   * @returns Read-only array of captured output entries
   */
  getRawOutput(): readonly CapturedOutput[] {
    return this.output;
  }
}
