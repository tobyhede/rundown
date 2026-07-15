// packages/core/__tests__/runbook/file-lock-reclaim-identity-guard.test.ts
//
// Split out from file-lock.test.ts so it can be the SOLE file excluded from
// CodeQL analysis (see .github/codeql/codeql-config.yml). Every test here
// deliberately stages a controlled, single-threaded open→rm→recreate race at the
// same lock path to prove the identity guard survives a concurrent lock swap.
// That check→use sequence is the behaviour under test, but CodeQL's
// security-extended js/file-system-race (TOCTOU) query cannot tell an
// intentional test fixture from a real vulnerability and flags every pair. Rather
// than excluding all test code, we isolate exactly these fixtures here and
// paths-ignore this one file; the rest of the lock suite stays fully scanned.

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { unlinkStaleByIdentity, unlinkStaleByIdentitySync } from '../../src/runbook/file-lock.js';

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

  // The reclaim delete is guarded by dev/ino identity, compared against the
  // STILL-OPEN handle the lock was read through. Holding that handle pins the
  // observed inode, so a lock re-created at the same path during the
  // read→delete window cannot reuse the inode number and slip past the guard
  // (the concurrent-reclaimer TOCTOU). These pin that guard directly; passing
  // the open handle is also what makes the replacement's inode deterministically
  // distinct on inode-reusing filesystems (ext4 on CI).
  describe('reclaim identity guard', () => {
    it('async: removes the lock when the handle still matches the path', async () => {
      await fs.mkdir(lockDir, { recursive: true });
      await fs.writeFile(lockFile, 'stale', 'utf8');
      const handle = await fs.open(lockFile, 'r');
      try {
        expect(await unlinkStaleByIdentity(handle, lockFile)).toBe(true);
      } finally {
        await handle.close();
      }
      await expect(fs.readFile(lockFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('async: leaves the lock intact when it was replaced under the path', async () => {
      await fs.mkdir(lockDir, { recursive: true });
      await fs.writeFile(lockFile, 'stale', 'utf8');
      // Read the stale lock through a handle and keep it open — pins the
      // observed inode so the replacement below gets a distinct one.
      const handle = await fs.open(lockFile, 'r');
      try {
        // Another process reclaims + re-acquires: same path, new (live) inode.
        await fs.rm(lockFile);
        await fs.writeFile(lockFile, 'live-replacement', 'utf8');
        expect(await unlinkStaleByIdentity(handle, lockFile)).toBe(false);
        // The live replacement must survive untouched.
        expect(await fs.readFile(lockFile, 'utf8')).toBe('live-replacement');
      } finally {
        await handle.close();
      }
    });

    it('async: treats an already-vanished lock as reclaimed', async () => {
      await fs.mkdir(lockDir, { recursive: true });
      await fs.writeFile(lockFile, 'stale', 'utf8');
      const handle = await fs.open(lockFile, 'r');
      try {
        await fs.rm(lockFile);
        expect(await unlinkStaleByIdentity(handle, lockFile)).toBe(true);
      } finally {
        await handle.close();
      }
    });

    it('sync: leaves the lock intact when it was replaced under the path', () => {
      fsSync.mkdirSync(lockDir, { recursive: true });
      fsSync.writeFileSync(lockFile, 'stale', 'utf8');
      const fd = fsSync.openSync(lockFile, 'r');
      try {
        fsSync.rmSync(lockFile);
        fsSync.writeFileSync(lockFile, 'live-replacement', 'utf8');
        expect(unlinkStaleByIdentitySync(fd, lockFile)).toBe(false);
        expect(fsSync.readFileSync(lockFile, 'utf8')).toBe('live-replacement');
      } finally {
        fsSync.closeSync(fd);
      }
    });
  });
});
