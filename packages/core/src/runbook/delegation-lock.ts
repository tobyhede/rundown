import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isNodeError } from '../errors.js';

const LOCK_DIR = '.claude/rundown/locks';
const LOCK_DEADLINE_MS = 5_000;
const STALE_AGE_MS = 60_000;
const RETRY_MIN_MS = 50;
const RETRY_MAX_MS = 100;

interface LockContent {
  pid: number;
  created_at: string;
}

/**
 * Check if a process is alive using kill(pid, 0).
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
 * File-based exclusive lock for serializing delegation mutations.
 *
 * Uses `O_CREAT | O_EXCL` (`'wx'` flag) for atomic acquisition.
 * Covers claim, completion propagation, and abort operations.
 *
 * Lock path: `.claude/rundown/locks/run-<parentRunId>.delegation.lock`
 */
export class DelegationLock {
  private readonly lockDir: string;

  /**
   * Create a new DelegationLock.
   *
   * @param cwd - Project root directory
   */
  constructor(cwd: string) {
    this.lockDir = path.join(cwd, LOCK_DIR);
  }

  private lockPath(parentRunId: string): string {
    return path.join(this.lockDir, `run-${parentRunId}.delegation.lock`);
  }

  /**
   * Acquire an exclusive lock for the given parent run ID.
   *
   * Retries with bounded jitter up to a 5-second deadline.
   * Reclaims stale locks from dead processes or locks older than 60 seconds.
   *
   * @param parentRunId - The parent run ID to lock
   * @throws Error when the lock cannot be acquired within the deadline
   */
  async acquire(parentRunId: string): Promise<void> {
    await fs.mkdir(this.lockDir, { recursive: true });

    const lockFile = this.lockPath(parentRunId);
    const deadline = Date.now() + LOCK_DEADLINE_MS;

    while (Date.now() < deadline) {
      try {
        const content: LockContent = {
          pid: process.pid,
          created_at: new Date().toISOString(),
        };
        const handle = await fs.open(lockFile, 'wx');
        try {
          await handle.writeFile(JSON.stringify(content), 'utf8');
        } finally {
          await handle.close();
        }
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw err;
        }

        // Lock exists — try to reclaim if stale
        const reclaimed = await this.tryReclaimStale(lockFile);
        if (reclaimed) {
          continue;
        }

        // Sleep with jitter before retrying
        const jitter = RETRY_MIN_MS + Math.random() * (RETRY_MAX_MS - RETRY_MIN_MS);
        await new Promise((resolve) => setTimeout(resolve, jitter));
      }
    }

    throw new Error(
      `Delegation lock timeout for run ${parentRunId}. ` + 'Another operation may be in progress.',
    );
  }

  /**
   * Release an exclusive lock for the given parent run ID.
   *
   * Idempotent — does not throw if the lock file does not exist.
   *
   * @param parentRunId - The parent run ID to unlock
   */
  async release(parentRunId: string): Promise<void> {
    try {
      await fs.unlink(this.lockPath(parentRunId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }

  /**
   * Try to reclaim a stale lock file.
   *
   * A lock is considered stale if:
   * - The owning process is no longer alive (kill(pid, 0) → ESRCH)
   * - The lock is older than 60 seconds
   *
   * @param lockFile - Absolute path to the lock file
   * @returns true if the lock was reclaimed and removed
   */
  private async tryReclaimStale(lockFile: string): Promise<boolean> {
    try {
      const raw = await fs.readFile(lockFile, 'utf8');
      const content = JSON.parse(raw) as LockContent;

      const age = Date.now() - new Date(content.created_at).getTime();
      const dead = !isProcessAlive(content.pid);

      if (dead || age > STALE_AGE_MS) {
        await fs.unlink(lockFile);
        return true;
      }
    } catch (err: unknown) {
      // Lock file disappeared between check and read — reclaimable
      if (isNodeError(err) && err.code === 'ENOENT') {
        return true;
      }
      // Corrupted lock file (invalid JSON) — unlink and reclaim
      if (err instanceof SyntaxError) {
        try {
          await fs.unlink(lockFile);
        } catch (unlinkErr: unknown) {
          if (!(isNodeError(unlinkErr) && unlinkErr.code === 'ENOENT')) {
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
}
