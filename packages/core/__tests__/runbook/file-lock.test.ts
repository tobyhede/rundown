// packages/core/__tests__/runbook/file-lock.test.ts

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  acquireFileLock,
  acquireFileLockSync,
  FileLockTimeoutError,
  isLockContent,
  releaseFileLock,
  releaseFileLockSync,
} from '../../src/runbook/file-lock.js';

interface LockContent {
  pid: number;
  created_at: string;
}

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
        const content = JSON.parse(raw) as LockContent;
        expect(content.pid).toBe(process.pid);
        expect(typeof content.created_at).toBe('string');
        expect(Number.isNaN(Date.parse(content.created_at))).toBe(false);
      } finally {
        await releaseFileLock(lockFile);
      }
    });

    it('reclaims a stale lock from a dead process and rewrites content', async () => {
      // PID 999999999 is beyond any valid PID on macOS/Linux so kill(pid,0) → ESRCH.
      // Lock reclaim is gated solely on process liveness; age does not matter.
      const deadPid = 999999999;
      const freshTimestamp = new Date(Date.now() - 5_000).toISOString();
      await fs.mkdir(lockDir, { recursive: true });
      await fs.writeFile(
        lockFile,
        JSON.stringify({ pid: deadPid, created_at: freshTimestamp }),
        'utf8',
      );
      const acquireStart = Date.now();

      await acquireFileLock(lockFile, lockDir);
      try {
        const raw = await fs.readFile(lockFile, 'utf8');
        const content = JSON.parse(raw) as LockContent;
        expect(content.pid).toBe(process.pid);
        expect(content.pid).not.toBe(deadPid);
        // created_at must have been replaced with a fresh timestamp
        expect(Number.isNaN(Date.parse(content.created_at))).toBe(false);
        expect(Date.parse(content.created_at)).toBeGreaterThanOrEqual(acquireStart - 1000);
        expect(content.created_at).not.toBe(freshTimestamp);
      } finally {
        await releaseFileLock(lockFile);
      }
    });

    it('does not steal a live lock even when its age exceeds the former 60s threshold', async () => {
      // Regression guard: a slow but live writer must retain its mutex. Age
      // alone must not trigger reclaim. `acquireFileLock` retries for up to
      // the 5s internal deadline before throwing `FileLockTimeoutError`, so
      // this test needs a jest timeout strictly greater than that.
      await fs.mkdir(lockDir, { recursive: true });
      const veryOld = new Date(Date.now() - 10 * 60_000).toISOString();
      await fs.writeFile(
        lockFile,
        JSON.stringify({ pid: process.pid, created_at: veryOld }),
        'utf8',
      );

      await expect(acquireFileLock(lockFile, lockDir)).rejects.toBeInstanceOf(FileLockTimeoutError);

      // Lock file must remain intact with the original live-holder metadata.
      const raw = await fs.readFile(lockFile, 'utf8');
      const content = JSON.parse(raw) as LockContent;
      expect(content.pid).toBe(process.pid);
      expect(content.created_at).toBe(veryOld);

      await fs.unlink(lockFile);
    }, 10_000);

    it('reclaims a lock file with corrupted (non-JSON) content and writes valid JSON', async () => {
      await fs.mkdir(lockDir, { recursive: true });
      await fs.writeFile(lockFile, 'not valid json {{{', 'utf8');
      const acquireStart = Date.now();

      await acquireFileLock(lockFile, lockDir);
      try {
        const raw = await fs.readFile(lockFile, 'utf8');
        const content = JSON.parse(raw) as LockContent;
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

  // Sync variants share the lock-file format with the async path, so a sync
  // acquire correctly observes async-held locks (and vice versa). The tests
  // below mirror the async suite plus a cross-mode contention case.
  describe('acquireFileLockSync', () => {
    it('creates the lock directory and lock file on first acquire', () => {
      acquireFileLockSync(lockFile, lockDir);
      try {
        expect(fsSync.statSync(lockFile).isFile()).toBe(true);
      } finally {
        releaseFileLockSync(lockFile);
      }
    });

    it('lock file contains valid JSON with pid and created_at', () => {
      acquireFileLockSync(lockFile, lockDir);
      try {
        const raw = fsSync.readFileSync(lockFile, 'utf8');
        const content = JSON.parse(raw) as LockContent;
        expect(content.pid).toBe(process.pid);
        expect(Number.isNaN(Date.parse(content.created_at))).toBe(false);
      } finally {
        releaseFileLockSync(lockFile);
      }
    });

    it('reclaims a stale lock from a dead process', () => {
      const deadPid = 999999999;
      fsSync.mkdirSync(lockDir, { recursive: true });
      fsSync.writeFileSync(
        lockFile,
        JSON.stringify({ pid: deadPid, created_at: new Date().toISOString() }),
        'utf8',
      );

      acquireFileLockSync(lockFile, lockDir);
      try {
        const raw = fsSync.readFileSync(lockFile, 'utf8');
        const content = JSON.parse(raw) as LockContent;
        expect(content.pid).toBe(process.pid);
        expect(content.pid).not.toBe(deadPid);
      } finally {
        releaseFileLockSync(lockFile);
      }
    });

    it('reclaims a corrupted (non-JSON) lock', () => {
      fsSync.mkdirSync(lockDir, { recursive: true });
      fsSync.writeFileSync(lockFile, 'not valid json {{{', 'utf8');

      acquireFileLockSync(lockFile, lockDir);
      try {
        const raw = fsSync.readFileSync(lockFile, 'utf8');
        const content = JSON.parse(raw) as LockContent;
        expect(content.pid).toBe(process.pid);
      } finally {
        releaseFileLockSync(lockFile);
      }
    });

    it('throws FileLockTimeoutError when an async lock holder is alive', async () => {
      // Cross-mode contention: the async path owns the lock, the sync path
      // must respect it and time out without stealing it.
      await acquireFileLock(lockFile, lockDir);
      try {
        let captured: unknown;
        try {
          acquireFileLockSync(lockFile, lockDir);
        } catch (err) {
          captured = err;
        }
        expect(captured).toBeInstanceOf(FileLockTimeoutError);
        if (captured instanceof FileLockTimeoutError) {
          expect(captured.lockFile).toBe(lockFile);
        }
      } finally {
        await releaseFileLock(lockFile);
      }
    }, 10_000);
  });

  describe('releaseFileLockSync', () => {
    it('removes the lock file after acquire', () => {
      acquireFileLockSync(lockFile, lockDir);
      releaseFileLockSync(lockFile);
      expect(() => fsSync.statSync(lockFile)).toThrow(/ENOENT/);
    });

    it('is idempotent — does not throw when lock file is already gone', () => {
      expect(() => {
        releaseFileLockSync(lockFile);
      }).not.toThrow();
    });
  });

  describe('isLockContent shape guard', () => {
    it('accepts well-formed lock content', () => {
      expect(isLockContent({ pid: process.pid, created_at: new Date().toISOString() })).toBe(true);
    });

    it.each([
      ['non-numeric pid', { pid: 'not-a-pid', created_at: 'x' }],
      ['null pid', { pid: null, created_at: 'x' }],
      ['NaN pid', { pid: Number.NaN, created_at: 'x' }],
      ['infinite pid', { pid: Number.POSITIVE_INFINITY, created_at: 'x' }],
      ['missing pid', { created_at: 'x' }],
      ['non-string created_at', { pid: 1, created_at: 123 }],
      ['missing created_at', { pid: 1 }],
      ['null value', null],
      ['array value', []],
      ['string value', 'nope'],
    ])('rejects %s so it is never trusted as a live pid', (_label, value) => {
      expect(isLockContent(value)).toBe(false);
    });
  });

  describe('shape-invalid lock content reclaim (end-to-end)', () => {
    it('async acquire reclaims a lock whose pid is not a number', async () => {
      // Valid JSON, invalid shape: a non-numeric pid must never reach
      // process.kill — it is as untrustworthy as corrupted JSON.
      await fs.mkdir(lockDir, { recursive: true });
      await fs.writeFile(lockFile, JSON.stringify({ pid: 'not-a-pid', created_at: 'x' }), 'utf8');

      await expect(acquireFileLock(lockFile, lockDir)).resolves.toBeUndefined();
      try {
        const reclaimed = JSON.parse(await fs.readFile(lockFile, 'utf8')) as LockContent;
        expect(reclaimed.pid).toBe(process.pid);
      } finally {
        await releaseFileLock(lockFile);
      }
    });

    it('sync acquire reclaims a lock whose pid is null', async () => {
      await fs.mkdir(lockDir, { recursive: true });
      await fs.writeFile(lockFile, JSON.stringify({ pid: null, created_at: 'x' }), 'utf8');

      expect(() => {
        acquireFileLockSync(lockFile, lockDir);
      }).not.toThrow();
      try {
        const reclaimed = JSON.parse(fsSync.readFileSync(lockFile, 'utf8')) as LockContent;
        expect(reclaimed.pid).toBe(process.pid);
      } finally {
        releaseFileLockSync(lockFile);
      }
    });
  });
});
