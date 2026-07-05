/**
 * Real-enforcement integration test for the macOS Seatbelt sandbox.
 *
 * Behaviour by environment:
 *   - Seatbelt available -> assert real grant-to-syscall success.
 *   - Seatbelt unavailable/non-macOS -> skip so CI and Linux dev machines stay green.
 *   - RUNDOWN_REQUIRE_SEATBELT=1 and unavailable -> fail.
 */
import { afterAll, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SeatbeltSandbox } from '../../src/sandbox/macos.js';
import type { SandboxOptions } from '../../src/sandbox/types.js';

const sandbox = new SeatbeltSandbox();
const availability = await sandbox.getAvailability();
const required = process.env.RUNDOWN_REQUIRE_SEATBELT === '1';

type SandboxOptionsWithNetwork = SandboxOptions & { network: 'deny' | 'allow' };

function metadataAncestorsFor(path: string): string[] {
  const ancestors: string[] = [];
  let current = path;
  while (current !== dirname(current)) {
    ancestors.unshift(current);
    current = dirname(current);
  }
  return ancestors.filter((ancestor) => ancestor !== '/');
}

function uniqueMetadataAncestorsFor(paths: readonly string[]): string[] {
  return [...new Set(paths.flatMap((path) => metadataAncestorsFor(path)))];
}

if (!availability.available) {
  const reason = availability.reason ?? 'unknown reason';
  if (required) {
    describe('SeatbeltSandbox real enforcement (integration)', () => {
      it('Seatbelt must be available when RUNDOWN_REQUIRE_SEATBELT=1', () => {
        throw new Error(`Expected a working Seatbelt sandbox but it is unavailable: ${reason}`);
      });
    });
  } else {
    console.info(`[seatbelt-integration] skipped - sandbox unavailable: ${reason}`);
    describe.skip(`SeatbeltSandbox real enforcement (integration) - ${reason}`, () => {
      it('enforces filesystem policy', () => {
        /* skipped */
      });
    });
  }
} else {
  describe('SeatbeltSandbox real enforcement (integration)', () => {
    const realExecutionTimeoutMs = 30_000;
    const repoCwd = realpathSync(process.cwd());
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'rundown-seatbelt-it-')));
    const grantedReadDir = join(root, 'read');
    const grantedWriteDir = join(root, 'write');
    const secretDir = join(root, 'secret');
    mkdirSync(grantedReadDir);
    mkdirSync(grantedWriteDir);
    mkdirSync(secretDir);
    writeFileSync(join(grantedReadDir, 'ok.txt'), 'ok');
    writeFileSync(join(secretDir, 'secret.txt'), 'top secret');

    afterAll(() => {
      rmSync(root, { recursive: true, force: true });
    });

    const run = (command: string, options: Partial<SandboxOptionsWithNetwork> = {}) => {
      const sandboxOptions = {
        cwd: repoCwd,
        repoRoot: repoCwd,
        readOnlyPaths: [repoCwd, grantedReadDir],
        readWritePaths: [grantedWriteDir],
        metadataReadPaths: uniqueMetadataAncestorsFor([repoCwd, root]),
        denyPaths: [],
        denyPatterns: [],
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        allowUnsandboxed: false,
        ...options,
        network: options.network ?? 'deny',
      } as SandboxOptions;

      return sandbox.execute(command, sandboxOptions);
    };

    it(
      'allows a real read syscall inside a granted read-only path',
      async () => {
        const result = await run(
          `node -e 'const fs=require("fs"); process.stdout.write(fs.readFileSync(${JSON.stringify(
            join(grantedReadDir, 'ok.txt'),
          )}, "utf8"))'`,
        );

        expect(result.sandboxed).toBe(true);
        expect(result.exitCode).toBe(0);
        expect(result.success).toBe(true);
      },
      realExecutionTimeoutMs,
    );

    it(
      'allows a real write syscall inside a granted read-write path',
      async () => {
        const target = join(grantedWriteDir, 'written.txt');
        const result = await run(
          `node -e 'require("fs").writeFileSync(${JSON.stringify(target)}, "written")'`,
        );

        expect(result.sandboxed).toBe(true);
        expect(result.exitCode).toBe(0);
        expect(result.success).toBe(true);
        expect(readFileSync(target, 'utf8')).toBe('written');
      },
      realExecutionTimeoutMs,
    );

    it(
      'blocks a real read syscall outside granted paths',
      async () => {
        const result = await run(
          `node -e 'require("fs").readFileSync(${JSON.stringify(join(secretDir, 'secret.txt'))})'`,
        );

        expect(result.sandboxed).toBe(true);
        expect(result.success).toBe(false);
        expect(result.exitCode).not.toBe(0);
      },
      realExecutionTimeoutMs,
    );

    const usersMetadataIt = repoCwd.startsWith('/Users/') ? it : it.skip;
    usersMetadataIt(
      'allows Node startup and cwd package reads from a /Users-rooted repo using metadata ancestors',
      async () => {
        const result = await sandbox.execute(
          "node -e \"require('fs').readFileSync(require.resolve('./package.json'), 'utf8')\"",
          {
            cwd: repoCwd,
            repoRoot: repoCwd,
            readOnlyPaths: [repoCwd],
            readWritePaths: [],
            metadataReadPaths: metadataAncestorsFor(repoCwd),
            denyPaths: [],
            denyPatterns: [],
            env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
            allowUnsandboxed: false,
            network: 'deny',
          } as SandboxOptions,
        );

        expect(result.sandboxed).toBe(true);
        expect(result.exitCode).toBe(0);
        expect(result.success).toBe(true);
      },
      realExecutionTimeoutMs,
    );
  });
}
