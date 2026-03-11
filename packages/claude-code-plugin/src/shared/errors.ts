/**
 * Type guard for NodeJS.ErrnoException.
 * Checks if an unknown value is a Node.js error with an error code.
 *
 * @param error - The unknown value to check
 * @returns True if error is a NodeJS.ErrnoException with 'code' property
 */
export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return Error.isError(error) && 'code' in error;
}

/**
 * Type guard for Error instances.
 * Checks if an unknown value is an Error object.
 *
 * @param error - The unknown value to check
 * @returns True if error is an Error instance
 */
export function isError(error: unknown): error is Error {
  return Error.isError(error);
}

/**
 * Extract error message safely from any value.
 * Handles Error instances, strings, and other types.
 *
 * @param error - The unknown error value to extract message from
 * @returns The error message string
 */
export function getErrorMessage(error: unknown): string {
  if (isError(error)) {
    return error.message;
  }
  return String(error);
}

/**
 * Discriminated union for session load errors
 * Allows callers to handle each error type appropriately
 */
export type SessionLoadError =
  | { type: 'file_not_found'; path: string }
  | { type: 'parse_error'; path: string; message: string }
  | { type: 'validation_error'; path: string; message: string }
  | { type: 'io_error'; path: string; message: string };

/**
 * Result type for session load operations
 */
export type SessionLoadResult<T> =
  | { success: true; data: T }
  | { success: false; error: SessionLoadError };

/**
 * Check if error is file not found (expected on first run).
 * Type narrowing function for SessionLoadError discriminated union.
 *
 * @param error - The SessionLoadError to check
 * @returns True if error type is 'file_not_found'
 */
export function isFileNotFoundError(error: SessionLoadError): boolean {
  return error.type === 'file_not_found';
}
