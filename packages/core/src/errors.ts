/**
 * Cached reference to the native `Error.isError` (TC39 Stage 4, Node 24+).
 *
 * Resolved once at module load. `undefined` on hosts that don't ship it yet
 * (notably WebContainer's bundled Node 22.x), in which case {@link isError}
 * falls back to `instanceof Error`. `.bind(Error)` guards against detached-call
 * lint rules and matches `Array.isArray` idioms.
 *
 * Direct `Error.isError(...)` calls are banned project-wide by ESLint
 * `no-restricted-syntax`; the rule allow-lists this file only.
 */
const nativeIsError: ((value: unknown) => value is Error) | undefined =
  typeof Error.isError === 'function' ? Error.isError.bind(Error) : undefined;

/**
 * Type guard for Error instances.
 *
 * Uses native `Error.isError` (Stage 4, Node 24+) when available — which
 * survives cross-realm boundaries (Jest VM modules, `vm.runInNewContext`,
 * worker_threads). Falls back to `instanceof Error` on older runtimes such
 * as WebContainer's Node 22.x. The fallback's only weakness is the
 * cross-realm edge case `instanceof` always had, which CLI process code
 * effectively never hits.
 *
 * @param error - The value to check
 * @returns True if the value is an Error instance, false otherwise
 */
export function isError(error: unknown): error is Error {
  return nativeIsError !== undefined ? nativeIsError(error) : error instanceof Error;
}

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
  return (
    isError(error) && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
  );
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
