import {
  isNodeError,
  isError,
  getErrorMessage,
  RundownError,
  Errors,
  getWriter,
} from '@rundown-org/core';
import { RunbookSyntaxError } from '@rundown-org/parser';

/**
 * Options for error handling behavior.
 */
interface ErrorHandlingOptions {
  /** Show verbose error output including description and docs link */
  verbose?: boolean;
  /** Output error as human-readable text instead of JSON (JSON is the default) */
  text?: boolean;
  /** CLI command name to include in the error envelope when known. */
  command?: string;
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

  // Legacy RunbookSyntaxError from parser
  if (error instanceof RunbookSyntaxError) {
    return Errors.syntaxError(error.message);
  }

  // Generic error - wrap it
  const message = getErrorMessage(error);
  return Errors.unknown(message, isError(error) ? error : undefined);
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
  options: ErrorHandlingOptions = {},
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const rundownError = toRundownError(error);

    if (options.text) {
      console.error(rundownError.toCliString(options.verbose));
    } else {
      // Emit the documented error envelope (see docs/spec/cli-output.md
      // § Key Conventions): { kind: "error", error, code, command?, details? }.
      // This matches the shape OutputEmitter.error / JSONRenderer produce so
      // consumers see one consistent error JSON across all paths. The
      // RundownError-specific fields (category, title, context, docsUrl) ride
      // in `details` so no information is lost.
      const envelope: Record<string, unknown> = {
        kind: 'error',
        error: rundownError.message,
        code: rundownError.code,
      };
      if (options.command !== undefined) {
        envelope.command = options.command;
      }
      // RundownError-specific metadata travels in `details` so the documented
      // envelope is preserved while no information from RundownError.toJSON()
      // is lost.
      envelope.details = {
        category: rundownError.errorCode.category,
        title: rundownError.errorCode.title,
        context: rundownError.context,
        docsUrl: rundownError.docsUrl,
      };
      getWriter().writeJson(envelope);
    }

    process.exit(1);
  }
}
