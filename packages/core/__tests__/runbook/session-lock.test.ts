import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionLock, SessionLockTimeoutError } from '../../src/runbook/session-lock.js';
import { FileLockTimeoutError } from '../../src/runbook/file-lock.js';
import { locksDir, sessionLockPath } from '../../src/paths.js';

describe('SessionLock', () => {
  const filePermissionsSupported = process.platform !== 'win32';
  let tmpDir: string;
  let lock: SessionLock;

  async function canonicalSessionLockPath(dir: string): Promise<string> {
    return sessionLockPath(await fs.realpath(dir));
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-lock-'));
    lock = new SessionLock(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('acquires and releases a lock', async () => {
    await lock.acquire();

    const lockPath = sessionLockPath(tmpDir);
    const content = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    expect(content.pid).toBe(process.pid);
    expect(content.created_at).toBeDefined();

    await lock.release();

    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  (filePermissionsSupported ? it : it.skip)(
    'creates lock file with owner-only permissions (0o600)',
    async () => {
      await lock.acquire();

      const lockPath = sessionLockPath(tmpDir);
      const stat = await fs.stat(lockPath);
      expect(stat.mode & 0o777).toBe(0o600);

      await lock.release();
    },
  );

  (filePermissionsSupported ? it : it.skip)(
    'creates lock directory with owner-only permissions (0o700)',
    async () => {
      await lock.acquire();

      const stat = await fs.stat(locksDir(tmpDir));
      expect(stat.mode & 0o777).toBe(0o700);

      await lock.release();
    },
  );

  it('second acquire blocks then succeeds after release', async () => {
    await lock.acquire();
    const lock2 = new SessionLock(tmpDir);

    setTimeout(() => {
      void lock.release();
    }, 100);

    await lock2.acquire();
    await lock2.release();
  });

  it('release is idempotent', async () => {
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it('times out with typed SessionLockTimeoutError when held by alive process', async () => {
    await lock.acquire();

    const lock2 = new SessionLock(tmpDir);

    let captured: unknown;
    try {
      await lock2.acquire();
    } catch (err) {
      captured = err;
    }

    expect(captured).toBeInstanceOf(SessionLockTimeoutError);
    expect(captured).toBeInstanceOf(FileLockTimeoutError);
    if (captured instanceof SessionLockTimeoutError) {
      expect(captured.lockFile).toBe(await canonicalSessionLockPath(tmpDir));
      expect(captured.message).toMatch(/Session lock timeout/);
    }

    await lock.release();
  }, 10_000);

  it('canonicalizes symlinked project roots to the same lock file', async () => {
    const alias = `${tmpDir}-alias`;
    await fs.symlink(tmpDir, alias, 'dir');
    const aliasLock = new SessionLock(alias);

    await lock.acquire();
    let captured: unknown;
    try {
      await aliasLock.acquire();
    } catch (err) {
      captured = err;
    }

    expect(captured).toBeInstanceOf(SessionLockTimeoutError);
    if (captured instanceof SessionLockTimeoutError) {
      expect(captured.lockFile).toBe(await canonicalSessionLockPath(tmpDir));
    }

    await lock.release();
    await fs.rm(alias, { force: true });
  }, 10_000);

  it('multiple sequential acquire-release cycles work correctly', async () => {
    for (let i = 0; i < 5; i++) {
      await lock.acquire();
      await lock.release();
    }

    await lock.acquire();
    await lock.release();

    await expect(fs.access(sessionLockPath(tmpDir))).rejects.toThrow();
  });

  it('scope() propagates the typed timeout when held by an alive process', async () => {
    await lock.acquire();
    const lock2 = new SessionLock(tmpDir);

    await expect(lock2.scope()).rejects.toBeInstanceOf(SessionLockTimeoutError);

    await lock.release();
  }, 10_000);

  it('scope() releases the lock at await using scope exit', async () => {
    const lockPath = await canonicalSessionLockPath(tmpDir);
    {
      await using _guard = await lock.scope();
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
    // return value. Goes RED if the guard disposer rethrows. On platforms
    // without enforced permissions (Windows) the chmod is a no-op and the
    // release simply succeeds, so the assertion still holds trivially.
    const lockDir = locksDir(tmpDir);

    async function commitThenScopedRelease(): Promise<{ ok: true; sessionId: string }> {
      await lock.acquire();
      await using _guard = lock.held();
      // ... committing work already done; the caller has a successful result.
      if (filePermissionsSupported) {
        await fs.chmod(lockDir, 0o500);
      }
      return { ok: true, sessionId: 'committed_session_id_0001' };
    }

    try {
      await expect(commitThenScopedRelease()).resolves.toEqual({
        ok: true,
        sessionId: 'committed_session_id_0001',
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
      await lock.acquire();
      const lockDir = locksDir(tmpDir);
      await fs.chmod(lockDir, 0o500);
      try {
        await expect(lock.release()).rejects.toMatchObject({
          code: expect.stringMatching(/^(EACCES|EPERM)$/),
        });
      } finally {
        await fs.chmod(lockDir, 0o700);
      }
    },
  );
});
