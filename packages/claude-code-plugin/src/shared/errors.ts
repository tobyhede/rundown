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
 * Checks if an unknown value is an Error object.
 *
 * Uses native `Error.isError` when available (Node 24+); falls back to
 * `instanceof Error` on older runtimes (e.g. WebContainer's Node 22.x).
 *
 * @param error - The unknown value to check
 * @returns True if error is an Error instance
 */
export function isError(error: unknown): error is Error {
  return nativeIsError !== undefined ? nativeIsError(error) : error instanceof Error;
}

/**
 * Type guard for NodeJS.ErrnoException.
 * Checks if an unknown value is a Node.js error with an error code.
 *
 * @param error - The unknown value to check
 * @returns True if error is a NodeJS.ErrnoException with 'code' property
 */
export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return (
    isError(error) && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
  );
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
 * Check if a value looks like a single Zod issue entry.
 *
 * @param value - The value to check
 * @returns True if value has `path` (array) and `message` (string) fields
 */
function isZodIssueLike(
  value: unknown,
): value is { path: Array<string | number>; message: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'path' in value &&
    Array.isArray(value.path) &&
    'message' in value &&
    typeof (value as { message: unknown }).message === 'string'
  );
}

/**
 * Structural type guard for ZodError.
 * Uses property checking instead of `instanceof` to work across ESM realm boundaries.
 *
 * @param error - The unknown value to check
 * @returns True if error has a ZodError-shaped `issues` array
 */
export function isZodError(
  error: unknown,
): error is { issues: Array<{ path: Array<string | number>; message: string }> } {
  if (typeof error !== 'object' || error === null || !('issues' in error)) return false;
  const issues = error.issues;
  if (!Array.isArray(issues) || issues.length === 0) return false;
  return issues.every(isZodIssueLike);
}
