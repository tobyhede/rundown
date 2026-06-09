/**
 * Real-enforcement integration test for the Linux Landlock sandbox.
 *
 * Unlike `linux.test.ts` (which mocks `fs`/`child_process` to pin the wiring),
 * this test runs the *actual* {@link LandlockSandbox} against the *real*
 * `landrun` wrapper and the host kernel. It is therefore the only test that can
 * catch a regression in how Rundown invokes landrun (grant flags, ABI
 * handling) on a machine where Landlock genuinely works.
 *
 * Behaviour by environment:
 *   - Landlock available  -> assert real enforcement (granted reads/writes
 *     succeed; an ungranted read is blocked by the kernel).
 *   - Landlock unavailable -> skip, so dev machines (macOS, or Linux without
 *     landrun) stay green.
 *   - RUNDOWN_REQUIRE_LANDLOCK=1 and unavailable -> FAIL, so CI can guarantee
 *     the enforcement path is actually exercised rather than silently skipped.
 */
import { describe, it, expect, afterAll } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LandlockSandbox } from '../../src/sandbox/linux.js';
import type { SandboxOptions } from '../../src/sandbox/types.js';

const sandbox = new LandlockSandbox();
const availability = await sandbox.getAvailability();
const required = process.env.RUNDOWN_REQUIRE_LANDLOCK === '1';

if (!availability.available) {
  const reason = availability.reason ?? 'unknown reason';
  if (required) {
    describe('LandlockSandbox real enforcement (integration)', () => {
      it('Landlock must be available when RUNDOWN_REQUIRE_LANDLOCK=1', () => {
        throw new Error(`Expected a working Landlock sandbox but it is unavailable: ${reason}`);
      });
    });
  } else {
    console.info(`[landlock-integration] skipped — sandbox unavailable: ${reason}`);
    describe.skip(`LandlockSandbox real enforcement (integration) — ${reason}`, () => {
      it('enforces filesystem policy', () => {
        /* skipped */
      });
    });
  }
} else {
  describe('LandlockSandbox real enforcement (integration)', () => {
    const root = mkdtempSync(join(tmpdir(), 'rundown-landlock-it-'));
    const grantedDir = join(root, 'granted');
    const secretDir = join(root, 'secret');
    mkdirSync(grantedDir);
    mkdirSync(secretDir);
    writeFileSync(join(grantedDir, 'ok.txt'), 'ok');
    writeFileSync(join(secretDir, 'secret.txt'), 'top secret');

    afterAll(() => {
      rmSync(root, { recursive: true, force: true });
    });

    const run = (command: string, readOnlyPaths: string[], readWritePaths: string[] = []) =>
      sandbox.execute(command, {
        cwd: grantedDir,
        repoRoot: root,
        readOnlyPaths,
        readWritePaths,
        denyPaths: [],
        denyPatterns: [],
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        allowUnsandboxed: false,
      } satisfies SandboxOptions);

    it('allows reads inside a granted read-only path', async () => {
      const result = await run(`cat ${join(grantedDir, 'ok.txt')}`, [grantedDir]);

      expect(result.sandboxed).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.success).toBe(true);
    });

    it('blocks reads outside granted paths (real kernel enforcement)', async () => {
      const result = await run(`cat ${join(secretDir, 'secret.txt')}`, [grantedDir]);

      expect(result.sandboxed).toBe(true);
      expect(result.success).toBe(false);
      expect(result.exitCode).not.toBe(0);
    });

    it('allows writes inside a granted read-write path', async () => {
      const result = await run(`printf hi > ${join(grantedDir, 'written.txt')}`, [], [grantedDir]);

      expect(result.sandboxed).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.success).toBe(true);
    });
  });
}
