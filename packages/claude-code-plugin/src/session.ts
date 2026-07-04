import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type SessionState,
  type SessionStateArrayKey,
  SessionStateSchema,
  type SessionLoadResult,
  isNodeError,
  isFileNotFoundError,
  logger,
  getErrorMessage,
} from './shared/index.js';
import { PluginSessionLock } from './session-lock.js';

/**
 * Decision returned by a {@link Session.update} updater.
 *
 * Discriminated on `commit` so an updater cannot commit without supplying the
 * next value, and a read-only pass cannot accidentally write: invalid states
 * are unrepresentable.
 */
export type SessionUpdateDecision<V, R> =
  | { readonly commit: true; readonly value: V; readonly result: R }
  | { readonly commit: false; readonly result: R };

/**
 * Manages session state with atomic file updates.
 *
 * State is stored in .claude/session/state.json relative to the project directory.
 */
export class Session {
  private stateFile: string;
  private lock: PluginSessionLock;

  /**
   * Create a new Session instance for the given project directory.
   * @param cwd - Project root directory (defaults to current directory; must exist)
   */
  constructor(cwd = '.') {
    this.stateFile = join(cwd, '.claude', 'session', 'state.json');
    this.lock = new PluginSessionLock(cwd);
  }

  /**
   * Run `fn` while holding the plugin session lock.
   *
   * Serializes every load-modify-save cycle across concurrent hook processes
   * (#470 defect 1). Release is scoped with `await using` so it runs on every
   * exit path without a bare `finally` (RD-102 non-masking policy). The lock
   * is NOT reentrant: `fn` must not call another locking Session method.
   *
   * @param fn - Critical section run under the lock
   * @returns The value returned by `fn`
   * @throws {PluginSessionLockTimeoutError} When the lock cannot be acquired
   */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.lock.acquire();
    await using _guard = this.lock.held();
    return await fn();
  }

  /**
   * Get a session state value
   * @param key - Session state key to retrieve
   * @returns The value for the given key from persisted state
   */
  async get<K extends keyof SessionState>(key: K): Promise<SessionState[K]> {
    const state = await this.load();
    return state[key];
  }

  /**
   * Set a session state value under the session lock.
   * @param key - Session state key to update
   * @param value - New value to persist
   * @throws {Error} If persistence fails (lock/mkdir/write/rename errors)
   */
  async set<K extends keyof SessionState>(key: K, value: SessionState[K]): Promise<void> {
    await this.withLock(async () => {
      const state = await this.load();
      state[key] = value;
      await this.save(state);
    });
  }

  /**
   * Append value to array field (deduplicated) under the session lock.
   * @param key - Array-typed session state key
   * @param value - String value to append if not already present
   * @throws {Error} If persistence fails (lock/mkdir/write/rename errors)
   */
  async append(key: SessionStateArrayKey, value: string): Promise<void> {
    await this.withLock(async () => {
      const state = await this.load();
      const array = state[key];

      if (!array.includes(value)) {
        array.push(value);
        state[key] = array;
        await this.save(state);
      }
    });
  }

  /**
   * Atomically read-modify-write a single session state key under the session
   * lock.
   *
   * The updater receives the current value and returns a
   * {@link SessionUpdateDecision}: `commit: true` persists `value`;
   * `commit: false` leaves the file untouched. Either way `result` is returned
   * to the caller. The whole cycle — load, updater (which may await external
   * reads such as Rundown closure state), conditional save — runs inside one
   * lock scope, so no concurrent hook process can interleave a write.
   *
   * The updater MUST NOT call other Session methods (the lock is not
   * reentrant) and SHOULD NOT perform writes of its own.
   *
   * @param key - Session state key to read and conditionally replace
   * @param updater - Pure-ish decision function over the current value
   * @returns The updater's `result`
   * @throws {Error} Propagates updater throws and persistence failures; the
   *   lock is released on every path
   */
  async update<K extends keyof SessionState, R>(
    key: K,
    updater: (
      current: SessionState[K],
    ) =>
      | Promise<SessionUpdateDecision<SessionState[K], R>>
      | SessionUpdateDecision<SessionState[K], R>,
  ): Promise<R> {
    return this.withLock(async () => {
      const state = await this.load();
      const decision = await updater(state[key]);
      if (decision.commit) {
        state[key] = decision.value;
        await this.save(state);
      }
      return decision.result;
    });
  }

  /**
   * Check if array contains value
   * @param key - Array-typed session state key
   * @param value - String value to check for
   * @returns True if the array contains the value
   */
  async contains(key: SessionStateArrayKey, value: string): Promise<boolean> {
    const state = await this.load();
    return state[key].includes(value);
  }

  /**
   * Clear session state (remove file)
   */
  async clear(): Promise<void> {
    try {
      await fs.unlink(this.stateFile);
    } catch {
      // File doesn't exist, that's fine
    }
  }

  /**
   * Load state from file with detailed error handling.
   * Returns result object with success/error discriminant.
   * @returns Discriminated union with parsed state on success or typed error on failure
   */
  private async loadWithError(): Promise<SessionLoadResult<SessionState>> {
    try {
      const content = await fs.readFile(this.stateFile, 'utf-8');

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch (e) {
        return {
          success: false,
          error: {
            type: 'parse_error',
            path: this.stateFile,
            message: getErrorMessage(e),
          },
        };
      }

      const result = SessionStateSchema.safeParse(parsed);
      if (!result.success) {
        return {
          success: false,
          error: {
            type: 'validation_error',
            path: this.stateFile,
            message: result.error.issues.map((i) => i.message).join(', '),
          },
        };
      }

      return { success: true, data: result.data };
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return {
          success: false,
          error: { type: 'file_not_found', path: this.stateFile },
        };
      }
      return {
        success: false,
        error: {
          type: 'io_error',
          path: this.stateFile,
          message: getErrorMessage(error),
        },
      };
    }
  }

  /**
   * Load state from file or initialize new state.
   * Handles errors silently: missing file initialized, corrupted data logged and reinitialized.
   * @returns Parsed session state or freshly initialized defaults
   */
  private async load(): Promise<SessionState> {
    const result = await this.loadWithError();

    if (result.success) {
      return result.data;
    }

    const error = result.error;

    if (isFileNotFoundError(error)) {
      return this.initState();
    }

    // error has message field (parse_error or validation_error types)
    const message = 'message' in error ? error.message : 'unknown error';
    await logger.warn('Session state corrupted, reinitializing', {
      path: error.path,
      error_type: error.type,
      message,
    });

    return this.initState();
  }

  /**
   * Save state to file atomically (write to temp, then rename)
   *
   * Performance note: File I/O adds small overhead (~1-5ms) per operation.
   * Atomic writes prevent corruption but require temp file creation.
   *
   * Concurrency note: atomic rename prevents file corruption (invalid JSON,
   * partial writes); logical lost-update races are prevented by the
   * PluginSessionLock every mutating method holds (see withLock). save() is
   * only ever called while the lock is held.
   * @param state - Session state object to persist
   */
  private async save(state: SessionState): Promise<void> {
    await fs.mkdir(dirname(this.stateFile), { recursive: true });
    // Use unique temp file to avoid race conditions during concurrent writes
    const temp = `${this.stateFile}.${randomUUID()}.tmp`;

    try {
      // Write to temp file
      await fs.writeFile(temp, JSON.stringify(state, null, 2), 'utf-8');

      // Atomic rename (prevents corruption from concurrent writes)
      await fs.rename(temp, this.stateFile);
    } catch (error) {
      // Clean up temp file on error
      try {
        await fs.unlink(temp);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  /**
   * Initialize new session state
   *
   * Uses SessionStateSchema as single source of truth for default values.
   * Session ID format: ISO timestamp with punctuation replaced (e.g., "2025-11-23T14-30-45")
   * Unique per millisecond. Collisions possible if multiple sessions start in same millisecond,
   * but unlikely in practice due to hook serialization.
   * @returns Fresh SessionState with schema defaults
   */
  private initState(): SessionState {
    return SessionStateSchema.parse({});
  }
}
