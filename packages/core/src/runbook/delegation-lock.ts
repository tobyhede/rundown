// Lock-file naming convention and directory layout are defined in ../paths.ts
// (`delegationLockPath`, `locksDir`).
import { locksDir, delegationLockPath as _delegationLockPath } from '../paths.js';
import { acquireFileLock, FileLockTimeoutError, releaseFileLock } from './file-lock.js';

/**
 * Thrown when {@link DelegationLock.acquire} cannot acquire the lock
 * within the {@link FileLockTimeoutError} deadline. Carries the parent
 * run id so callers can map to a structured error code (RD-810).
 */
export class DelegationLockTimeoutError extends FileLockTimeoutError {
  readonly parentRunId: string;

  /**
   * Construct a typed timeout error tagged with the parent run id.
   *
   * @param parentRunId - Identifier of the parent run whose delegation lock timed out
   * @param lockFile    - Absolute path to the underlying lock file
   */
  constructor(parentRunId: string, lockFile: string) {
    super(
      lockFile,
      `Delegation lock timeout for run ${parentRunId}: ${lockFile}. Another operation may be in progress.`,
    );
    this.name = 'DelegationLockTimeoutError';
    this.parentRunId = parentRunId;
  }
}

/**
 * File-based exclusive lock for serializing delegation mutations.
 *
 * Uses `O_CREAT | O_EXCL` (`'wx'` flag) for atomic acquisition.
 * Covers claim, completion propagation, and abort operations.
 *
 * Lock path: `.rundown/locks/run-<parentRunId>.delegation.lock`
 */
export class DelegationLock {
  private readonly cwd: string;
  private readonly lockDir: string;

  /**
   * Create a new DelegationLock.
   *
   * @param cwd - Project root directory
   */
  constructor(cwd: string) {
    this.cwd = cwd;
    this.lockDir = locksDir(cwd);
  }

  private lockPath(parentRunId: string): string {
    return _delegationLockPath(this.cwd, parentRunId);
  }

  /**
   * Acquire an exclusive lock for the given parent run ID.
   *
   * Retries with bounded jitter up to a 5-second deadline.
   * Reclaims locks only when the owning process is no longer alive.
   *
   * @param parentRunId - The parent run ID to lock
   * @throws {Error} When the lock cannot be acquired within the deadline
   */
  async acquire(parentRunId: string): Promise<void> {
    const lockFile = this.lockPath(parentRunId);
    try {
      await acquireFileLock(lockFile, this.lockDir);
    } catch (err) {
      if (err instanceof FileLockTimeoutError) {
        throw new DelegationLockTimeoutError(parentRunId, lockFile);
      }
      throw err;
    }
  }

  /**
   * Release an exclusive lock for the given parent run ID.
   *
   * Idempotent — does not throw if the lock file does not exist.
   *
   * @param parentRunId - The parent run ID to unlock
   */
  async release(parentRunId: string): Promise<void> {
    await releaseFileLock(this.lockPath(parentRunId));
  }
}
