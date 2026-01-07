export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
/**
 * Get the log directory path.
 * Uses ${TMPDIR}/rundown/ for isolation.
 */
declare function getLogDir(): string;
/**
 * Get the log file path for today.
 * Format: hooks-YYYY-MM-DD.log
 */
declare function getLogFilePath(): string;
/**
 * Logger interface for rundown CLI.
 *
 * Enable logging: RUNDOWN_LOG=1
 * Set level: RUNDOWN_LOG_LEVEL=debug|info|warn|error
 *
 * Logs are written to: ${TMPDIR}/rundown/rundown-YYYY-MM-DD.log
 * Format: JSON lines (one JSON object per line)
 *
 * Example:
 *   {"ts":"2025-11-25T10:30:00.000Z","level":"info","event":"run","workflow":"my-workflow.md"}
 */
export declare const logger: {
    debug: (message: string, data?: Record<string, unknown>) => Promise<void>;
    info: (message: string, data?: Record<string, unknown>) => Promise<void>;
    warn: (message: string, data?: Record<string, unknown>) => Promise<void>;
    error: (message: string, data?: Record<string, unknown>) => Promise<void>;
    /**
     * Log unconditionally (bypasses RUNDOWN_LOG check).
     * Used for startup/diagnostic logging to verify hooks are invoked.
     */
    always: (message: string, data?: Record<string, unknown>) => Promise<void>;
    /**
     * Log a hook event with structured data.
     * Convenience method for common hook logging pattern.
     */
    event: (level: LogLevel, event: string, data?: Record<string, unknown>) => Promise<void>;
    /**
     * Get the current log file path (for mise tasks).
     */
    getLogFilePath: typeof getLogFilePath;
    /**
     * Get the log directory path (for mise tasks).
     */
    getLogDir: typeof getLogDir;
};
export {};
//# sourceMappingURL=logger.d.ts.map