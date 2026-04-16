// packages/core/__tests__/runbook/file-lock.test.ts

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  acquireFileLock,
  FileLockTimeoutError,
  releaseFileLock,
} from '../../src/runbook/file-lock.js';

describe('file-lock', () => {
  let tmpDir: string;
  let lockDir: string;
  let lockFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-lock-test-'));
    lockDir = path.join(tmpDir, 'locks');
    lockFile = path.join(lockDir, 'test.lock');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('acquireFileLock', () => {
    it('creates the lock directory and lock file on first acquire', async () => {
      await acquireFileLock(lockFile, lockDir);
      try {
        const stat = await fs.stat(lockFile);
        expect(stat.isFile()).toBe(true);
      } finally {
        await releaseFileLock(lockFile);
      }
    });

    it('lock file contains valid JSON with pid and created_at', async () => {
      await acquireFileLock(lockFile, lockDir);
      try {
        const raw = await fs.readFile(lockFile, 'utf8');
        const content = JSON.parse(raw) as { pid: number; created_at: string };
        expect(content.pid).toBe(process.pid);
        expect(typeof content.created_at).toBe('string');
        expect(Number.isNaN(Date.parse(content.created_at))).toBe(false);
      } finally {
        await releaseFileLock(lockFile);
      }
    });

    it('reclaims a stale lock from a dead process and rewrites content', async () => {
      // PID 999999999 is beyond any valid PID on macOS/Linux so kill(pid,0) → ESRCH
      const deadPid = 999999999;
      const staleTimestamp = new Date(Date.now() - 5 * 60_000).toISOString();
      await fs.mkdir(lockDir, { recursive: true });
      await fs.writeFile(
        lockFile,
        JSON.stringify({ pid: deadPid, created_at: staleTimestamp }),
        'utf8',
      );
      const acquireStart = Date.now();

      await acquireFileLock(lockFile, lockDir);
      try {
        const raw = await fs.readFile(lockFile, 'utf8');
        const content = JSON.parse(raw) as { pid: number; created_at: string };
        expect(content.pid).toBe(process.pid);
        expect(content.pid).not.toBe(deadPid);
        // created_at must have been replaced with a fresh timestamp
        expect(Number.isNaN(Date.parse(content.created_at))).toBe(false);
        expect(Date.parse(content.created_at)).toBeGreaterThanOrEqual(acquireStart - 1000);
        expect(content.created_at).not.toBe(staleTimestamp);
      } finally {
        await releaseFileLock(lockFile);
      }
    });

    it('reclaims a lock with an age over 60 seconds and refreshes created_at', async () => {
      await fs.mkdir(lockDir, { recursive: true });
      const oldDate = new Date(Date.now() - 70_000).toISOString();
      // Use current pid so "dead" check doesn't trigger — stale age check should
      await fs.writeFile(
        lockFile,
        JSON.stringify({ pid: process.pid, created_at: oldDate }),
        'utf8',
      );
      const acquireStart = Date.now();

      await acquireFileLock(lockFile, lockDir);
      try {
        const raw = await fs.readFile(lockFile, 'utf8');
        const content = JSON.parse(raw) as { pid: number; created_at: string };
        expect(content.pid).toBe(process.pid);
        expect(content.created_at).not.toBe(oldDate);
        expect(Date.parse(content.created_at)).toBeGreaterThanOrEqual(acquireStart - 1000);
      } finally {
        await releaseFileLock(lockFile);
      }
    });

    it('reclaims a lock file with corrupted (non-JSON) content and writes valid JSON', async () => {
      await fs.mkdir(lockDir, { recursive: true });
      await fs.writeFile(lockFile, 'not valid json {{{', 'utf8');
      const acquireStart = Date.now();

      await acquireFileLock(lockFile, lockDir);
      try {
        const raw = await fs.readFile(lockFile, 'utf8');
        const content = JSON.parse(raw) as { pid: number; created_at: string };
        expect(content.pid).toBe(process.pid);
        expect(Number.isNaN(Date.parse(content.created_at))).toBe(false);
        expect(Date.parse(content.created_at)).toBeGreaterThanOrEqual(acquireStart - 1000);
      } finally {
        await releaseFileLock(lockFile);
      }
    });
  });

  describe('releaseFileLock', () => {
    it('removes the lock file after acquire', async () => {
      await acquireFileLock(lockFile, lockDir);
      await releaseFileLock(lockFile);

      await expect(fs.stat(lockFile)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('is idempotent — does not throw when lock file is already gone', async () => {
      await expect(releaseFileLock(lockFile)).resolves.toBeUndefined();
    });
  });

  describe('timeout', () => {
    it('throws typed FileLockTimeoutError when held by alive process', async () => {
      await acquireFileLock(lockFile, lockDir);
      try {
        let captured: unknown;
        try {
          await acquireFileLock(lockFile, lockDir);
        } catch (err) {
          captured = err;
        }
        expect(captured).toBeInstanceOf(FileLockTimeoutError);
        if (captured instanceof FileLockTimeoutError) {
          expect(captured.lockFile).toBe(lockFile);
          expect(captured.message).toMatch(/File lock timeout/);
        }
      } finally {
        await releaseFileLock(lockFile);
      }
    }, 10_000);
  });

  describe('parallel acquisition', () => {
    it('two concurrent acquires on different lock files both succeed', async () => {
      const lockFile2 = path.join(lockDir, 'test2.lock');

      await Promise.all([acquireFileLock(lockFile, lockDir), acquireFileLock(lockFile2, lockDir)]);

      try {
        expect((await fs.stat(lockFile)).isFile()).toBe(true);
        expect((await fs.stat(lockFile2)).isFile()).toBe(true);
      } finally {
        await Promise.all([releaseFileLock(lockFile), releaseFileLock(lockFile2)]);
      }
    });
  });
});
