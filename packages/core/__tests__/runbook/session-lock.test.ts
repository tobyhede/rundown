import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionLock, SessionLockTimeoutError } from '../../src/runbook/session-lock.js';
import { FileLockTimeoutError } from '../../src/runbook/file-lock.js';
import { locksDir, sessionLockPath } from '../../src/paths.js';

describe('SessionLock', () => {
  let tmpDir: string;
  let lock: SessionLock;

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

  it('creates lock file with owner-only permissions (0o600)', async () => {
    await lock.acquire();

    const lockPath = sessionLockPath(tmpDir);
    const stat = await fs.stat(lockPath);
    expect(stat.mode & 0o777).toBe(0o600);

    await lock.release();
  });

  it('creates lock directory with owner-only permissions (0o700)', async () => {
    await lock.acquire();

    const stat = await fs.stat(locksDir(tmpDir));
    expect(stat.mode & 0o777).toBe(0o700);

    await lock.release();
  });

  it('second acquire blocks then succeeds after release', async () => {
    await lock.acquire();

    setTimeout(() => {
      void lock.release();
    }, 100);

    await lock.acquire();
    await lock.release();
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
      expect(captured.lockFile).toBe(sessionLockPath(tmpDir));
      expect(captured.message).toMatch(/Session lock timeout/);
    }

    await lock.release();
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
});
