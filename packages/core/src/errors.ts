import { RundownError } from './errors/rundown-error.js';

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
 * Check whether a value is a Node.js system error with a specific error code.
 *
 * @param error - The value to check
 * @param code - Expected Node.js error code such as `ENOENT` or `EACCES`
 * @returns True when the value is a NodeJS.ErrnoException with the exact code
 */
export function isNodeErrorCode(error: unknown, code: string): boolean {
  return isNodeError(error) && error.code === code;
}

/**
 * Check whether an error is a {@link RundownError} carrying a specific code.
 *
 * The `RundownError` counterpart to {@link isNodeErrorCode}. Callers discriminate
 * on the CODE rather than on a message substring, which a harmless reword would
 * silently break. Generic rather than one bespoke predicate per code, so RD-824's
 * successors get the same guarantee for free (#519).
 *
 * `instanceof` is correct here and is not a lint violation: `RundownError` is a
 * same-realm custom error class, which CLAUDE.md's Testing Conventions exempt
 * explicitly. `Error.isError()` is for cross-realm NATIVE errors and would not
 * answer this question.
 *
 * Returns a type predicate rather than a bare `boolean` (the one place this
 * deliberately improves on its {@link isNodeErrorCode} template): at a
 * `catch (error: unknown)` site, narrowing to `RundownError` is what unlocks
 * `.code` / `.context` / `.toJSON()` without a cast.
 *
 * @param error - Any thrown value.
 * @param code - The `RD-xxx` code string to match (pass `ErrorCodes.X.code`).
 * @returns True when `error` is a `RundownError` whose code matches.
 */
export function isRundownErrorCode(error: unknown, code: string): error is RundownError {
  return error instanceof RundownError && error.code === code;
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
