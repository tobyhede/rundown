import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { fileURLToPath } from 'node:url';
import { chmodSync } from 'node:fs';
import { LandlockSandbox } from '../../src/sandbox/linux.js';
import type { SandboxOptions } from '../../src/sandbox/types.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-helper.mjs', import.meta.url));
chmodSync(FAKE, 0o755);

const base: SandboxOptions = {
  cwd: '/tmp',
  repoRoot: '/tmp',
  readOnlyPaths: [],
  readWritePaths: [],
  denyPaths: [],
  denyPatterns: [],
  env: {},
  allowUnsandboxed: false,
};

describe('LandlockSandbox.execute deny-path preflight', () => {
  const original = process.platform;
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  });

  it('blocks denyPaths with exit 126 before spawning the helper', async () => {
    const sandbox = new LandlockSandbox({
      helperPath: FAKE,
      probeEnv: { FAKE_PROBE_JSON: '{"available":true,"abi":3}' },
    });
    const r = await sandbox.execute('echo hi', { ...base, denyPaths: ['/secret'] });
    expect(r.exitCode).toBe(126);
    expect(r.policyDenied).toBe(true);
    expect(r.sandboxed).toBe(false);
    expect(r.success).toBe(false);
  });

  it('blocks denyPatterns with exit 126', async () => {
    const sandbox = new LandlockSandbox({
      helperPath: FAKE,
      probeEnv: { FAKE_PROBE_JSON: '{"available":true,"abi":3}' },
    });
    const r = await sandbox.execute('echo hi', { ...base, denyPatterns: ['*.secret'] });
    expect(r.exitCode).toBe(126);
    expect(r.policyDenied).toBe(true);
    expect(r.sandboxed).toBe(false);
  });
});
