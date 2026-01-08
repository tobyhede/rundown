/**
 * Type guard for NodeJS.ErrnoException
 */
export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/**
 * Type guard for Error instances
 */
export function isError(error: unknown): error is Error {
  return error instanceof Error;
}

/**
 * Extract error message safely
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
  | { type: 'validation_error'; path: string; message: string };

/**
 * Result type for session load operations
 */
export type SessionLoadResult<T> =
  | { success: true; data: T }
  | { success: false; error: SessionLoadError };

/**
 * Check if error is file not found (expected on first run)
 */
export function isFileNotFoundError(error: SessionLoadError): boolean {
  return error.type === 'file_not_found';
}
