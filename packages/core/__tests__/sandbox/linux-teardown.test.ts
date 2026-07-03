import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chmodSync, mkdtempSync, openSync, readSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LandlockSandbox } from '../../src/sandbox/linux.js';
import type { SandboxOptions } from '../../src/sandbox/types.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-helper-grandchild.mjs', import.meta.url));
const UNKILLABLE = fileURLToPath(new URL('./fixtures/fake-helper-unkillable.mjs', import.meta.url));
chmodSync(FAKE, 0o755);
chmodSync(UNKILLABLE, 0o755);

const teardownBase: SandboxOptions = {
  cwd: process.cwd(),
  repoRoot: process.cwd(),
  readOnlyPaths: [],
  readWritePaths: [],
  denyPaths: [],
  denyPatterns: [],
  env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
  allowUnsandboxed: true,
};

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('LandlockSandbox process-group teardown', () => {
  const original = process.platform;
  beforeEach(
    () => void Object.defineProperty(process, 'platform', { value: 'linux', configurable: true }),
  );
  afterEach(
    () => void Object.defineProperty(process, 'platform', { value: original, configurable: true }),
  );

  it('reaps the whole group on a protocol violation, leaving no survivors', async () => {
    // The fixture writes the grandchild pid to a file on fd 5, mapped to the
    // child's fd 5 by the sandbox test seam. mkdtemp + exclusive create keep
    // the path unpredictable and unshared (CodeQL js/insecure-temporary-file).
    const pidDir = mkdtempSync(join(tmpdir(), 'rd-gc-'));
    const pidFile = join(pidDir, 'grandchild.pid');
    const fd5 = openSync(pidFile, 'wx+'); // read+write: the pid is read back via this fd

    const sb = new LandlockSandbox({
      helperPath: FAKE,
      probeEnv: { FAKE_PROBE_JSON: '{"available":true,"abi":3}' },
      extraStdioFd: fd5, // test seam: append a 6th stdio slot (fd 5) for the fixture
    });

    const options: SandboxOptions = {
      cwd: process.cwd(),
      repoRoot: process.cwd(),
      readOnlyPaths: [],
      readWritePaths: [],
      denyPaths: [],
      denyPatterns: [],
      env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
      allowUnsandboxed: true, // proves teardown happens even with strict:false
    };

    // The fixture hangs for 30s after emitting its bad status. Teardown must
    // fire off the fd-4 'end' event, so execute() resolves promptly — not after
    // the helper exits.
    const start = Date.now();
    const r = await sb.execute('irrelevant', options);
    const elapsedMs = Date.now() - start;
    expect(r.policyDenied).toBe(true);
    expect(elapsedMs).toBeLessThan(6000); // prompt: did not wait out the 30s hang

    // Read the pid back through the still-open descriptor (position 0) rather
    // than re-opening the path — no check-then-use window on the file
    // (CodeQL js/file-system-race).
    const buf = Buffer.alloc(64);
    const bytes = readSync(fd5, buf, 0, buf.length, 0);
    closeSync(fd5);
    const gcPid = Number(buf.subarray(0, bytes).toString('utf8').trim());
    expect(Number.isInteger(gcPid)).toBe(true);
    // Give SIGTERM/SIGKILL a moment to land.
    await new Promise((res) => setTimeout(res, 500));
    expect(isAlive(gcPid)).toBe(false);
    rmSync(pidDir, { recursive: true, force: true });
  }, 15000);

  it('confirms the reap when the helper already exited before teardown', async () => {
    // If the child's 'exit' event fired before terminateGroup attached its
    // listener, waiting on a future 'exit' would run out the reap window and
    // misreport an already-dead helper as a leak. Exercise the private method
    // directly with a child that is provably reaped.
    const sb = new LandlockSandbox({
      helperPath: UNKILLABLE,
      probeEnv: { FAKE_PROBE_JSON: '{"available":true,"abi":3}' },
      teardownReapMs: 200, // small: the pre-fix behavior resolves false at this timeout
    });
    const child = spawn(process.execPath, ['-e', ''], { detached: true });
    await new Promise((res) => child.once('exit', res));
    const reaped = await (
      sb as unknown as { terminateGroup(c: ChildProcess): Promise<boolean> }
    ).terminateGroup(child);
    expect(reaped).toBe(true);
  });

  it('fails closed and surfaces an unconfirmed reap when teardown times out', async () => {
    // The helper ignores SIGTERM; with a tiny teardownReapMs and a long grace,
    // terminateGroup cannot confirm a reap → resolves false → still fails closed.
    const sb = new LandlockSandbox({
      helperPath: UNKILLABLE,
      probeEnv: { FAKE_PROBE_JSON: '{"available":true,"abi":3}' },
      teardownReapMs: 100,
      teardownGraceMs: 10000, // SIGKILL not sent before the reap window elapses
    });
    const r = await sb.execute('irrelevant', teardownBase);
    expect(r.policyDenied).toBe(true);
    expect(r.sandboxed).toBe(false);
    expect(r.success).toBe(false);
    expect(r.denialReason).toContain('teardown did NOT confirm reap');
  }, 15000);
});
