import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { fileURLToPath } from 'node:url';
import { chmodSync } from 'node:fs';
import { LandlockSandbox } from '../../src/sandbox/linux.js';
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
  env: { PATH: '/usr/bin:/bin' },
  allowUnsandboxed: false,
};

function sandbox(statusLine: string, exit = 0) {
  return new LandlockSandbox({
    helperPath: FAKE,
    probeEnv: { FAKE_PROBE_JSON: '{"available":true,"abi":3}' },
    // execute env is set per-run via the fake helper's own env below.
  });
}

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
        FAKE_STATUS_LINE: '{"status":"applied","abi":3,"downgraded":false}',
        FAKE_EXIT: '0',
      },
    });
    expect(r.sandboxed).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.success).toBe(true);
    expect(r.landlockAbi).toBe(3);
    expect(r.enforcementDowngraded).toBe(false);
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
        FAKE_STATUS_LINE: '{"status":"applied","abi":3,"downgraded":false}',
        FAKE_EXIT: '125',
      },
    });
    expect(r.sandboxed).toBe(true);
    expect(r.exitCode).toBe(125);
    expect(r.success).toBe(false);
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
});
