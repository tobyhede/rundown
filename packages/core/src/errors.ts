/**
 * Type guard for NodeJS.ErrnoException.
 *
 * Checks if the given value is an Error instance with a 'code' property,
 * indicating it is a Node.js system error (e.g., ENOENT, EACCES).
 *
 * @param error - The value to check
 * @returns True if the value is a NodeJS.ErrnoException, false otherwise
 */
export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/**
 * Type guard for Error instances.
 *
 * Checks if the given value is an instance of the Error class.
 *
 * @param error - The value to check
 * @returns True if the value is an Error instance, false otherwise
 */
export function isError(error: unknown): error is Error {
  return error instanceof Error;
}

/**
 * Extract error message safely.
 *
 * Returns the error's message property if it is an Error instance,
 * otherwise converts the value to a string.
 *
 * @param error - The value to extract a message from
 * @returns The error message string
 */
export function getErrorMessage(error: unknown): string {
  if (isError(error)) {
    return error.message;
  }
  return String(error);
}

/**
 * Discriminated union for session load errors.
 *
 * Represents the possible error types when loading a session:
 * - `file_not_found`: The session file does not exist (expected on first run)
 * - `parse_error`: The file exists but contains invalid JSON
 * - `validation_error`: The JSON is valid but does not match the expected schema
 *
 * Allows callers to handle each error type appropriately using type narrowing.
 */
export type SessionLoadError =
  | { type: 'file_not_found'; path: string }
  | { type: 'parse_error'; path: string; message: string }
  | { type: 'validation_error'; path: string; message: string };

/**
 * Result type for session load operations.
 *
 * A discriminated union representing either successful data retrieval
 * or a structured error. Use the `success` field to narrow the type.
 */
export type SessionLoadResult<T> =
  | { success: true; data: T }
  | { success: false; error: SessionLoadError };

/**
 * Check if error is file not found (expected on first run).
 *
 * Helper function to determine if a session load error indicates
 * the file does not exist, which is expected on first run.
 *
 * @param error - The SessionLoadError to check
 * @returns True if the error type is 'file_not_found', false otherwise
 */
export function isFileNotFoundError(error: SessionLoadError): boolean {
  return error.type === 'file_not_found';
}

// Re-export error code system
export * from './errors/index.js';
