/**
 * Generic file-based exclusive lock primitives.
 *
 * Provides `acquireFileLock` / `releaseFileLock` for any path under the
 * `.rundown/locks/` directory. Uses `O_CREAT | O_EXCL` (`'wx'` flag) for
 * atomic acquisition with retry-jitter and stale-lock reclaim.
 *
 * Used by `DelegationLock` (delegation mutations) and `storeContextOutputs`
 * (context-outputs read-merge-write serialization).
 *
 * @module runbook/file-lock
 */

import * as fs from 'node:fs/promises';
import { isNodeError } from '../errors.js';

const LOCK_DEADLINE_MS = 5_000;
const STALE_AGE_MS = 60_000;
const RETRY_MIN_MS = 50;
const RETRY_MAX_MS = 100;

interface LockContent {
  pid: number;
  created_at: string;
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
 * A lock is considered stale when:
 * - The owning process is no longer alive (`kill(pid, 0)` → ESRCH)
 * - The lock file is older than {@link STALE_AGE_MS} milliseconds
 *
 * @param lockFile - Absolute path to the lock file
 * @returns `true` if the lock was reclaimed and removed
 * @throws {Error} On real I/O errors (EACCES, EIO, etc.)
 */
async function tryReclaimStale(lockFile: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(lockFile, 'utf8');
    const content = JSON.parse(raw) as LockContent;

    const age = Date.now() - new Date(content.created_at).getTime();
    const dead = !isProcessAlive(content.pid);

    if (dead || age > STALE_AGE_MS) {
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
    if (Error.isError(err) && err.name === 'SyntaxError') {
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

  throw new Error(`File lock timeout: ${lockFile}. Another operation may be holding the lock.`);
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
