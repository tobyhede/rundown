import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { DelegationLock } from '../../src/runbook/delegation-lock.js';

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
      pid: 999999, // Almost certainly not a running process
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

  it('times out when lock is held by alive process', async () => {
    // Acquire the lock with current process
    await lock.acquire('run-timeout');

    // Create a second lock instance — should time out because current process is alive
    const lock2 = new DelegationLock(tmpDir);

    await expect(lock2.acquire('run-timeout')).rejects.toThrow(/lock timeout/i);

    await lock.release('run-timeout');
  }, 10_000);
});
