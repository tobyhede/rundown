import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { LandlockSandbox, type LandlockSandboxOptions } from '../../src/sandbox/linux.js';
import type { SandboxOptions } from '../../src/sandbox/types.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-helper.mjs', import.meta.url));
const SLOW = fileURLToPath(new URL('./fixtures/fake-helper-slow.mjs', import.meta.url));
chmodSync(FAKE, 0o755);
chmodSync(SLOW, 0o755);

const base: SandboxOptions = {
  cwd: process.cwd(),
  repoRoot: process.cwd(),
  readOnlyPaths: [],
  readWritePaths: [],
  denyPaths: [],
  denyPatterns: [],
  // The fixtures use `#!/usr/bin/env node` shebangs. This PATH is otherwise
  // minimal (to exercise buildEnhancedPathFromEnv), but must include the
  // running node's own directory so the shebang resolves regardless of how
  // node was installed (mise, nvm, CI tool-cache, etc. — not necessarily
  // /usr/bin or /bin).
  env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
  network: 'deny',
  allowUnsandboxed: false,
};

describe('LandlockSandbox.execute applied path', () => {
  const original = process.platform;
  beforeEach(
    () => void Object.defineProperty(process, 'platform', { value: 'linux', configurable: true }),
  );
  afterEach(
    () => void Object.defineProperty(process, 'platform', { value: original, configurable: true }),
  );

  it('applied status → sandboxed:true and surfaces the ABI', async () => {
    const sb = new LandlockSandbox({
      helperPath: FAKE,
      probeEnv: { FAKE_PROBE_JSON: '{"available":true,"abi":3}' },
    });
    const r = await sb.execute('echo hi', {
      ...base,
      env: {
        ...base.env,
        FAKE_STATUS_LINE: '{"status":"applied","abi":3,"downgraded":false,"network":"deny"}',
        FAKE_EXIT: '0',
      },
    });
    expect(r.sandboxed).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.success).toBe(true);
    expect(r.landlockAbi).toBe(3);
    expect(r.enforcementDowngraded).toBe(false);
    expect(r.networkPolicy).toBe('deny');
    expect(r.networkSandboxed).toBe(true);
    expect(r.policyDenied).toBe(false);
  });

  it('applied status with downgraded:true surfaces enforcementDowngraded', async () => {
    const sb = new LandlockSandbox({
      helperPath: FAKE,
      probeEnv: { FAKE_PROBE_JSON: '{"available":true,"abi":1}' },
    });
    const r = await sb.execute('echo hi', {
      ...base,
      env: {
        ...base.env,
        FAKE_STATUS_LINE: '{"status":"applied","abi":1,"downgraded":true,"network":"deny"}',
        FAKE_EXIT: '0',
      },
    });
    expect(r.enforcementDowngraded).toBe(true);
    expect(r.sandboxed).toBe(true);
    expect(r.landlockAbi).toBe(1);
    expect(r.networkPolicy).toBe('deny');
    expect(r.networkSandboxed).toBe(true);
    expect(r.policyDenied).toBe(false);
  });

  it('non-zero command exit under applied is NOT a policy denial', async () => {
    const sb = new LandlockSandbox({
      helperPath: FAKE,
      probeEnv: { FAKE_PROBE_JSON: '{"available":true,"abi":3}' },
    });
    const r = await sb.execute('exit 125', {
      ...base,
      env: {
        ...base.env,
        FAKE_STATUS_LINE: '{"status":"applied","abi":3,"downgraded":false,"network":"deny"}',
        FAKE_EXIT: '125',
      },
    });
    expect(r.sandboxed).toBe(true);
    expect(r.exitCode).toBe(125);
    expect(r.success).toBe(false);
    expect(r.networkPolicy).toBe('deny');
    expect(r.networkSandboxed).toBe(true);
    expect(r.policyDenied).toBe(false);
  });

  it('rejects a schema-incomplete applied status (missing abi) as a violation', async () => {
    const sb = new LandlockSandbox({
      helperPath: FAKE,
      probeEnv: { FAKE_PROBE_JSON: '{"available":true,"abi":3}' },
    });
    const r = await sb.execute('echo hi', {
      ...base,
      allowUnsandboxed: true, // fails closed even with strict:false
      env: { ...base.env, FAKE_STATUS_LINE: '{"status":"applied"}', FAKE_EXIT: '0' },
    });
    expect(r.policyDenied).toBe(true);
    expect(r.sandboxed).toBe(false);
  });

  it('rejects an applied status with a wrong-typed abi as a violation', async () => {
    const sb = new LandlockSandbox({
      helperPath: FAKE,
      probeEnv: { FAKE_PROBE_JSON: '{"available":true,"abi":3}' },
    });
    const r = await sb.execute('echo hi', {
      ...base,
      allowUnsandboxed: true,
      env: {
        ...base.env,
        FAKE_STATUS_LINE: '{"status":"applied","abi":"3","downgraded":false}',
        FAKE_EXIT: '0',
      },
    });
    expect(r.policyDenied).toBe(true);
    expect(r.sandboxed).toBe(false);
  });

  it('fails closed on an oversized fd-4 status without waiting for the timeout', async () => {
    const sb = new LandlockSandbox({
      helperPath: SLOW,
      probeEnv: { FAKE_PROBE_JSON: '{"available":true,"abi":3}' },
      statusTimeoutMs: 10000, // long — the buffer cap must fire first
    });
    const start = Date.now();
    const r = await sb.execute('x', {
      ...base,
      allowUnsandboxed: true,
      env: { ...base.env, FAKE_MODE: 'oversize' },
    });
    expect(r.policyDenied).toBe(true);
    expect(r.sandboxed).toBe(false);
    expect(Date.now() - start).toBeLessThan(5000); // cap fired, not the 10s timeout
  }, 15000);

  it('fails closed when no status arrives within the startup timeout', async () => {
    const sb = new LandlockSandbox({
      helperPath: SLOW,
      probeEnv: { FAKE_PROBE_JSON: '{"available":true,"abi":3}' },
      statusTimeoutMs: 300, // short so the test is fast
    });
    const r = await sb.execute('x', {
      ...base,
      allowUnsandboxed: true,
      env: { ...base.env, FAKE_MODE: 'silent' },
    });
    expect(r.policyDenied).toBe(true);
    expect(r.sandboxed).toBe(false);
  }, 10000);

  it('settles a violation without an unhandled pipe error while the spec write is in flight', async () => {
    const sb = new LandlockSandbox({
      helperPath: SLOW,
      probeEnv: { FAKE_PROBE_JSON: '{"available":true,"abi":3}' },
      statusTimeoutMs: 300,
    });
    // Inflate the fd-3 spec far past the kernel pipe buffer so the spec write
    // is still pending when the violation teardown SIGKILLs the helper's
    // group. Killing a peer with unread pipe data makes the parent-side fd-3/
    // fd-4 streams emit 'error' (EPIPE/ECONNRESET); without listeners that is
    // an uncaught exception that crashes the Jest worker.
    const r = await sb.execute('x', {
      ...base,
      allowUnsandboxed: true,
      readOnlyPaths: Array.from({ length: 30000 }, () => '/usr'),
      env: { ...base.env, FAKE_MODE: 'silent' },
    });
    expect(r.policyDenied).toBe(true);
    expect(r.sandboxed).toBe(false);
    // Let any late pipe 'error' surface before the test ends.
    await new Promise((res) => setTimeout(res, 250));
  }, 10000);

  it('uses fd 1 and fd 2 pipes for stderr command output while preserving fd 3 and fd 4 protocol pipes', async () => {
    let capturedStdio: unknown;
    const child = new EventEmitter() as EventEmitter & {
      stdio: Array<unknown>;
      unref: jest.Mock;
    };
    child.stdio = [
      null,
      Object.assign(new EventEmitter(), { destroy: jest.fn() }),
      Object.assign(new EventEmitter(), { destroy: jest.fn() }),
      Object.assign(new EventEmitter(), { write: jest.fn(), end: jest.fn(), destroy: jest.fn() }),
      Object.assign(new EventEmitter(), { setEncoding: jest.fn(), destroy: jest.fn() }),
    ];
    child.unref = jest.fn();

    const spawnMock = jest.fn((_command: string, _args: string[], options: SpawnOptions) => {
      capturedStdio = options.stdio;
      process.nextTick(() => {
        (child.stdio[4] as EventEmitter).emit(
          'data',
          '{"status":"applied","abi":3,"downgraded":false,"network":"deny"}\n',
        );
        child.emit('close', 0);
      });
      return child as unknown as ChildProcess;
    });

    const sandbox = new LandlockSandbox({
      helperPath: FAKE,
      probeEnv: { FAKE_PROBE_JSON: '{"available":true,"abi":3}' },
      spawn: spawnMock as unknown as LandlockSandboxOptions['spawn'],
    });

    const result = await sandbox.execute('printf linux-out', {
      ...base,
      commandOutput: 'stderr',
    });

    expect(result.success).toBe(true);
    expect(capturedStdio).toEqual(['inherit', 'pipe', 'pipe', 'pipe', 'pipe']);
  });
});
