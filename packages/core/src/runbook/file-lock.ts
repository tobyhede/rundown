/**
 * Generic file-based exclusive lock primitives.
 *
 * Provides `acquireFileLock` / `releaseFileLock` for any path under the
 * `.rundown/locks/` directory. Acquisition writes the owner content to a temp
 * file and atomically `link()`s it into place — exclusive like `O_EXCL`, but
 * the lock file is never visible half-written — with retry-jitter and
 * stale-lock reclaim.
 *
 * Used by the completion, delegation, session, and run-state locks, and by the
 * artifact-manifest append paths (sync and async).
 *
 * @module runbook/file-lock
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isError, isNodeError, getErrorMessage } from '../errors.js';
import { logger } from '../logger.js';

const LOCK_DEADLINE_MS = 5_000;
const RETRY_MIN_MS = 50;
const RETRY_MAX_MS = 100;

interface LockContent {
  pid: number;
  created_at: string;
}

/**
 * Type guard validating that parsed lock-file JSON matches {@link LockContent}.
 *
 * Shape-valid JSON with an invalid `pid` (or a missing/non-string
 * `created_at`) must never reach `process.kill`, so callers treat a `false`
 * result the same as corrupted JSON and reclaim the lock. `pid` must be a
 * positive safe integer: `process.kill` interprets `0` and negative values as
 * process-*group* targets, so a lock claiming `pid: 0`/`-1` would otherwise be
 * mis-read as "live" and never reclaimed. Exported so the predicate can be
 * unit-tested directly, which is where its behaviour is pinned (the end-to-end
 * reclaim path coincides with `process.kill` throwing on malformed input on
 * POSIX, so only a direct test distinguishes the guard).
 *
 * @param value - Parsed (but unvalidated) lock-file content.
 * @returns A type predicate narrowing `value` to {@link LockContent} when it has
 *   a positive integer `pid` and a string `created_at`.
 */
export function isLockContent(value: unknown): value is LockContent {
  const pid = (value as { pid?: unknown } | null)?.pid;
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof pid === 'number' &&
    Number.isSafeInteger(pid) &&
    pid > 0 &&
    typeof (value as { created_at?: unknown }).created_at === 'string'
  );
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
 * Only `ESRCH` ("no such process") proves the holder is dead and its lock is
 * reclaimable. `EPERM` means a process with that pid exists but belongs to
 * another user we may not signal — it is alive, so the lock must NOT be stolen.
 * Any other unexpected error is treated conservatively as alive so a lock is
 * never reclaimed without proof the owner is gone.
 *
 * Exported for direct unit testing of this error mapping.
 *
 * @param pid - Process ID to check
 * @returns `true` if the process exists (or its liveness can't be disproven)
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ESRCH') {
      return false;
    }
    return true;
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
    const parsed = JSON.parse(raw) as unknown;

    // Shape-invalid lock content is as untrustworthy as corrupted JSON: never
    // pass a non-numeric pid to process.kill. Unlink and reclaim.
    if (!isLockContent(parsed)) {
      try {
        await fs.unlink(lockFile);
      } catch (unlinkErr: unknown) {
        if (!isNodeError(unlinkErr) || unlinkErr.code !== 'ENOENT') {
          throw unlinkErr;
        }
      }
      return true;
    }

    if (!isProcessAlive(parsed.pid)) {
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
 * Atomically create `lockFile` already populated with its owner content.
 *
 * The lock file must never be observable in a half-created state: a
 * `open('wx')` that creates an empty file and then writes the pid in a second
 * step leaves a window where a concurrent {@link tryReclaimStale} reads `''`,
 * fails `JSON.parse`, and reclaims the lock from a *live* holder — breaking
 * mutual exclusion and losing updates. We instead write the content to a
 * unique temp file and `link()` it into place: `link` is atomic and fails
 * `EEXIST` if the lock is already held (same exclusivity as `O_EXCL`), but the
 * destination is fully-populated the instant it becomes visible.
 *
 * @param lockFile - Absolute path to the lock file to create
 * @param body     - Serialized {@link LockContent} to store in the lock file
 * @throws {NodeJS.ErrnoException} `EEXIST` when the lock is already held; other
 *   I/O errors propagate unchanged.
 */
async function atomicCreateLock(lockFile: string, body: string): Promise<void> {
  const tmp = `${lockFile}.${String(process.pid)}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
    await fs.link(tmp, lockFile);
  } finally {
    try {
      await fs.unlink(tmp);
    } catch {
      // Best-effort temp cleanup: on link success `tmp` and `lockFile` are
      // hardlinks to one inode, so removing `tmp` leaves the populated lock
      // intact; on failure the temp is the only reference and is removed. A
      // leaked temp is inert (never consulted by acquire/reclaim).
    }
  }
}

/**
 * Synchronous counterpart to {@link atomicCreateLock}.
 *
 * @param lockFile - Absolute path to the lock file to create
 * @param body     - Serialized {@link LockContent} to store in the lock file
 * @throws {NodeJS.ErrnoException} `EEXIST` when the lock is already held; other
 *   I/O errors propagate unchanged.
 */
function atomicCreateLockSync(lockFile: string, body: string): void {
  const tmp = `${lockFile}.${String(process.pid)}.${randomUUID()}.tmp`;
  try {
    fsSync.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
    fsSync.linkSync(tmp, lockFile);
  } finally {
    try {
      fsSync.unlinkSync(tmp);
    } catch {
      // Best-effort temp cleanup — see atomicCreateLock.
    }
  }
}

/**
 * Acquire an exclusive file lock at `lockFile`.
 *
 * Creates `lockDir` if it does not exist, then loops attempting an atomic
 * populated create (temp-write + `link`) until success, stale-lock reclaim, or
 * deadline.
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
      await atomicCreateLock(lockFile, JSON.stringify(content));
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

/**
 * An acquired file lock exposed as an async-disposable scope.
 *
 * Used with `await using` so the lock is released deterministically when the
 * enclosing block exits — including on early `return` or `throw` — without a
 * hand-rolled `try/finally`. Disposal is **best-effort**: a failed unlink only
 * leaks a self-healing lock (the owning process exits, so the next acquirer
 * reclaims it via PID-aware stale detection in {@link acquireFileLock}), so a
 * release failure must never escape the disposer and mask the already-committed
 * outcome of the work the lock protected — the defect behind RD-102. `release()`
 * is idempotent and disarms the automatic disposal, for callers that must drop
 * the lock before later work (e.g. before a long-running child execution loop).
 */
export interface ScopedLock extends AsyncDisposable {
  /** Release now; the automatic `Symbol.asyncDispose` becomes a no-op. */
  release(): Promise<void>;
}

/**
 * Wrap the release of an already-acquired lock as a best-effort
 * {@link ScopedLock}.
 *
 * The release runs at most once across an explicit `release()` call and the
 * `await using` scope-exit disposal. A thrown release is logged and swallowed —
 * never propagated — so it cannot mask the protected operation's result. The
 * `release` thunk is expected to perform the underlying (possibly throwing)
 * unlink; keeping it throwing preserves the primitive's honest error contract
 * while this wrapper owns the non-masking policy.
 *
 * @param release  - Thunk performing the underlying release (may reject)
 * @param describe - Returns structured log context identifying the lock
 * @returns A best-effort, idempotent async-disposable lock scope
 */
export function heldLock(
  release: () => Promise<void>,
  describe: () => Record<string, unknown>,
): ScopedLock {
  let released = false;
  const run = async (): Promise<void> => {
    if (released) {
      return;
    }
    released = true;
    try {
      await release();
    } catch (err) {
      void logger.warn('lock release failed (leaked, self-healing)', {
        ...describe(),
        error: getErrorMessage(err),
      });
    }
  };
  return { release: run, [Symbol.asyncDispose]: run };
}

/**
 * Synchronous counterpart to {@link ScopedLock}, for the sync manifest-append
 * path that cannot `await`. Used with `using`. Same best-effort, idempotent
 * disposal contract as {@link heldLock}.
 */
export interface ScopedLockSync extends Disposable {
  /** Release now; the automatic `Symbol.dispose` becomes a no-op. */
  release(): void;
}

/**
 * Synchronous counterpart to {@link heldLock}.
 *
 * @param release  - Thunk performing the underlying sync release (may throw)
 * @param describe - Returns structured log context identifying the lock
 * @returns A best-effort, idempotent disposable lock scope
 */
export function heldLockSync(
  release: () => void,
  describe: () => Record<string, unknown>,
): ScopedLockSync {
  let released = false;
  const run = (): void => {
    if (released) {
      return;
    }
    released = true;
    try {
      release();
    } catch (err) {
      void logger.warn('lock release failed (leaked, self-healing)', {
        ...describe(),
        error: getErrorMessage(err),
      });
    }
  };
  return { release: run, [Symbol.dispose]: run };
}

// Module-scoped TypedArray used to block the current thread without spinning
// the CPU. `Atomics.wait` returns 'timed-out' after the requested ms; the
// buffer's value never changes, so the call always pauses for the full
// duration. Reused across acquireFileLockSync calls to avoid per-attempt
// allocation. Keep the array sized to 1 — only index 0 is referenced.
const SYNC_SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

/**
 * Sleep synchronously for `ms` milliseconds without spinning the CPU.
 *
 * Uses `Atomics.wait` on a never-notified SharedArrayBuffer slot, which
 * blocks the thread inside V8 instead of busy-looping. Required because Node
 * has no synchronous `setTimeout` and the artifact manifest sync write path
 * cannot await across the lock-acquire retry loop.
 *
 * @param ms - Number of milliseconds to block the current thread
 */
function sleepSync(ms: number): void {
  Atomics.wait(SYNC_SLEEP_BUFFER, 0, 0, ms);
}

/**
 * Try to reclaim a stale lock file synchronously.
 *
 * Mirrors {@link tryReclaimStale}: reclaim only on dead PID
 * (`kill(pid, 0)` → ESRCH) or on corrupted/missing lock content. Age-based
 * reclaim is intentionally NOT supported.
 *
 * @param lockFile - Absolute path to the lock file
 * @returns `true` if the lock was reclaimed and removed
 * @throws {Error} On real I/O errors (EACCES, EIO, etc.)
 */
function tryReclaimStaleSync(lockFile: string): boolean {
  try {
    const raw = fsSync.readFileSync(lockFile, 'utf8');
    const parsed = JSON.parse(raw) as unknown;

    if (!isLockContent(parsed)) {
      try {
        fsSync.unlinkSync(lockFile);
      } catch (unlinkErr: unknown) {
        if (!isNodeError(unlinkErr) || unlinkErr.code !== 'ENOENT') {
          throw unlinkErr;
        }
      }
      return true;
    }

    if (!isProcessAlive(parsed.pid)) {
      fsSync.unlinkSync(lockFile);
      return true;
    }
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return true;
    }
    if (isError(err) && err.name === 'SyntaxError') {
      try {
        fsSync.unlinkSync(lockFile);
      } catch (unlinkErr: unknown) {
        if (!isNodeError(unlinkErr) || unlinkErr.code !== 'ENOENT') {
          throw unlinkErr;
        }
      }
      return true;
    }
    throw err;
  }

  return false;
}

/**
 * Synchronous counterpart to {@link acquireFileLock}.
 *
 * Same lock contract — atomic `O_CREAT | O_EXCL`, PID-aware stale reclaim
 * via `kill(pid, 0)`, jittered backoff, 5-second deadline. Required for
 * callers that cannot await (notably the sync artifact manifest append used
 * by template helpers and render paths).
 *
 * Backoff uses {@link sleepSync} (Atomics.wait), not a CPU spin — the
 * earlier busy-wait was removed by PR #299 commit 5ee3e495 specifically
 * because spinning under contention degraded the host.
 *
 * @param lockFile - Absolute path to the lock file to create
 * @param lockDir  - Directory that must exist before acquiring (created if absent)
 * @throws {FileLockTimeoutError} When the lock cannot be acquired within the deadline
 */
export function acquireFileLockSync(lockFile: string, lockDir: string): void {
  fsSync.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  try {
    fsSync.chmodSync(lockDir, 0o700);
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
      atomicCreateLockSync(lockFile, JSON.stringify(content));
      return;
    } catch (err) {
      if (!isNodeError(err) || err.code !== 'EEXIST') {
        throw err;
      }

      const reclaimed = tryReclaimStaleSync(lockFile);
      if (reclaimed) {
        continue;
      }

      const jitter = RETRY_MIN_MS + Math.random() * (RETRY_MAX_MS - RETRY_MIN_MS);
      sleepSync(jitter);
    }
  }

  throw new FileLockTimeoutError(lockFile);
}

/**
 * Synchronous counterpart to {@link releaseFileLock}.
 *
 * Idempotent — does not throw if the file has already been removed.
 *
 * @param lockFile - Absolute path to the lock file to remove
 * @throws {Error} On I/O errors other than `ENOENT` (e.g. `EACCES`, `EIO`)
 */
export function releaseFileLockSync(lockFile: string): void {
  try {
    fsSync.unlinkSync(lockFile);
  } catch (err) {
    if (!isNodeError(err) || err.code !== 'ENOENT') {
      throw err;
    }
  }
}
