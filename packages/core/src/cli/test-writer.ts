import type { OutputWriter, OutputStream } from './writer.js';

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

  write(text: string, stream: OutputStream = 'stdout'): void {
    this.output.push({ text, stream });
  }

  writeLine(text = '', stream: OutputStream = 'stdout'): void {
    this.output.push({ text: text + '\n', stream });
  }

  writeLines(lines: string[], stream: OutputStream = 'stdout'): void {
    for (const line of lines) {
      this.writeLine(line, stream);
    }
  }

  writeError(text: string): void {
    this.writeLine(text, 'stderr');
  }

  writeJson(data: unknown, pretty = true): void {
    const json = pretty
      ? JSON.stringify(data, null, 2)
      : JSON.stringify(data);
    this.writeLine(json);
  }

  // Test helper methods

  /**
   * Get all captured output as a single string.
   *
   * @param stream - Filter by stream (optional)
   */
  getOutput(stream?: OutputStream): string {
    const filtered = stream
      ? this.output.filter((o) => o.stream === stream)
      : this.output;
    return filtered.map((o) => o.text).join('');
  }

  /**
   * Get captured output as array of lines (trimmed, non-empty).
   *
   * @param stream - Filter by stream (optional)
   */
  getLines(stream?: OutputStream): string[] {
    return this.getOutput(stream)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  /**
   * Get stdout output only.
   */
  getStdout(): string {
    return this.getOutput('stdout');
  }

  /**
   * Get stderr output only.
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
   */
  getRawOutput(): readonly CapturedOutput[] {
    return this.output;
  }
}
