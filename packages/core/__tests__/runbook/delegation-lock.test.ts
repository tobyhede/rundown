import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { DelegationLock, DelegationLockTimeoutError } from '../../src/runbook/delegation-lock.js';
import { FileLockTimeoutError } from '../../src/runbook/file-lock.js';
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
    await lock.acquire('wf_00000000000000000000000000000001');

    // Lock file should exist with pid and timestamp
    const lockPath = delegationLockPath(tmpDir, 'wf_00000000000000000000000000000001');
    const content = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    expect(content.pid).toBe(process.pid);
    expect(content.created_at).toBeDefined();

    await lock.release('wf_00000000000000000000000000000001');

    // Lock file should be gone
    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  it('creates lock file with owner-only permissions (0o600)', async () => {
    await lock.acquire('wf_00000000000000000000000000000002');

    const lockPath = delegationLockPath(tmpDir, 'wf_00000000000000000000000000000002');
    const stat = await fs.stat(lockPath);
    const fileMode = stat.mode & 0o777;
    expect(fileMode).toBe(0o600);

    await lock.release('wf_00000000000000000000000000000002');
  });

  it('creates lock directory with owner-only permissions (0o700)', async () => {
    await lock.acquire('wf_00000000000000000000000000000003');

    const lockDir = locksDir(tmpDir);
    const stat = await fs.stat(lockDir);
    const dirMode = stat.mode & 0o777;
    expect(dirMode).toBe(0o700);

    await lock.release('wf_00000000000000000000000000000003');
  });

  it('second acquire blocks then succeeds after release', async () => {
    await lock.acquire('wf_00000000000000000000000000000004');

    // Schedule release after 100ms
    setTimeout(() => {
      void lock.release('wf_00000000000000000000000000000004');
    }, 100);

    // Second acquire should wait and then succeed
    await lock.acquire('wf_00000000000000000000000000000004');

    // Clean up
    await lock.release('wf_00000000000000000000000000000004');
  });

  it('release is idempotent', async () => {
    // Releasing a non-existent lock should not throw
    await expect(lock.release('wf_00000000000000000000000000000005')).resolves.toBeUndefined();
  });

  it('reclaims stale lock from dead PID', async () => {
    // Manually write a lock file with a dead PID
    const lockDir = locksDir(tmpDir);
    await fs.mkdir(lockDir, { recursive: true });

    const lockPath = delegationLockPath(tmpDir, 'wf_00000000000000000000000000000006');
    const staleLock = {
      pid: findDeadPid(),
      created_at: new Date(Date.now() - 120_000).toISOString(), // 2 minutes ago
    };
    await fs.writeFile(lockPath, JSON.stringify(staleLock));

    // Should reclaim the stale lock and acquire
    await lock.acquire('wf_00000000000000000000000000000006');

    // Verify our process now owns the lock
    const content = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    expect(content.pid).toBe(process.pid);

    await lock.release('wf_00000000000000000000000000000006');
  });

  it('reclaims corrupted lock file (non-JSON content)', async () => {
    const lockDir = locksDir(tmpDir);
    await fs.mkdir(lockDir, { recursive: true });

    const lockPath = delegationLockPath(tmpDir, 'wf_00000000000000000000000000000007');
    await fs.writeFile(lockPath, 'NOT VALID JSON {{{');

    // Should reclaim the corrupted lock and acquire
    await lock.acquire('wf_00000000000000000000000000000007');

    // Verify our process now owns the lock
    const content = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    expect(content.pid).toBe(process.pid);

    await lock.release('wf_00000000000000000000000000000007');
  });

  it('times out with typed DelegationLockTimeoutError when held by alive process', async () => {
    // Acquire the lock with current process
    await lock.acquire('wf_00000000000000000000000000000008');

    // Create a second lock instance — should time out because current process is alive
    const lock2 = new DelegationLock(tmpDir);

    let captured: unknown;
    try {
      await lock2.acquire('wf_00000000000000000000000000000008');
    } catch (err) {
      captured = err;
    }

    expect(captured).toBeInstanceOf(DelegationLockTimeoutError);
    expect(captured).toBeInstanceOf(FileLockTimeoutError); // hierarchy preserved
    if (captured instanceof DelegationLockTimeoutError) {
      expect(captured.parentRunId).toBe('wf_00000000000000000000000000000008');
      expect(captured.lockFile).toBe(
        delegationLockPath(tmpDir, 'wf_00000000000000000000000000000008'),
      );
      expect(captured.message).toMatch(
        /Delegation lock timeout for run wf_00000000000000000000000000000008/,
      );
    }

    await lock.release('wf_00000000000000000000000000000008');
  }, 10_000);

  it('handles concurrent acquire attempts with retries', async () => {
    await lock.acquire('wf_00000000000000000000000000000009');

    // Schedule release after a short delay
    setTimeout(() => {
      void lock.release('wf_00000000000000000000000000000009');
    }, 200);

    // Second lock should retry and eventually acquire
    const lock2 = new DelegationLock(tmpDir);
    await lock2.acquire('wf_00000000000000000000000000000009');

    // Verify lock2 now owns the lock
    const lockPath = delegationLockPath(tmpDir, 'wf_00000000000000000000000000000009');
    const content = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    expect(content.pid).toBe(process.pid);

    await lock2.release('wf_00000000000000000000000000000009');
  });

  it('reclaims lock held by a dead process regardless of age', async () => {
    const lockDir = locksDir(tmpDir);
    await fs.mkdir(lockDir, { recursive: true });

    const lockPath = delegationLockPath(tmpDir, 'wf_0000000000000000000000000000000a');
    // PID 999999999 is beyond any valid PID on macOS/Linux so kill(pid,0) → ESRCH.
    const deadPid = 999999999;
    const staleLock = {
      pid: deadPid,
      created_at: new Date(Date.now() - 5_000).toISOString(),
    };
    await fs.writeFile(lockPath, JSON.stringify(staleLock));

    await lock.acquire('wf_0000000000000000000000000000000a');

    const content = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    expect(content.pid).toBe(process.pid);
    const age = Date.now() - new Date(content.created_at).getTime();
    expect(age).toBeLessThan(1000);

    await lock.release('wf_0000000000000000000000000000000a');
  });

  it('handles lock file disappearing between check and read (race condition)', async () => {
    // This simulates a race where another process removes the lock between
    // our EEXIST check and the readFile call in tryReclaimStale
    const lockDir = locksDir(tmpDir);
    await fs.mkdir(lockDir, { recursive: true });

    const lockPath = delegationLockPath(tmpDir, 'wf_0000000000000000000000000000000b');
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: findDeadPid(), created_at: new Date().toISOString() }),
    );

    // Start acquire, then delete the lock file to simulate race
    const acquirePromise = lock.acquire('wf_0000000000000000000000000000000b');

    // Wait briefly for the first retry to hit
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Remove lock file (simulates another process releasing)
    await fs.unlink(lockPath).catch(() => {
      /* ignore if already gone */
    });

    // Should eventually succeed (acquire handles vanishing lock gracefully)
    await acquirePromise;

    await lock.release('wf_0000000000000000000000000000000b');
  });

  it('handles empty lock file (0 bytes)', async () => {
    const lockDir = locksDir(tmpDir);
    await fs.mkdir(lockDir, { recursive: true });

    const lockPath = delegationLockPath(tmpDir, 'wf_0000000000000000000000000000000c');
    await fs.writeFile(lockPath, '');

    // Should reclaim the empty (corrupted) lock
    await lock.acquire('wf_0000000000000000000000000000000c');

    const content = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    expect(content.pid).toBe(process.pid);

    await lock.release('wf_0000000000000000000000000000000c');
  });

  it('multiple sequential acquire-release cycles work correctly', async () => {
    // Test that lock state is properly reset between cycles
    for (let i = 0; i < 5; i++) {
      await lock.acquire('wf_0000000000000000000000000000000d');
      await lock.release('wf_0000000000000000000000000000000d');
    }

    // Final acquire should succeed
    await lock.acquire('wf_0000000000000000000000000000000d');
    await lock.release('wf_0000000000000000000000000000000d');

    // Verify lock file is gone
    const lockPath = delegationLockPath(tmpDir, 'wf_0000000000000000000000000000000d');
    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  it('different run IDs have independent locks', async () => {
    // Acquire locks for multiple different runs
    await lock.acquire('wf_0000000000000000000000000000000e');
    await lock.acquire('wf_0000000000000000000000000000000f');
    await lock.acquire('wf_00000000000000000000000000000010');

    // All should coexist
    const lockA = delegationLockPath(tmpDir, 'wf_0000000000000000000000000000000e');
    const lockB = delegationLockPath(tmpDir, 'wf_0000000000000000000000000000000f');
    const lockC = delegationLockPath(tmpDir, 'wf_00000000000000000000000000000010');

    await expect(fs.access(lockA)).resolves.toBeUndefined();
    await expect(fs.access(lockB)).resolves.toBeUndefined();
    await expect(fs.access(lockC)).resolves.toBeUndefined();

    // Release all
    await lock.release('wf_0000000000000000000000000000000e');
    await lock.release('wf_0000000000000000000000000000000f');
    await lock.release('wf_00000000000000000000000000000010');
  });
});
