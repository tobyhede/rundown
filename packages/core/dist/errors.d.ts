/**
 * Type guard for NodeJS.ErrnoException
 */
export declare function isNodeError(error: unknown): error is NodeJS.ErrnoException;
/**
 * Type guard for Error instances
 */
export declare function isError(error: unknown): error is Error;
/**
 * Extract error message safely
 */
export declare function getErrorMessage(error: unknown): string;
/**
 * Discriminated union for session load errors
 * Allows callers to handle each error type appropriately
 */
export type SessionLoadError = {
    type: 'file_not_found';
    path: string;
} | {
    type: 'parse_error';
    path: string;
    message: string;
} | {
    type: 'validation_error';
    path: string;
    message: string;
};
/**
 * Result type for session load operations
 */
export type SessionLoadResult<T> = {
    success: true;
    data: T;
} | {
    success: false;
    error: SessionLoadError;
};
/**
 * Check if error is file not found (expected on first run)
 */
export declare function isFileNotFoundError(error: SessionLoadError): boolean;
//# sourceMappingURL=errors.d.ts.map