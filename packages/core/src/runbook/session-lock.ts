import { realpathSync } from 'node:fs';
import { locksDir, sessionLockPath as _sessionLockPath } from '../paths.js';
import {
  acquireFileLock,
  FileLockTimeoutError,
  heldLock,
  releaseFileLock,
  type ScopedLock,
} from './file-lock.js';

/**
 * Thrown when {@link SessionLock.acquire} cannot acquire the lock within the
 * {@link FileLockTimeoutError} deadline. Subclassed so callers can preserve
 * a typed error contract while reusing the file-lock primitive.
 */
export class SessionLockTimeoutError extends FileLockTimeoutError {
  /**
   * Construct a typed timeout error referencing the contended session lock file.
   *
   * @param lockFile - Absolute path to the session lock file
   */
  constructor(lockFile: string) {
    super(
      lockFile,
      `Session lock timeout: ${lockFile}. Another rd process may be writing to session.json.`,
    );
    this.name = 'SessionLockTimeoutError';
  }
}

/**
 * File-based exclusive lock serializing load-modify-save cycles on
 * `.rundown/session.json`.
 *
 * One lock per project root — `SessionService` mutations (claim, release,
 * push, pop, stash, unstash) acquire this before reading the session and
 * release after writing, preventing concurrent CLI processes from losing
 * interleaved updates.
 *
 * Lock path: `.rundown/locks/session.lock`
 */
export class SessionLock {
  private readonly lockDir: string;
  private readonly lockFile: string;

  /**
   * Create a new SessionLock for the given project root.
   *
   * @param cwd - Project root directory
   */
  constructor(cwd: string) {
    const projectRoot = realpathSync(cwd);
    this.lockDir = locksDir(projectRoot);
    this.lockFile = _sessionLockPath(projectRoot);
  }

  /**
   * Acquire the session lock.
   *
   * Retries with bounded jitter up to a 5-second deadline.
   * Reclaims locks only when the owning process is no longer alive.
   *
   * @throws {SessionLockTimeoutError} When the lock cannot be acquired within the deadline
   */
  async acquire(): Promise<void> {
    try {
      await acquireFileLock(this.lockFile, this.lockDir);
    } catch (err) {
      if (err instanceof FileLockTimeoutError) {
        throw new SessionLockTimeoutError(this.lockFile);
      }
      throw err;
    }
  }

  /**
   * Release the session lock.
   *
   * Honest by contract: idempotent on `ENOENT` (does not throw if the lock file
   * is already gone) but propagates real I/O failures (`EACCES`/`EPERM`/`EIO`).
   * Callers must not release from a bare `finally` — a propagated error would
   * mask the operation's already-committed outcome (the RD-102 defect). Use
   * {@link scope} / {@link held} with `await using` instead: the disposer owns
   * the best-effort, non-masking policy while this method stays diagnosable.
   *
   * @throws {Error} Propagates non-ENOENT failures from `releaseFileLock`.
   */
  async release(): Promise<void> {
    await releaseFileLock(this.lockFile);
  }

  /**
   * Acquire the lock and return a best-effort {@link ScopedLock} for `await using`.
   *
   * `acquire` may throw {@link SessionLockTimeoutError}; callers that map the
   * timeout to a typed result (rather than letting it propagate through the
   * `await using` declaration) should call {@link acquire} then {@link held}.
   *
   * @returns A disposable scope that releases the lock on exit
   * @throws {SessionLockTimeoutError} When the lock cannot be acquired within the deadline
   */
  async scope(): Promise<ScopedLock> {
    await this.acquire();
    return this.held();
  }

  /**
   * Wrap the already-held lock as a best-effort {@link ScopedLock} without
   * acquiring. Disposal (or an explicit `release()`) runs at most once and never
   * throws — a leaked lock self-heals via PID-aware stale reclaim.
   *
   * @returns A disposable scope that releases the lock on exit
   */
  held(): ScopedLock {
    return heldLock(
      () => this.release(),
      () => ({ lock: 'session', lockFile: this.lockFile }),
    );
  }
}
