/**
 * Type guard for NodeJS.ErrnoException
 */
export function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
/**
 * Type guard for Error instances
 */
export function isError(error) {
    return error instanceof Error;
}
/**
 * Extract error message safely
 */
export function getErrorMessage(error) {
    if (isError(error)) {
        return error.message;
    }
    return String(error);
}
/**
 * Check if error is file not found (expected on first run)
 */
export function isFileNotFoundError(error) {
    return error.type === 'file_not_found';
}
//# sourceMappingURL=errors.js.map