import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { DelegationLock } from '../../src/runbook/delegation-lock.js';

/** Find a PID that is guaranteed not to be running. */
function findDeadPid(): number {
  for (let pid = 2_000_000; pid < 2_100_000; pid++) {
    try {
      process.kill(pid, 0);
    } catch {
      return pid;
    }
  }
  throw new Error('Could not find a dead PID');
}

describe('DelegationLock', () => {
  let tmpDir: string;
  let lock: DelegationLock;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'delegation-lock-'));
    lock = new DelegationLock(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('acquires and releases a lock', async () => {
    await lock.acquire('run-1');

    // Lock file should exist with pid and timestamp
    const lockPath = path.join(tmpDir, '.claude/rundown/locks/run-run-1.delegation.lock');
    const content = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    expect(content.pid).toBe(process.pid);
    expect(content.created_at).toBeDefined();

    await lock.release('run-1');

    // Lock file should be gone
    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  it('creates lock file with owner-only permissions (0o600)', async () => {
    await lock.acquire('run-perms');

    const lockPath = path.join(tmpDir, '.claude/rundown/locks/run-run-perms.delegation.lock');
    const stat = await fs.stat(lockPath);
    const fileMode = stat.mode & 0o777;
    expect(fileMode).toBe(0o600);

    await lock.release('run-perms');
  });

  it('creates lock directory with owner-only permissions (0o700)', async () => {
    await lock.acquire('run-dir-perms');

    const lockDir = path.join(tmpDir, '.claude/rundown/locks');
    const stat = await fs.stat(lockDir);
    const dirMode = stat.mode & 0o777;
    expect(dirMode).toBe(0o700);

    await lock.release('run-dir-perms');
  });

  it('second acquire blocks then succeeds after release', async () => {
    await lock.acquire('run-2');

    // Schedule release after 100ms
    setTimeout(() => {
      void lock.release('run-2');
    }, 100);

    // Second acquire should wait and then succeed
    await lock.acquire('run-2');

    // Clean up
    await lock.release('run-2');
  });

  it('release is idempotent', async () => {
    // Releasing a non-existent lock should not throw
    await expect(lock.release('nonexistent-run')).resolves.toBeUndefined();
  });

  it('reclaims stale lock from dead PID', async () => {
    // Manually write a lock file with a dead PID
    const lockDir = path.join(tmpDir, '.claude/rundown/locks');
    await fs.mkdir(lockDir, { recursive: true });

    const lockPath = path.join(lockDir, 'run-run-stale.delegation.lock');
    const staleLock = {
      pid: findDeadPid(),
      created_at: new Date(Date.now() - 120_000).toISOString(), // 2 minutes ago
    };
    await fs.writeFile(lockPath, JSON.stringify(staleLock));

    // Should reclaim the stale lock and acquire
    await lock.acquire('run-stale');

    // Verify our process now owns the lock
    const content = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    expect(content.pid).toBe(process.pid);

    await lock.release('run-stale');
  });

  it('reclaims corrupted lock file (non-JSON content)', async () => {
    const lockDir = path.join(tmpDir, '.claude/rundown/locks');
    await fs.mkdir(lockDir, { recursive: true });

    const lockPath = path.join(lockDir, 'run-run-corrupt.delegation.lock');
    await fs.writeFile(lockPath, 'NOT VALID JSON {{{');

    // Should reclaim the corrupted lock and acquire
    await lock.acquire('run-corrupt');

    // Verify our process now owns the lock
    const content = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    expect(content.pid).toBe(process.pid);

    await lock.release('run-corrupt');
  });

  it('times out when lock is held by alive process', async () => {
    // Acquire the lock with current process
    await lock.acquire('run-timeout');

    // Create a second lock instance — should time out because current process is alive
    const lock2 = new DelegationLock(tmpDir);

    await expect(lock2.acquire('run-timeout')).rejects.toThrow(/lock timeout/i);

    await lock.release('run-timeout');
  }, 10_000);
});
