import type { OutputWriter, OutputStream } from './writer.js';

/**
 * Default OutputWriter implementation that writes to console.
 *
 * Routes output to stdout/stderr based on stream parameter.
 * This is the production implementation used by CLI commands.
 */
export class ConsoleWriter implements OutputWriter {
  write(text: string, stream: OutputStream = 'stdout'): void {
    if (stream === 'stderr') {
      process.stderr.write(text);
    } else {
      process.stdout.write(text);
    }
  }

  writeLine(text = '', stream: OutputStream = 'stdout'): void {
    if (stream === 'stderr') {
      console.error(text);
    } else {
      console.log(text);
    }
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
}
