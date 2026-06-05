import { locksDir, runStateLockPath as _runStateLockPath } from '../paths.js';
import { acquireFileLock, FileLockTimeoutError, releaseFileLock } from './file-lock.js';

/**
 * Thrown when {@link RunStateLock.acquire} cannot acquire the lock within
 * the {@link FileLockTimeoutError} deadline.
 */
export class RunStateLockTimeoutError extends FileLockTimeoutError {
  /** Run id whose state lock timed out. */
  readonly runId: string;

  /**
   * Construct a typed timeout error tagged with the run id.
   *
   * @param runId - Identifier of the run whose state lock timed out
   * @param lockFile - Absolute path to the underlying lock file
   */
  constructor(runId: string, lockFile: string) {
    super(
      lockFile,
      `Run-state lock timeout for run ${runId}: ${lockFile}. Another operation may be writing run state.`,
    );
    this.name = 'RunStateLockTimeoutError';
    this.runId = runId;
  }
}

/**
 * File-based exclusive lock for serializing writes to a single run-state file.
 *
 * Lock path: `.rundown/locks/run-<runId>.state.lock`.
 *
 * Lock ordering: higher-level domain locks such as `CompletionLock` and
 * `DelegationLock` may be acquired before this lock, then call into
 * `RunbookStateManager`. This lock must not acquire those domain locks.
 */
export class RunStateLock {
  private readonly cwd: string;
  private readonly lockDir: string;

  /**
   * Create a new RunStateLock.
   *
   * @param cwd - Project root directory
   */
  constructor(cwd: string) {
    this.cwd = cwd;
    this.lockDir = locksDir(cwd);
  }

  private lockPath(runId: string): string {
    return _runStateLockPath(this.cwd, runId);
  }

  /**
   * Acquire an exclusive run-state lock for the given run ID.
   *
   * Retries with bounded jitter up to a 5-second deadline. Reclaims the lock
   * only when the owning process is no longer alive.
   *
   * @param runId - Run ID to lock
   * @throws {RunStateLockTimeoutError} When the lock cannot be acquired within
   *   the deadline
   * @throws {Error} Propagates non-timeout failures from `acquireFileLock`,
   *   such as I/O or permission errors while creating the lock file
   */
  async acquire(runId: string): Promise<void> {
    const lockFile = this.lockPath(runId);
    try {
      await acquireFileLock(lockFile, this.lockDir);
    } catch (err) {
      if (err instanceof FileLockTimeoutError) {
        throw new RunStateLockTimeoutError(runId, lockFile);
      }
      throw err;
    }
  }

  /**
   * Release an exclusive run-state lock for the given run ID.
   *
   * Idempotent — does not throw if the lock file does not exist.
   *
   * @param runId - Run ID to unlock
   * @throws {Error} Propagates non-ENOENT failures from `releaseFileLock`,
   *   such as I/O or permission errors while removing the lock file
   */
  async release(runId: string): Promise<void> {
    await releaseFileLock(this.lockPath(runId));
  }
}

/**
 * Minimal acquire/release contract the state manager depends on, so tests can
 * inject a deterministic fake lock without a real filesystem mutex.
 */
export interface RunStateLockLike {
  /**
   * Acquire an exclusive lock for the given run ID.
   *
   * @param runId - Run ID to lock.
   */
  acquire(runId: string): Promise<void>;
  /**
   * Release the lock for the given run ID. Must be idempotent.
   *
   * @param runId - Run ID to unlock.
   */
  release(runId: string): Promise<void>;
}

/**
 * Factory that produces a {@link RunStateLockLike} for a project root.
 *
 * @param cwd - Project root directory.
 * @returns A lock instance scoped to that project root.
 */
export type RunStateLockFactory = (cwd: string) => RunStateLockLike;

/**
 * Default factory used by {@link RunbookStateManager} when no override is
 * supplied: constructs the real filesystem-backed {@link RunStateLock}.
 *
 * @param cwd - Project root directory.
 * @returns A real {@link RunStateLock}.
 */
export const defaultRunStateLockFactory: RunStateLockFactory = (cwd) => new RunStateLock(cwd);
