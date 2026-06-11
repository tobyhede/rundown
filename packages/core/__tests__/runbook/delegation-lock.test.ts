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
  const filePermissionsSupported = process.platform !== 'win32';
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

  it('scope() propagates the typed timeout when held by an alive process', async () => {
    await lock.acquire('run-scope-timeout');
    const lock2 = new DelegationLock(tmpDir);

    await expect(lock2.scope('run-scope-timeout')).rejects.toBeInstanceOf(
      DelegationLockTimeoutError,
    );

    await lock.release('run-scope-timeout');
  }, 10_000);

  it('scope() releases the lock at await using scope exit', async () => {
    const lockPath = delegationLockPath(tmpDir, 'run-scope');
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
    // return value (which discarded a successful claim's `claim_id` and
    // surfaced a spurious RD-102 + non-zero exit). Goes RED if the guard
    // disposer rethrows.
    const lockDir = locksDir(tmpDir);

    async function commitThenScopedRelease(): Promise<{ ok: true; claimId: string }> {
      await lock.acquire('run-scoped-release');
      await using _guard = lock.held('run-scoped-release');
      // ... committing work already done; the caller has a successful result.
      // Deny the unlink by removing write permission on the lock directory.
      // (No effect as root, where release succeeds and the assertion still
      // holds trivially — non-root CI reproduces the denied unlink.)
      await fs.chmod(lockDir, 0o500);
      return { ok: true, claimId: 'rdclm_committed_claim_id_0001' };
    }

    try {
      await expect(commitThenScopedRelease()).resolves.toEqual({
        ok: true,
        claimId: 'rdclm_committed_claim_id_0001',
      });
    } finally {
      // Restore write permission so afterEach cleanup can remove the temp dir.
      await fs.chmod(lockDir, 0o700);
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

  it('times out with typed DelegationLockTimeoutError when held by alive process', async () => {
    // Acquire the lock with current process
    await lock.acquire('run-timeout');

    // Create a second lock instance — should time out because current process is alive
    const lock2 = new DelegationLock(tmpDir);

    let captured: unknown;
    try {
      await lock2.acquire('run-timeout');
    } catch (err) {
      captured = err;
    }

    expect(captured).toBeInstanceOf(DelegationLockTimeoutError);
    expect(captured).toBeInstanceOf(FileLockTimeoutError); // hierarchy preserved
    if (captured instanceof DelegationLockTimeoutError) {
      expect(captured.parentRunId).toBe('run-timeout');
      expect(captured.lockFile).toBe(delegationLockPath(tmpDir, 'run-timeout'));
      expect(captured.message).toMatch(/Delegation lock timeout for run run-timeout/);
    }

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

  it('reclaims lock held by a dead process regardless of age', async () => {
    const lockDir = locksDir(tmpDir);
    await fs.mkdir(lockDir, { recursive: true });

    const lockPath = delegationLockPath(tmpDir, 'run-dead-owner');
    // PID 999999999 is beyond any valid PID on macOS/Linux so kill(pid,0) → ESRCH.
    const deadPid = 999999999;
    const staleLock = {
      pid: deadPid,
      created_at: new Date(Date.now() - 5_000).toISOString(),
    };
    await fs.writeFile(lockPath, JSON.stringify(staleLock));

    await lock.acquire('run-dead-owner');

    const content = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    expect(content.pid).toBe(process.pid);
    const age = Date.now() - new Date(content.created_at).getTime();
    expect(age).toBeLessThan(1000);

    await lock.release('run-dead-owner');
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
