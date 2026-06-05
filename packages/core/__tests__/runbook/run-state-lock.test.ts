import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { locksDir, runStateLockPath } from '../../src/paths.js';
import { FileLockTimeoutError } from '../../src/runbook/file-lock.js';
import { RunStateLock, RunStateLockTimeoutError } from '../../src/runbook/run-state-lock.js';

describe('RunStateLock', () => {
  const filePermissionsSupported = process.platform !== 'win32';
  let tmpDir: string;
  let lock: RunStateLock;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-state-lock-'));
    lock = new RunStateLock(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('acquires and releases a lock', async () => {
    await lock.acquire('run-1');

    const lockPath = runStateLockPath(tmpDir, 'run-1');
    const content = JSON.parse(await fs.readFile(lockPath, 'utf8')) as {
      pid: number;
      created_at: string;
    };
    expect(content.pid).toBe(process.pid);
    expect(content.created_at).toBeDefined();

    await lock.release('run-1');

    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  (filePermissionsSupported ? it : it.skip)(
    'creates lock file and directory with owner-only permissions',
    async () => {
      await lock.acquire('run-perms');

      expect((await fs.stat(runStateLockPath(tmpDir, 'run-perms'))).mode & 0o777).toBe(0o600);
      expect((await fs.stat(locksDir(tmpDir))).mode & 0o777).toBe(0o700);

      await lock.release('run-perms');
    },
  );

  it('release is idempotent', async () => {
    await expect(lock.release('missing-run')).resolves.toBeUndefined();
  });

  it('times out with typed RunStateLockTimeoutError when held by an alive process', async () => {
    await lock.acquire('run-timeout');
    const lock2 = new RunStateLock(tmpDir);

    let captured: unknown;
    try {
      await lock2.acquire('run-timeout');
    } catch (err) {
      captured = err;
    }

    expect(captured).toBeInstanceOf(RunStateLockTimeoutError);
    expect(captured).toBeInstanceOf(FileLockTimeoutError);
    if (captured instanceof RunStateLockTimeoutError) {
      expect(captured.runId).toBe('run-timeout');
      expect(captured.lockFile).toBe(runStateLockPath(tmpDir, 'run-timeout'));
      expect(captured.message).toMatch(/Run-state lock timeout for run run-timeout/);
    }

    await lock.release('run-timeout');
  }, 10_000);

  it('different run IDs have independent locks', async () => {
    await lock.acquire('run-a');
    await lock.acquire('run-b');

    await expect(fs.access(runStateLockPath(tmpDir, 'run-a'))).resolves.toBeUndefined();
    await expect(fs.access(runStateLockPath(tmpDir, 'run-b'))).resolves.toBeUndefined();

    await lock.release('run-a');
    await lock.release('run-b');
  });
});
