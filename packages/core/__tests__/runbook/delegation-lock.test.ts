import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { DelegationLock } from '../../src/runbook/delegation-lock.js';
import { locksDir, delegationLockPath } from '../../src/paths.js';

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
    const lockPath = delegationLockPath(tmpDir, 'run-1');
    const content = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    expect(content.pid).toBe(process.pid);
    expect(content.created_at).toBeDefined();

    await lock.release('run-1');

    // Lock file should be gone
    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  it('creates lock file with owner-only permissions (0o600)', async () => {
    await lock.acquire('run-perms');

    const lockPath = delegationLockPath(tmpDir, 'run-perms');
    const stat = await fs.stat(lockPath);
    const fileMode = stat.mode & 0o777;
    expect(fileMode).toBe(0o600);

    await lock.release('run-perms');
  });

  it('creates lock directory with owner-only permissions (0o700)', async () => {
    await lock.acquire('run-dir-perms');

    const lockDir = locksDir(tmpDir);
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
    const lockDir = locksDir(tmpDir);
    await fs.mkdir(lockDir, { recursive: true });

    const lockPath = delegationLockPath(tmpDir, 'run-stale');
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
    const lockDir = locksDir(tmpDir);
    await fs.mkdir(lockDir, { recursive: true });

    const lockPath = delegationLockPath(tmpDir, 'run-corrupt');
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

  it('handles concurrent acquire attempts with retries', async () => {
    await lock.acquire('run-concurrent');

    // Schedule release after a short delay
    setTimeout(() => {
      void lock.release('run-concurrent');
    }, 200);

    // Second lock should retry and eventually acquire
    const lock2 = new DelegationLock(tmpDir);
    await lock2.acquire('run-concurrent');

    // Verify lock2 now owns the lock
    const lockPath = delegationLockPath(tmpDir, 'run-concurrent');
    const content = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    expect(content.pid).toBe(process.pid);

    await lock2.release('run-concurrent');
  });

  it('reclaims lock when file age exceeds stale threshold (60s)', async () => {
    const lockDir = locksDir(tmpDir);
    await fs.mkdir(lockDir, { recursive: true });

    const lockPath = delegationLockPath(tmpDir, 'run-old');
    // Write a lock that's 61 seconds old (exceeds 60s threshold)
    const oldLock = {
      pid: process.pid, // Even if PID is alive
      created_at: new Date(Date.now() - 61_000).toISOString(),
    };
    await fs.writeFile(lockPath, JSON.stringify(oldLock));

    // Should reclaim the old lock
    await lock.acquire('run-old');

    const content = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    expect(content.pid).toBe(process.pid);
    // Timestamp should be recent, not the old one
    const age = Date.now() - new Date(content.created_at).getTime();
    expect(age).toBeLessThan(1000);

    await lock.release('run-old');
  });

  it('handles lock file disappearing between check and read (race condition)', async () => {
    // This simulates a race where another process removes the lock between
    // our EEXIST check and the readFile call in tryReclaimStale
    const lockDir = locksDir(tmpDir);
    await fs.mkdir(lockDir, { recursive: true });

    const lockPath = delegationLockPath(tmpDir, 'run-vanish');
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: findDeadPid(), created_at: new Date().toISOString() }),
    );

    // Start acquire, then delete the lock file to simulate race
    const acquirePromise = lock.acquire('run-vanish');

    // Wait briefly for the first retry to hit
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Remove lock file (simulates another process releasing)
    await fs.unlink(lockPath).catch(() => {
      /* ignore if already gone */
    });

    // Should eventually succeed (acquire handles vanishing lock gracefully)
    await acquirePromise;

    await lock.release('run-vanish');
  });

  it('handles empty lock file (0 bytes)', async () => {
    const lockDir = locksDir(tmpDir);
    await fs.mkdir(lockDir, { recursive: true });

    const lockPath = delegationLockPath(tmpDir, 'run-empty');
    await fs.writeFile(lockPath, '');

    // Should reclaim the empty (corrupted) lock
    await lock.acquire('run-empty');

    const content = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    expect(content.pid).toBe(process.pid);

    await lock.release('run-empty');
  });

  it('multiple sequential acquire-release cycles work correctly', async () => {
    // Test that lock state is properly reset between cycles
    for (let i = 0; i < 5; i++) {
      await lock.acquire('run-cycle');
      await lock.release('run-cycle');
    }

    // Final acquire should succeed
    await lock.acquire('run-cycle');
    await lock.release('run-cycle');

    // Verify lock file is gone
    const lockPath = delegationLockPath(tmpDir, 'run-cycle');
    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  it('different run IDs have independent locks', async () => {
    // Acquire locks for multiple different runs
    await lock.acquire('run-a');
    await lock.acquire('run-b');
    await lock.acquire('run-c');

    // All should coexist
    const lockA = delegationLockPath(tmpDir, 'run-a');
    const lockB = delegationLockPath(tmpDir, 'run-b');
    const lockC = delegationLockPath(tmpDir, 'run-c');

    await expect(fs.access(lockA)).resolves.toBeUndefined();
    await expect(fs.access(lockB)).resolves.toBeUndefined();
    await expect(fs.access(lockC)).resolves.toBeUndefined();

    // Release all
    await lock.release('run-a');
    await lock.release('run-b');
    await lock.release('run-c');
  });
});
