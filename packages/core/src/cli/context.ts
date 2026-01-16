import type { OutputWriter } from './writer.js';
import { ConsoleWriter } from './console-writer.js';

/**
 * Global output writer instance.
 * Defaults to ConsoleWriter for production use.
 */
let globalWriter: OutputWriter = new ConsoleWriter();

/**
 * Get the current global output writer.
 *
 * @returns The active OutputWriter instance
 */
export function getWriter(): OutputWriter {
  return globalWriter;
}

/**
 * Set the global output writer.
 * Used for testing and custom output targets.
 *
 * @param writer - OutputWriter instance to use globally
 * @returns The previous writer (for restoration)
 */
export function setWriter(writer: OutputWriter): OutputWriter {
  const previous = globalWriter;
  globalWriter = writer;
  return previous;
}

/**
 * Execute a function with a specific writer, then restore.
 * Useful for testing and isolated output contexts.
 *
 * @param writer - OutputWriter to use during execution
 * @param fn - Function to execute
 * @returns Result of the function
 */
export function withWriter<T>(writer: OutputWriter, fn: () => T): T {
  const previous = setWriter(writer);
  try {
    return fn();
  } finally {
    setWriter(previous);
  }
}

/**
 * Async version of withWriter.
 *
 * @param writer - OutputWriter to use during execution
 * @param fn - Async function to execute
 * @returns Promise resolving to the function result
 */
export async function withWriterAsync<T>(
  writer: OutputWriter,
  fn: () => Promise<T>
): Promise<T> {
  const previous = setWriter(writer);
  try {
    return await fn();
  } finally {
    setWriter(previous);
  }
}
