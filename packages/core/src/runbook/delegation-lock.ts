// Lock-file naming convention and directory layout are defined in ../paths.ts
// (`delegationLockPath`, `locksDir`).
import { locksDir, delegationLockPath as _delegationLockPath } from '../paths.js';
import {
  acquireFileLock,
  FileLockTimeoutError,
  heldLock,
  releaseFileLock,
  type ScopedLock,
} from './file-lock.js';

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
 * Minimal acquire/release contract for consumers that serialize delegation
 * mutations, so tests can inject a deterministic fake lock without a real
 * filesystem mutex. Mirrors the `RunStateLockLike` DI precedent: callers wrap
 * the held lock with `heldLock` + `await using` themselves (never releasing
 * from a bare `finally` — the RD-102 masking defect).
 */
export interface DelegationLockLike {
  /**
   * Acquire an exclusive lock for the given parent run ID.
   *
   * @param parentRunId - Parent run ID to lock.
   * @throws {DelegationLockTimeoutError} When the lock cannot be acquired
   *   within the deadline.
   */
  acquire(parentRunId: string): Promise<void>;
  /**
   * Release the lock for the given parent run ID. Must be idempotent on an
   * already-released lock.
   *
   * @param parentRunId - Parent run ID to unlock.
   */
  release(parentRunId: string): Promise<void>;
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
   * Honest by contract: idempotent on `ENOENT` (does not throw if the lock file
   * is already gone) but propagates real I/O failures (`EACCES`/`EPERM`/`EIO`).
   * Callers must not release from a bare `finally` — a propagated error would
   * mask the operation's already-committed outcome (the RD-102 defect). Use
   * {@link scope} / {@link held} with `await using` instead: the disposer owns
   * the best-effort, non-masking policy while this method stays diagnosable.
   *
   * @param parentRunId - The parent run ID to unlock
   * @throws {Error} Propagates non-ENOENT failures from `releaseFileLock`.
   */
  async release(parentRunId: string): Promise<void> {
    await releaseFileLock(this.lockPath(parentRunId));
  }

  /**
   * Acquire the lock and return a best-effort {@link ScopedLock} for `await using`.
   *
   * `acquire` may throw {@link DelegationLockTimeoutError}; callers that map the
   * timeout to a typed result (rather than letting it propagate through the
   * `await using` declaration) should call {@link acquire} then {@link held}.
   *
   * @param parentRunId - The parent run ID to lock
   * @returns A disposable scope that releases the lock on exit
   * @throws {DelegationLockTimeoutError} When the lock cannot be acquired within the deadline
   */
  async scope(parentRunId: string): Promise<ScopedLock> {
    await this.acquire(parentRunId);
    return this.held(parentRunId);
  }

  /**
   * Wrap the already-held lock as a best-effort {@link ScopedLock} without
   * acquiring. Disposal (or an explicit `release()`) runs at most once and never
   * throws — a leaked lock self-heals via PID-aware stale reclaim.
   *
   * @param parentRunId - The parent run ID whose held lock to wrap
   * @returns A disposable scope that releases the lock on exit
   */
  held(parentRunId: string): ScopedLock {
    return heldLock(
      () => this.release(parentRunId),
      () => ({ lock: 'delegation', parentRunId, lockFile: this.lockPath(parentRunId) }),
    );
  }
}
