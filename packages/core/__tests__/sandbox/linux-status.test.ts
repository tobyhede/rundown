import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { fileURLToPath } from 'node:url';
import { chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { LandlockSandbox } from '../../src/sandbox/linux.js';
import type { SandboxOptions } from '../../src/sandbox/types.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-helper.mjs', import.meta.url));
chmodSync(FAKE, 0o755);

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
  allowUnsandboxed: false,
};

function sb() {
  return new LandlockSandbox({
    helperPath: FAKE,
    probeEnv: { FAKE_PROBE_JSON: '{"available":true,"abi":3}' },
  });
}

describe('LandlockSandbox.execute status handling', () => {
  const original = process.platform;
  beforeEach(
    () => void Object.defineProperty(process, 'platform', { value: 'linux', configurable: true }),
  );
  afterEach(
    () => void Object.defineProperty(process, 'platform', { value: original, configurable: true }),
  );

  it('denied status → policyDenied with ABI-gap reason', async () => {
    const r = await sb().execute('cat /secret', {
      ...base,
      env: {
        ...base.env,
        FAKE_STATUS_LINE: '{"status":"denied","abi":2,"missing":"TRUNCATE"}',
        FAKE_EXIT: '126',
      },
    });
    expect(r.policyDenied).toBe(true);
    expect(r.sandboxed).toBe(false);
    expect(r.denialReason).toContain('TRUNCATE');
    expect(r.denialReason).toContain('sandboxStrict');
  });

  it('error status fails closed even with allowUnsandboxed (strict:false)', async () => {
    const r = await sb().execute('echo hi', {
      ...base,
      allowUnsandboxed: true,
      env: {
        ...base.env,
        FAKE_STATUS_LINE: '{"status":"error","message":"boom"}',
        FAKE_EXIT: '1',
      },
    });
    expect(r.policyDenied).toBe(true);
    expect(r.sandboxed).toBe(false);
    expect(r.success).toBe(false);
  });

  it('missing status (protocol violation) fails closed', async () => {
    const r = await sb().execute('echo hi', {
      ...base,
      allowUnsandboxed: true,
      env: { ...base.env, FAKE_NO_STATUS: '1', FAKE_EXIT: '0' },
    });
    expect(r.policyDenied).toBe(true);
    expect(r.sandboxed).toBe(false);
  });
});
