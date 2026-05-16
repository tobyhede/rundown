import { locksDir, completionLockPath as _completionLockPath } from '../paths.js';
import { acquireFileLock, FileLockTimeoutError, releaseFileLock } from './file-lock.js';

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
   * @param runId - Run ID to unlock
   * @throws {Error} Propagates errors from `releaseFileLock(this.lockPath(runId))`,
   *   such as I/O or permission failures while resolving or releasing the lock path
   */
  async release(runId: string): Promise<void> {
    await releaseFileLock(this.lockPath(runId));
  }
}
