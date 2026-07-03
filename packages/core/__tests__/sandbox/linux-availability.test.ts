import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { fileURLToPath } from 'node:url';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LandlockSandbox } from '../../src/sandbox/linux.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-helper.mjs', import.meta.url));
chmodSync(FAKE, 0o755);

describe('LandlockSandbox.getAvailability (--probe)', () => {
  const original = process.platform;
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  });

  it('reports available and surfaces the ABI when the probe says so', async () => {
    const sandbox = new LandlockSandbox({
      helperPath: FAKE,
      probeEnv: { FAKE_PROBE_JSON: '{"available":true,"abi":4}' },
    });
    const a = await sandbox.getAvailability();
    expect(a.available).toBe(true);
    expect(a.mechanism).toBe('landlock');
    expect(a.landlockAbi).toBe(4);
    expect(a.supportsDenyPaths).toBe(false);
  });

  it('reports unavailable when the probe says available:false', async () => {
    const sandbox = new LandlockSandbox({
      helperPath: FAKE,
      probeEnv: { FAKE_PROBE_JSON: '{"available":false,"abi":0}' },
    });
    const a = await sandbox.getAvailability();
    expect(a.available).toBe(false);
    expect(a.mechanism).toBe('none');
  });

  it('reports unavailable when available:true omits a valid positive ABI', async () => {
    const sandbox = new LandlockSandbox({
      helperPath: FAKE,
      probeEnv: { FAKE_PROBE_JSON: '{"available":true}' },
    });
    const a = await sandbox.getAvailability();
    expect(a.available).toBe(false);
    expect(a.reason).toContain('malformed');
  });

  it('resolves to unavailable (does not throw) when the probe prints JSON null', async () => {
    const sandbox = new LandlockSandbox({
      helperPath: FAKE,
      probeEnv: { FAKE_PROBE_JSON: 'null' },
    });
    const a = await sandbox.getAvailability();
    expect(a.available).toBe(false);
    expect(a.reason).toContain('malformed');
  });

  it('reports unavailable when the probe prints a non-object JSON primitive', async () => {
    const sandbox = new LandlockSandbox({
      helperPath: FAKE,
      probeEnv: { FAKE_PROBE_JSON: '42' },
    });
    const a = await sandbox.getAvailability();
    expect(a.available).toBe(false);
    expect(a.reason).toContain('malformed');
  });

  it('reports unavailable (does not throw) when the probe exits non-zero', async () => {
    const sandbox = new LandlockSandbox({
      helperPath: FAKE,
      // Valid JSON on stdout must NOT rescue a failed probe process.
      probeEnv: { FAKE_PROBE_JSON: '{"available":true,"abi":4}', FAKE_PROBE_EXIT: '1' },
    });
    const a = await sandbox.getAvailability();
    expect(a.available).toBe(false);
    expect(a.mechanism).toBe('none');
    expect(a.reason).toContain('failed to run');
  });

  it('reports unavailable (does not throw) when the probe fails to spawn', async () => {
    // An existing but non-executable helper passes the existsSync preflight
    // and then fails at spawn time (EACCES) — the spawn-error branch.
    const dir = mkdtempSync(join(tmpdir(), 'rd-noexec-'));
    const notExecutable = join(dir, 'rd-landlock');
    writeFileSync(notExecutable, '#!/bin/sh\ntrue\n', { mode: 0o644 });
    const sandbox = new LandlockSandbox({ helperPath: notExecutable });
    const a = await sandbox.getAvailability();
    expect(a.available).toBe(false);
    expect(a.mechanism).toBe('none');
    expect(a.reason).toContain('failed to run');
  });

  it('reports unavailable for an unsupported arch (no helper resolved)', async () => {
    const sandbox = new LandlockSandbox({ helperPath: null });
    const a = await sandbox.getAvailability();
    expect(a.available).toBe(false);
    expect(a.reason).toContain('unsupported');
  });

  it('memoizes availability', async () => {
    const sandbox = new LandlockSandbox({
      helperPath: FAKE,
      probeEnv: { FAKE_PROBE_JSON: '{"available":true,"abi":3}' },
    });
    const first = await sandbox.getAvailability();
    const second = await sandbox.getAvailability();
    expect(second).toBe(first);
  });
});
