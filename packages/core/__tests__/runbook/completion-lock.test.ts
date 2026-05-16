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
});
