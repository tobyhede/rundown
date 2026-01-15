import {
  isNodeError,
  getErrorMessage,
  RundownError,
  Errors,
} from '@rundown/core';
import { WorkflowSyntaxError } from '@rundown/parser';

/**
 * Options for error handling behavior.
 */
interface ErrorHandlingOptions {
  /** Show verbose error output including description and docs link */
  verbose?: boolean;
  /** Output error as JSON */
  json?: boolean;
}

/**
 * Convert any error to a RundownError for consistent handling.
 *
 * @param error - The error to convert
 * @returns A RundownError instance
 */
function toRundownError(error: unknown): RundownError {
  // Already a RundownError
  if (error instanceof RundownError) {
    return error;
  }

  // Node.js system errors
  if (isNodeError(error)) {
    if (error.code === 'ENOENT') {
      return Errors.fileNotFound(error.path ?? 'unknown');
    }
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return Errors.fileNotReadable(error.path ?? 'unknown');
    }
  }

  // Legacy WorkflowSyntaxError from parser
  if (error instanceof WorkflowSyntaxError) {
    return Errors.syntaxError(error.message);
  }

  // Generic error - wrap it
  const message = getErrorMessage(error);
  return Errors.unknown(message, error instanceof Error ? error : undefined);
}

/**
 * Wraps an async function with standardized error handling for CLI commands.
 *
 * Catches errors, converts them to RundownError, and outputs appropriate
 * error messages before exiting with code 1.
 *
 * @param fn - Async function to execute with error handling
 * @param options - Error display options
 */
export async function withErrorHandling(
  fn: () => Promise<void>,
  options: ErrorHandlingOptions = {}
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const rundownError = toRundownError(error);

    if (options.json) {
      console.error(JSON.stringify(rundownError.toJSON(), null, 2));
    } else {
      console.error(rundownError.toCliString(options.verbose));
    }

    process.exit(1);
  }
}
