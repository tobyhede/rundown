// packages/shared/src/logger.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  ts: string;
  level: LogLevel;
  event?: string;
  message?: string;
  [key: string]: unknown;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

/**
 * Get the log directory path.
 * Uses ${TMPDIR}/rundown/ for isolation.
 */
function getLogDir(): string {
  return path.join(tmpdir(), 'rundown');
}

/**
 * Get the log file path for today.
 * Format: hooks-YYYY-MM-DD.log
 */
function getLogFilePath(): string {
  const date = new Date().toISOString().split('T')[0];
  return path.join(getLogDir(), `hooks-${date}.log`);
}

/**
 * Check if logging is enabled via environment variable.
 * Logging is ENABLED by default (env vars don't pass through from Claude CLI).
 * Set RUNDOWN_LOG=0 to disable.
 */
function isLoggingEnabled(): boolean {
  return process.env.RUNDOWN_LOG !== '0';
}

/**
 * Get the minimum log level from environment.
 * RUNDOWN_LOG_LEVEL=debug|info|warn|error (default: info)
 */
function getMinLogLevel(): LogLevel {
  const envLevel = process.env.RUNDOWN_LOG_LEVEL;
  if (envLevel && envLevel in LOG_LEVELS) {
    return envLevel as LogLevel;
  }
  return 'info';
}

/**
 * Check if a log level should be written based on minimum level.
 */
function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[getMinLogLevel()];
}

/**
 * Ensure the log directory exists.
 */
async function ensureLogDir(): Promise<void> {
  const dir = getLogDir();
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Write a log entry to the log file.
 * Each entry is a JSON line for easy parsing with jq.
 */
async function writeLog(entry: LogEntry): Promise<void> {
  if (!isLoggingEnabled()) return;
  if (!shouldLog(entry.level)) return;

  try {
    await ensureLogDir();
    const line = JSON.stringify(entry) + '\n';
    await fs.appendFile(getLogFilePath(), line, 'utf-8');
  } catch {
    // Silently fail - logging should never break the hook
  }
}

/**
 * Write a log entry unconditionally (bypasses RUNDOWN_LOG check).
 * Used for startup/diagnostic logging to verify hooks are being invoked.
 */
async function writeLogAlways(entry: LogEntry): Promise<void> {
  try {
    await ensureLogDir();
    const line = JSON.stringify(entry) + '\n';
    await fs.appendFile(getLogFilePath(), line, 'utf-8');
  } catch {
    // Silently fail - logging should never break the hook
  }
}

/**
 * Create a log entry with timestamp.
 */
function createEntry(level: LogLevel, message: string, data?: Record<string, unknown>): LogEntry {
  return {
    ts: new Date().toISOString(),
    level,
    message,
    ...data
  };
}

/**
 * Logger interface for rundown CLI.
 *
 * Enable logging: RUNDOWN_LOG=1
 * Set level: RUNDOWN_LOG_LEVEL=debug|info|warn|error
 *
 * Logs are written to: ${TMPDIR}/rundown/hooks-YYYY-MM-DD.log
 * Format: JSON lines (one JSON object per line)
 *
 * Example:
 *   {"ts":"2025-11-25T10:30:00.000Z","level":"info","event":"PostToolUse","tool":"Edit"}
 */
export const logger = {
  /**
   * Log a debug message.
   *
   * @param message - The message to log
   * @param data - Optional structured data to include in the log entry
   * @returns Promise that resolves when the log is written
   */
  debug: (message: string, data?: Record<string, unknown>): Promise<void> =>
    writeLog(createEntry('debug', message, data)),

  /**
   * Log an info message.
   *
   * @param message - The message to log
   * @param data - Optional structured data to include in the log entry
   * @returns Promise that resolves when the log is written
   */
  info: (message: string, data?: Record<string, unknown>): Promise<void> =>
    writeLog(createEntry('info', message, data)),

  /**
   * Log a warning message.
   *
   * @param message - The message to log
   * @param data - Optional structured data to include in the log entry
   * @returns Promise that resolves when the log is written
   */
  warn: (message: string, data?: Record<string, unknown>): Promise<void> =>
    writeLog(createEntry('warn', message, data)),

  /**
   * Log an error message.
   *
   * @param message - The message to log
   * @param data - Optional structured data to include in the log entry
   * @returns Promise that resolves when the log is written
   */
  error: (message: string, data?: Record<string, unknown>): Promise<void> =>
    writeLog(createEntry('error', message, data)),

  /**
   * Log unconditionally (bypasses RUNDOWN_LOG check).
   * Used for startup/diagnostic logging to verify hooks are invoked.
   *
   * @param message - The message to log
   * @param data - Optional structured data to include in the log entry
   * @returns Promise that resolves when the log is written
   */
  always: (message: string, data?: Record<string, unknown>): Promise<void> =>
    writeLogAlways(createEntry('info', message, data)),

  /**
   * Log a hook event with structured data.
   * Convenience method for common hook logging pattern.
   *
   * @param level - The log level (debug, info, warn, error)
   * @param event - The event name (e.g., 'PostToolUse', 'SubagentStop')
   * @param data - Optional structured data to include in the log entry
   * @returns Promise that resolves when the log is written
   */
  event: (level: LogLevel, event: string, data?: Record<string, unknown>): Promise<void> =>
    writeLog({
      ts: new Date().toISOString(),
      level,
      event,
      ...data
    }),

  /**
   * Get the current log file path (for mise tasks).
   *
   * @returns The absolute path to the current log file
   */
  getLogFilePath,

  /**
   * Get the log directory path (for mise tasks).
   *
   * @returns The absolute path to the log directory
   */
  getLogDir
};
