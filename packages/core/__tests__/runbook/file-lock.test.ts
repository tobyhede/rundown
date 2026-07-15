// packages/core/__tests__/runbook/file-lock.test.ts

import { jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  acquireFileLock,
  acquireFileLockSync,
  FileLockTimeoutError,
  heldLock,
  heldLockSync,
  isLockContent,
  isProcessAlive,
  releaseFileLock,
  releaseFileLockSync,
  unlinkStaleByIdentity,
  unlinkStaleByIdentitySync,
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

    // Exclusivity property under contention, guarding the empty-lock-file
    // window (#585 CI flake). The historical bug: a lock created as an empty
    // `open('wx')` file and populated by a second write is observable empty by a
    // concurrent reclaimer, which parses `''` as corrupt and STEALS the live
    // lock — two acquirers enter the critical section and one increment is lost.
    // The atomic temp-write + `link()` create makes that window structurally
    // impossible (the lock file only appears already-populated). This test
    // asserts the resulting invariant: every increment survives. The race is
    // sub-millisecond and only widened enough to *fail* under heavy load (the
    // full parallel suite + coverage instrumentation that surfaced it in CI), so
    // treat this as a contention property check, not a standalone reproduction.
    it('serializes a shared-counter critical section under contention (no lost updates)', async () => {
      const counterFile = path.join(tmpDir, 'counter.json');
      await fs.writeFile(counterFile, '0', 'utf8');
      const FANOUT = 24;

      const bump = async (): Promise<void> => {
        await acquireFileLock(lockFile, lockDir);
        await using _guard = heldLock(
          () => releaseFileLock(lockFile),
          () => ({ lockFile }),
        );
        const current = Number.parseInt(await fs.readFile(counterFile, 'utf8'), 10);
        // Yield inside the critical section: a stolen lock lets a second holder
        // read the same `current` and clobber the increment.
        await new Promise((resolve) => setImmediate(resolve));
        await fs.writeFile(counterFile, String(current + 1), 'utf8');
      };

      await Promise.all(Array.from({ length: FANOUT }, () => bump()));

      const total = Number.parseInt(await fs.readFile(counterFile, 'utf8'), 10);
      expect(total).toBe(FANOUT);
    }, 30_000);

    it('acquire leaves no .tmp sidecar files in the lock directory', async () => {
      await acquireFileLock(lockFile, lockDir);
      try {
        const entries = await fs.readdir(lockDir);
        expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
        expect(entries).toContain(path.basename(lockFile));
      } finally {
        await releaseFileLock(lockFile);
      }
    });
  });

  // The reclaim delete is guarded by dev/ino identity so a reclaimer never
  // evicts a lock another process re-created in the read→delete window (the
  // concurrent-reclaimer TOCTOU). These pin that guard directly.
  describe('reclaim identity guard', () => {
    it('async: removes the lock when the inode still matches the observed one', async () => {
      await fs.mkdir(lockDir, { recursive: true });
      await fs.writeFile(lockFile, 'stale', 'utf8');
      const observed = await fs.stat(lockFile);

      expect(await unlinkStaleByIdentity(lockFile, observed)).toBe(true);
      await expect(fs.stat(lockFile)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('async: leaves the lock intact when it was replaced by a different inode', async () => {
      await fs.mkdir(lockDir, { recursive: true });
      await fs.writeFile(lockFile, 'stale', 'utf8');
      const observed = await fs.stat(lockFile);

      // Simulate another process reclaiming + re-acquiring: same path, new inode.
      await fs.unlink(lockFile);
      await fs.writeFile(lockFile, 'live-replacement', 'utf8');
      const replacement = await fs.stat(lockFile);
      expect(replacement.ino).not.toBe(observed.ino);

      expect(await unlinkStaleByIdentity(lockFile, observed)).toBe(false);
      // The live replacement must survive untouched.
      expect(await fs.readFile(lockFile, 'utf8')).toBe('live-replacement');
    });

    it('async: treats an already-vanished lock as reclaimed', async () => {
      await fs.mkdir(lockDir, { recursive: true });
      await fs.writeFile(lockFile, 'stale', 'utf8');
      const observed = await fs.stat(lockFile);
      await fs.unlink(lockFile);

      expect(await unlinkStaleByIdentity(lockFile, observed)).toBe(true);
    });

    it('sync: leaves the lock intact when it was replaced by a different inode', () => {
      fsSync.mkdirSync(lockDir, { recursive: true });
      fsSync.writeFileSync(lockFile, 'stale', 'utf8');
      const observed = fsSync.statSync(lockFile);

      fsSync.unlinkSync(lockFile);
      fsSync.writeFileSync(lockFile, 'live-replacement', 'utf8');
      expect(fsSync.statSync(lockFile).ino).not.toBe(observed.ino);

      expect(unlinkStaleByIdentitySync(lockFile, observed)).toBe(false);
      expect(fsSync.readFileSync(lockFile, 'utf8')).toBe('live-replacement');
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
      // pid 0 / negatives are process-GROUP targets for process.kill — must be
      // rejected so they are reclaimed instead of mis-read as a live process.
      ['zero pid', { pid: 0, created_at: 'x' }],
      ['negative pid', { pid: -5, created_at: 'x' }],
      ['non-integer pid', { pid: 1.5, created_at: 'x' }],
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

  describe('isProcessAlive error mapping', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('reports alive when kill(pid, 0) succeeds', () => {
      jest.spyOn(process, 'kill').mockReturnValue(true);
      expect(isProcessAlive(4242)).toBe(true);
    });

    it('reports dead only on ESRCH (no such process)', () => {
      jest.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      });
      expect(isProcessAlive(4242)).toBe(false);
    });

    it('treats EPERM as alive — the process exists but we may not signal it', () => {
      jest.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      });
      expect(isProcessAlive(4242)).toBe(true);
    });

    it('treats unexpected errors conservatively as alive', () => {
      jest.spyOn(process, 'kill').mockImplementation(() => {
        throw new Error('boom');
      });
      expect(isProcessAlive(4242)).toBe(true);
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

  describe('heldLock (scoped async-disposable)', () => {
    it('releases exactly once at scope exit via await using', async () => {
      let count = 0;
      {
        await using _guard = heldLock(
          async () => {
            count += 1;
          },
          () => ({}),
        );
        expect(count).toBe(0);
      }
      expect(count).toBe(1);
    });

    it('explicit release() disarms the automatic disposal (released at most once)', async () => {
      let count = 0;
      {
        await using guard = heldLock(
          async () => {
            count += 1;
          },
          () => ({}),
        );
        await guard.release();
        expect(count).toBe(1);
      }
      // The scope-exit dispose must be a no-op after an explicit release.
      expect(count).toBe(1);
    });

    it('disposal is best-effort: a throwing release neither propagates nor masks the result', async () => {
      const run = async (): Promise<string> => {
        await using _guard = heldLock(
          async () => {
            throw new Error('unlink denied');
          },
          () => ({}),
        );
        return 'committed-result';
      };
      // The committed result survives; the throwing disposer is swallowed.
      await expect(run()).resolves.toBe('committed-result');
    });
  });

  describe('heldLockSync (scoped disposable)', () => {
    it('releases exactly once at scope exit via using', () => {
      let count = 0;
      {
        using _guard = heldLockSync(
          () => {
            count += 1;
          },
          () => ({}),
        );
        expect(count).toBe(0);
      }
      expect(count).toBe(1);
    });

    it('disposal is best-effort: a throwing release does not propagate', () => {
      const run = (): string => {
        using _guard = heldLockSync(
          () => {
            throw new Error('unlink denied');
          },
          () => ({}),
        );
        return 'committed-result';
      };
      expect(run()).toBe('committed-result');
    });
  });
});
