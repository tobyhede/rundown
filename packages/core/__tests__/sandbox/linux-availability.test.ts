import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { fileURLToPath } from 'node:url';
import { chmodSync } from 'node:fs';
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
