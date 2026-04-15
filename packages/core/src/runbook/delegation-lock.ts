// Lock-file naming convention and directory layout are defined in ../paths.ts
// (`delegationLockPath`, `locksDir`).
import { locksDir, delegationLockPath as _delegationLockPath } from '../paths.js';
import { acquireFileLock, releaseFileLock } from './file-lock.js';

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
   * Reclaims stale locks from dead processes or locks older than 60 seconds.
   *
   * @param parentRunId - The parent run ID to lock
   * @throws {Error} When the lock cannot be acquired within the deadline
   */
  async acquire(parentRunId: string): Promise<void> {
    await acquireFileLock(this.lockPath(parentRunId), this.lockDir);
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
