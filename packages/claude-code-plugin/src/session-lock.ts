// src/session-lock.ts
import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import {
  acquireFileLock,
  FileLockTimeoutError,
  heldLock,
  releaseFileLock,
  type ScopedLock,
} from '@rundown-org/core';

/**
 * Thrown when {@link PluginSessionLock.acquire} cannot acquire the lock within
 * the file-lock deadline. Subclassed from {@link FileLockTimeoutError} so
 * callers keep a typed error contract while reusing the core primitive.
 */
export class PluginSessionLockTimeoutError extends FileLockTimeoutError {
  /**
   * Construct a typed timeout error referencing the contended lock file.
   *
   * @param lockFile - Absolute path to the plugin session lock file
   */
  constructor(lockFile: string) {
    super(
      lockFile,
      `Plugin session lock timeout: ${lockFile}. Another hook process may be writing to .claude/session/state.json.`,
    );
    this.name = 'PluginSessionLockTimeoutError';
  }
}

/**
 * File-based exclusive lock serializing load-modify-save cycles on the
 * plugin's `.claude/session/state.json`.
 *
 * One lock per project root — every {@link Session} mutation acquires this
 * before reading the state file and releases after writing, preventing
 * concurrent hook processes (each `PreToolUse`/`SubagentStop` invocation is a
 * separate OS process) from losing interleaved updates (#470 defect 1).
 *
 * Built on core's PID-aware primitives (`acquireFileLock`/`releaseFileLock`):
 * atomic `open('wx')` creation, kill-signal stale detection (never age-based),
 * jittered retry bounded to 5 seconds.
 *
 * Lock path: `.claude/session/locks/state.lock` (realpath-resolved project
 * root, mirroring core's `SessionLock`, so symlinked spellings of the same
 * directory — e.g. macOS `/var/folders` vs `/private/var/folders` — contend on
 * one lock file).
 */
export class PluginSessionLock {
  private readonly lockDir: string;
  private readonly lockFile: string;

  /**
   * Create a new PluginSessionLock for the given project root.
   *
   * @param cwd - Project root directory (must exist; resolved via realpath)
   */
  constructor(cwd = '.') {
    const projectRoot = realpathSync(cwd);
    this.lockDir = path.join(projectRoot, '.claude', 'session', 'locks');
    this.lockFile = path.join(this.lockDir, 'state.lock');
  }

  /**
   * Acquire the plugin session lock.
   *
   * Retries with bounded jitter up to the 5-second core deadline. Reclaims
   * locks only when the owning process is no longer alive.
   *
   * @throws {PluginSessionLockTimeoutError} When the lock cannot be acquired within the deadline
   */
  async acquire(): Promise<void> {
    try {
      await acquireFileLock(this.lockFile, this.lockDir);
    } catch (err) {
      if (err instanceof FileLockTimeoutError) {
        throw new PluginSessionLockTimeoutError(this.lockFile);
      }
      throw err;
    }
  }

  /**
   * Release the plugin session lock.
   *
   * Honest by contract: idempotent on `ENOENT` but propagates real I/O
   * failures. Callers must not release from a bare `finally` (the RD-102
   * masking defect) — use {@link scope} / {@link held} with `await using`.
   *
   * @throws {Error} Propagates non-ENOENT failures from `releaseFileLock`.
   */
  async release(): Promise<void> {
    await releaseFileLock(this.lockFile);
  }

  /**
   * Acquire the lock and return a best-effort {@link ScopedLock} for `await using`.
   *
   * @returns A disposable scope that releases the lock on exit
   * @throws {PluginSessionLockTimeoutError} When the lock cannot be acquired within the deadline
   */
  async scope(): Promise<ScopedLock> {
    await this.acquire();
    return this.held();
  }

  /**
   * Wrap the already-held lock as a best-effort {@link ScopedLock} without
   * acquiring. Disposal runs at most once and never throws — a leaked lock
   * self-heals via PID-aware stale reclaim on the next acquire.
   *
   * @returns A disposable scope that releases the lock on exit
   */
  held(): ScopedLock {
    return heldLock(
      () => this.release(),
      () => ({ lock: 'plugin-session', lockFile: this.lockFile }),
    );
  }
}
