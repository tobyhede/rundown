/**
 * Real-enforcement integration test for the Linux Landlock sandbox.
 *
 * Runs the actual {@link LandlockSandbox} against the bundled `rd-landlock`
 * binary and the host kernel.
 *
 * Behaviour by environment:
 *   - Landlock available  -> assert real enforcement (granted reads/writes
 *     succeed; an ungranted read is blocked; a truncate on a read-only grant is
 *     blocked; the negotiated ABI is >= 3).
 *   - Landlock unavailable -> skip so dev machines stay green.
 *   - RUNDOWN_REQUIRE_LANDLOCK=1 and unavailable -> FAIL.
 */
import { describe, it, expect, afterAll } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LandlockSandbox } from '../../src/sandbox/linux.js';
import type { SandboxOptions } from '../../src/sandbox/types.js';

// This suite runs from source under ts-jest, so the compiled-tree default
// (`defaultDistRoot()` = two levels up from dist/sandbox/linux.js) would
// resolve the helper under src/native/, where no binary is ever placed.
// Point the sandbox at the package's real dist root, where `build:native`
// (and CI's artifact placement) put the bundled rd-landlock binaries.
const sandbox = new LandlockSandbox({
  distRoot: fileURLToPath(new URL('../../dist', import.meta.url)),
});
const availability = await sandbox.getAvailability();
const required = process.env.RUNDOWN_REQUIRE_LANDLOCK === '1';
const hasPython3 = spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0;
const pythonIt = hasPython3 || required ? it : it.skip;

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

    const run = (
      command: string,
      readOnlyPaths: string[],
      readWritePaths: string[] = [],
      network: 'deny' | 'allow' = 'deny',
    ) =>
      sandbox.execute(command, {
        cwd: grantedDir,
        repoRoot: root,
        readOnlyPaths,
        readWritePaths,
        denyPaths: [],
        denyPatterns: [],
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        network,
        allowUnsandboxed: false,
      } satisfies SandboxOptions);

    it('negotiates and reports a Landlock ABI of at least 3', () => {
      expect(availability.landlockAbi ?? 0).toBeGreaterThanOrEqual(3);
    });

    it('allows reads inside a granted read-only path and surfaces the ABI', async () => {
      const result = await run(`cat ${join(grantedDir, 'ok.txt')}`, [grantedDir]);
      expect(result.sandboxed).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.success).toBe(true);
      expect(result.landlockAbi ?? 0).toBeGreaterThanOrEqual(3);
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

    it('blocks truncation of a file in a read-only grant (ABI >= 3 TRUNCATE)', async () => {
      const keep = join(grantedDir, 'ok.txt');
      const result = await run(`: > ${keep}`, [grantedDir]);
      expect(result.sandboxed).toBe(true);
      expect(result.success).toBe(false);
      expect(result.exitCode).not.toBe(0);
      // The file content must be intact — truncate was denied.
      expect(readFileSync(keep, 'utf8')).toBe('ok');
    });

    pythonIt('blocks AF_INET socket creation when network is denied', async () => {
      const result = await run(
        `python3 -c 'import socket; socket.socket(socket.AF_INET, socket.SOCK_STREAM)'`,
        [grantedDir],
        [],
        'deny',
      );

      expect(result.sandboxed).toBe(true);
      expect(result.networkPolicy).toBe('deny');
      expect(result.networkSandboxed).toBe(true);
      expect(result.success).toBe(false);
      expect(result.exitCode).not.toBe(0);
    });

    pythonIt('blocks AF_INET datagram socket creation when network is denied', async () => {
      const result = await run(
        `python3 -c 'import socket; socket.socket(socket.AF_INET, socket.SOCK_DGRAM)'`,
        [grantedDir],
        [],
        'deny',
      );

      expect(result.sandboxed).toBe(true);
      expect(result.networkPolicy).toBe('deny');
      expect(result.networkSandboxed).toBe(true);
      expect(result.success).toBe(false);
      expect(result.exitCode).not.toBe(0);
    });

    pythonIt('allows AF_UNIX socket creation when network is denied', async () => {
      const result = await run(
        `python3 -c 'import socket; s=socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.close()'`,
        [grantedDir],
        [],
        'deny',
      );

      expect(result.sandboxed).toBe(true);
      expect(result.networkPolicy).toBe('deny');
      expect(result.networkSandboxed).toBe(true);
      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
    });

    pythonIt('does not block AF_INET socket creation when network is allowed', async () => {
      const result = await run(
        `python3 -c 'import socket; s=socket.socket(socket.AF_INET, socket.SOCK_STREAM); s.close()'`,
        [grantedDir],
        [],
        'allow',
      );

      expect(result.sandboxed).toBe(true);
      expect(result.networkPolicy).toBe('allow');
      expect(result.networkSandboxed).toBe(false);
      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
    });

    pythonIt(
      'does not block AF_INET datagram socket creation when network is allowed',
      async () => {
        const result = await run(
          `python3 -c 'import socket; s=socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.close()'`,
          [grantedDir],
          [],
          'allow',
        );

        expect(result.sandboxed).toBe(true);
        expect(result.networkPolicy).toBe('allow');
        expect(result.networkSandboxed).toBe(false);
        expect(result.success).toBe(true);
        expect(result.exitCode).toBe(0);
      },
    );

    it('keeps a realistic local runtime command working when network is denied', async () => {
      const result = await run(
        `node -e 'require("os").userInfo(); require("os").networkInterfaces();'`,
        [grantedDir],
        [],
        'deny',
      );

      expect(result.sandboxed).toBe(true);
      expect(result.networkPolicy).toBe('deny');
      expect(result.networkSandboxed).toBe(true);
      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
    });
  });
}
