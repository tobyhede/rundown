/**
 * Generic file-based exclusive lock primitives.
 *
 * Provides `acquireFileLock` / `releaseFileLock` for any path under the
 * `.rundown/locks/` directory. Uses `O_CREAT | O_EXCL` (`'wx'` flag) for
 * atomic acquisition with retry-jitter and stale-lock reclaim.
 *
 * Used by `DelegationLock` (delegation mutations).
 *
 * @module runbook/file-lock
 */

import * as fs from 'node:fs/promises';
import { isError, isNodeError } from '../errors.js';

const LOCK_DEADLINE_MS = 5_000;
const RETRY_MIN_MS = 50;
const RETRY_MAX_MS = 100;

interface LockContent {
  pid: number;
  created_at: string;
}

/**
 * Thrown when {@link acquireFileLock} cannot acquire a lock within
 * {@link LOCK_DEADLINE_MS}. Subclasses (e.g. `DelegationLockTimeoutError`)
 * let callers preserve a typed error contract while reusing this primitive.
 */
export class FileLockTimeoutError extends Error {
  readonly lockFile: string;

  /**
   * Construct a typed timeout error referencing the contended lock file.
   *
   * @param lockFile - Absolute path to the lock file that could not be acquired
   * @param message  - Optional override for the default message
   */
  constructor(lockFile: string, message?: string) {
    super(message ?? `File lock timeout: ${lockFile}. Another operation may be holding the lock.`);
    this.name = 'FileLockTimeoutError';
    this.lockFile = lockFile;
  }
}

/**
 * Check if a process is alive using `kill(pid, 0)`.
 *
 * @param pid - Process ID to check
 * @returns `true` if the process exists and is reachable
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to reclaim a stale lock file.
 *
 * A lock is reclaimed only when the owning process is no longer alive
 * (`kill(pid, 0)` → ESRCH). Age-based reclaim is intentionally not supported:
 * a slow-but-live writer (e.g. under CI load) must not lose its mutex just
 * because the lock file is old, or concurrent writers could interleave and drop updates.
 *
 * @param lockFile - Absolute path to the lock file
 * @returns `true` if the lock was reclaimed and removed
 * @throws {Error} On real I/O errors (EACCES, EIO, etc.)
 */
async function tryReclaimStale(lockFile: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(lockFile, 'utf8');
    const content = JSON.parse(raw) as LockContent;

    if (!isProcessAlive(content.pid)) {
      await fs.unlink(lockFile);
      // Between this unlink and the next open('wx') attempt, another process may
      // create the lock. That's fine — the caller retries on EEXIST.
      return true;
    }
  } catch (err: unknown) {
    // Lock file disappeared between check and read — effectively reclaimable
    if (isNodeError(err) && err.code === 'ENOENT') {
      return true;
    }
    // Corrupted lock file (invalid JSON) — unlink and reclaim
    if (isError(err) && err.name === 'SyntaxError') {
      try {
        await fs.unlink(lockFile);
      } catch (unlinkErr: unknown) {
        if (!isNodeError(unlinkErr) || unlinkErr.code !== 'ENOENT') {
          throw unlinkErr;
        }
      }
      return true;
    }
    // Real I/O errors (EACCES, EIO, etc.) — rethrow
    throw err;
  }

  return false;
}

/**
 * Acquire an exclusive file lock at `lockFile`.
 *
 * Creates `lockDir` if it does not exist, then loops attempting an atomic
 * `open(lockFile, 'wx')` until success, stale-lock reclaim, or deadline.
 *
 * @param lockFile - Absolute path to the lock file to create
 * @param lockDir  - Directory that must exist before acquiring (created if absent)
 * @throws {Error} When the lock cannot be acquired within the 5-second deadline
 */
export async function acquireFileLock(lockFile: string, lockDir: string): Promise<void> {
  await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
  // Best-effort: enforce 0o700 even if the directory was pre-created with a
  // looser mode (e.g. by an older build or directly by a user). Lock files
  // themselves are 0o600, so the worst-case impact of a looser dir mode is
  // another local user observing lock filenames — but tightening is cheap.
  try {
    await fs.chmod(lockDir, 0o700);
  } catch {
    // chmod can fail on platforms that don't honor it (Windows) or when the
    // current process is not the owner — neither is fatal for lock semantics.
  }

  const deadline = Date.now() + LOCK_DEADLINE_MS;

  while (Date.now() < deadline) {
    try {
      const content: LockContent = {
        pid: process.pid,
        created_at: new Date().toISOString(),
      };
      const handle = await fs.open(lockFile, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(content), 'utf8');
      } finally {
        await handle.close();
      }
      return;
    } catch (err) {
      if (!isNodeError(err) || err.code !== 'EEXIST') {
        throw err;
      }

      // Lock exists — attempt to reclaim if stale
      const reclaimed = await tryReclaimStale(lockFile);
      if (reclaimed) {
        continue;
      }

      // Sleep with jitter before retrying
      const jitter = RETRY_MIN_MS + Math.random() * (RETRY_MAX_MS - RETRY_MIN_MS);
      await new Promise((resolve) => setTimeout(resolve, jitter));
    }
  }

  throw new FileLockTimeoutError(lockFile);
}

/**
 * Release a file lock by removing `lockFile`.
 *
 * Idempotent — does not throw if the file has already been removed.
 *
 * @param lockFile - Absolute path to the lock file to remove
 */
export async function releaseFileLock(lockFile: string): Promise<void> {
  try {
    await fs.unlink(lockFile);
  } catch (err) {
    if (!isNodeError(err) || err.code !== 'ENOENT') {
      throw err;
    }
  }
}
