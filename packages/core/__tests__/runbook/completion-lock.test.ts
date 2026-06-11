import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isNodeErrorCode } from '../../src/errors.js';
import { completionLockPath, locksDir } from '../../src/paths.js';
import { CompletionLock, CompletionLockTimeoutError } from '../../src/runbook/completion-lock.js';
import { FileLockTimeoutError } from '../../src/runbook/file-lock.js';

/** Find a PID that is guaranteed not to be running. */
function findDeadPid(): number {
  for (let pid = 2_000_000; pid < 2_100_000; pid++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (isNodeErrorCode(error, 'ESRCH')) return pid;
    }
  }
  throw new Error('Could not find a dead PID');
}

describe('CompletionLock', () => {
  const filePermissionsSupported = process.platform !== 'win32';
  let tmpDir: string;
  let lock: CompletionLock;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'completion-lock-'));
    lock = new CompletionLock(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('acquires and releases a lock', async () => {
    await lock.acquire('run-1');

    const lockPath = completionLockPath(tmpDir, 'run-1');
    const content = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    expect(content.pid).toBe(process.pid);
    expect(content.created_at).toBeDefined();

    await lock.release('run-1');

    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  it('creates lock file and directory with owner-only permissions', async () => {
    await lock.acquire('run-perms');

    const lockPath = completionLockPath(tmpDir, 'run-perms');
    expect((await fs.stat(lockPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(locksDir(tmpDir))).mode & 0o777).toBe(0o700);

    await lock.release('run-perms');
  });

  it('release is idempotent', async () => {
    await expect(lock.release('missing-run')).resolves.toBeUndefined();
  });

  it('reclaims stale lock from a dead PID', async () => {
    await fs.mkdir(locksDir(tmpDir), { recursive: true });
    const lockPath = completionLockPath(tmpDir, 'run-stale');
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: findDeadPid(), created_at: new Date().toISOString() }),
    );

    await lock.acquire('run-stale');

    const content = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    expect(content.pid).toBe(process.pid);

    await lock.release('run-stale');
  });

  it('reclaims corrupted lock files', async () => {
    await fs.mkdir(locksDir(tmpDir), { recursive: true });
    const lockPath = completionLockPath(tmpDir, 'run-corrupt');
    await fs.writeFile(lockPath, 'not json');

    await lock.acquire('run-corrupt');

    const content = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    expect(content.pid).toBe(process.pid);

    await lock.release('run-corrupt');
  });

  it('times out with typed CompletionLockTimeoutError when held by an alive process', async () => {
    await lock.acquire('run-timeout');
    const lock2 = new CompletionLock(tmpDir);

    let captured: unknown;
    try {
      await lock2.acquire('run-timeout');
    } catch (err) {
      captured = err;
    }

    expect(captured).toBeInstanceOf(CompletionLockTimeoutError);
    expect(captured).toBeInstanceOf(FileLockTimeoutError);
    if (captured instanceof CompletionLockTimeoutError) {
      expect(captured.runId).toBe('run-timeout');
      expect(captured.lockFile).toBe(completionLockPath(tmpDir, 'run-timeout'));
      expect(captured.message).toMatch(/Completion lock timeout for run run-timeout/);
    }

    await lock.release('run-timeout');
  }, 10_000);

  it('different run IDs have independent locks', async () => {
    await lock.acquire('run-a');
    await lock.acquire('run-b');

    await expect(fs.access(completionLockPath(tmpDir, 'run-a'))).resolves.toBeUndefined();
    await expect(fs.access(completionLockPath(tmpDir, 'run-b'))).resolves.toBeUndefined();

    await lock.release('run-a');
    await lock.release('run-b');
  });

  it('scope() propagates the typed timeout when held by an alive process', async () => {
    await lock.acquire('run-scope-timeout');
    const lock2 = new CompletionLock(tmpDir);

    await expect(lock2.scope('run-scope-timeout')).rejects.toBeInstanceOf(
      CompletionLockTimeoutError,
    );

    await lock.release('run-scope-timeout');
  }, 10_000);

  it('scope() releases the lock at await using scope exit', async () => {
    const lockPath = completionLockPath(tmpDir, 'run-scope');
    {
      await using _guard = await lock.scope('run-scope');
      // Lock is held inside the block.
      const content = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      expect(content.pid).toBe(process.pid);
    }
    // Released on block exit.
    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  it('held() disposal does not mask the committed outcome when unlink is denied (RD-102 regression)', async () => {
    // Impact-level regression for the RD-102 bug: a caller commits its work,
    // buffers a successful return value, and lets the `await using` guard
    // release the lock at scope exit. If the unlink fails (here a transient
    // EACCES forced by a read-only locks directory), the best-effort disposer
    // must swallow it — never propagate and replace the already-committed
    // return value. Goes RED if the guard disposer rethrows. (No effect as
    // root, where release succeeds and the assertion still holds trivially.)
    const lockDir = locksDir(tmpDir);

    async function commitThenScopedRelease(): Promise<{ ok: true; recorded: boolean }> {
      await lock.acquire('run-scoped-release');
      await using _guard = lock.held('run-scoped-release');
      // ... committing work already done; the caller has a successful result.
      if (filePermissionsSupported) {
        await fs.chmod(lockDir, 0o500);
      }
      return { ok: true, recorded: true };
    }

    try {
      await expect(commitThenScopedRelease()).resolves.toEqual({
        ok: true,
        recorded: true,
      });
    } finally {
      // Restore write permission so afterEach cleanup can remove the temp dir.
      if (filePermissionsSupported) {
        await fs.chmod(lockDir, 0o700);
      }
    }
  });

  (filePermissionsSupported ? it : it.skip)(
    'release() propagates a real (non-ENOENT) failure — honest by contract',
    async () => {
      // The guard owns the best-effort policy; release() itself stays honest so
      // genuine I/O failures remain diagnosable. Skipped as root, where the
      // read-only directory does not deny unlink.
      if (process.getuid?.() === 0) {
        return;
      }
      await lock.acquire('run-honest-release');
      const lockDir = locksDir(tmpDir);
      await fs.chmod(lockDir, 0o500);
      try {
        await expect(lock.release('run-honest-release')).rejects.toMatchObject({
          code: expect.stringMatching(/^(EACCES|EPERM)$/),
        });
      } finally {
        await fs.chmod(lockDir, 0o700);
      }
    },
  );
});
