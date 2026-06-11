import { locksDir, completionLockPath as _completionLockPath } from '../paths.js';
import {
  acquireFileLock,
  FileLockTimeoutError,
  heldLock,
  releaseFileLock,
  type ScopedLock,
} from './file-lock.js';

/**
 * Thrown when {@link CompletionLock.acquire} cannot acquire the lock within
 * the {@link FileLockTimeoutError} deadline.
 */
export class CompletionLockTimeoutError extends FileLockTimeoutError {
  /** Run id whose completion lock timed out. */
  readonly runId: string;

  /**
   * Construct a typed timeout error tagged with the run id.
   *
   * @param runId - Identifier of the run whose completion lock timed out
   * @param lockFile - Absolute path to the underlying lock file
   */
  constructor(runId: string, lockFile: string) {
    super(
      lockFile,
      `Completion lock timeout for run ${runId}: ${lockFile}. Another operation may be in progress.`,
    );
    this.name = 'CompletionLockTimeoutError';
    this.runId = runId;
  }
}

/**
 * File-based exclusive lock for serializing resolved-completion mutations.
 *
 * Lock path: `.rundown/locks/run-<runId>.completion.lock`.
 */
export class CompletionLock {
  private readonly cwd: string;
  private readonly lockDir: string;

  /**
   * Create a new CompletionLock.
   *
   * @param cwd - Project root directory
   */
  constructor(cwd: string) {
    this.cwd = cwd;
    this.lockDir = locksDir(cwd);
  }

  private lockPath(runId: string): string {
    return _completionLockPath(this.cwd, runId);
  }

  /**
   * Acquire an exclusive resolved-completion lock for the given run ID.
   *
   * @param runId - Run ID to lock
   * @throws {CompletionLockTimeoutError} When the lock cannot be acquired
   */
  async acquire(runId: string): Promise<void> {
    const lockFile = this.lockPath(runId);
    try {
      await acquireFileLock(lockFile, this.lockDir);
    } catch (err) {
      if (err instanceof FileLockTimeoutError) {
        throw new CompletionLockTimeoutError(runId, lockFile);
      }
      throw err;
    }
  }

  /**
   * Release an exclusive resolved-completion lock for the given run ID.
   *
   * Honest by contract: idempotent on `ENOENT` (does not throw if the lock file
   * is already gone) but propagates real I/O failures (`EACCES`/`EPERM`/`EIO`).
   * Callers must not release from a bare `finally` — a propagated error would
   * mask the operation's already-committed outcome (the RD-102 defect). Use
   * {@link scope} / {@link held} with `await using` instead: the disposer owns
   * the best-effort, non-masking policy while this method stays diagnosable.
   *
   * @param runId - Run ID to unlock
   * @throws {Error} Propagates non-ENOENT failures from `releaseFileLock`.
   */
  async release(runId: string): Promise<void> {
    await releaseFileLock(this.lockPath(runId));
  }

  /**
   * Acquire the lock and return a best-effort {@link ScopedLock} for `await using`.
   *
   * @param runId - Run ID to lock
   * @returns A disposable scope that releases the lock on exit
   * @throws {CompletionLockTimeoutError} When the lock cannot be acquired within the deadline
   */
  async scope(runId: string): Promise<ScopedLock> {
    await this.acquire(runId);
    return this.held(runId);
  }

  /**
   * Wrap the already-held lock as a best-effort {@link ScopedLock} without
   * acquiring.
   *
   * @param runId - Run ID whose held lock to wrap
   * @returns A disposable scope that releases the lock on exit
   */
  held(runId: string): ScopedLock {
    return heldLock(
      () => this.release(runId),
      () => ({ lock: 'completion', runId, lockFile: this.lockPath(runId) }),
    );
  }
}
