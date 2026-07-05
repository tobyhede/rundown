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
  network: 'deny',
  allowUnsandboxed: false,
};

function optionsWithStatus(
  network: 'deny' | 'allow',
  statusLine: string,
  allowUnsandboxed: boolean = false,
): SandboxOptions {
  return {
    cwd: base.cwd,
    repoRoot: base.repoRoot,
    readOnlyPaths: base.readOnlyPaths,
    readWritePaths: base.readWritePaths,
    denyPaths: base.denyPaths,
    denyPatterns: base.denyPatterns,
    env: {
      PATH: base.env.PATH,
      FAKE_STATUS_LINE: statusLine,
      FAKE_EXIT: '0',
    },
    allowUnsandboxed,
    network,
  };
}

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

  it('applied deny status carries network posture', async () => {
    const r = await sb().execute(
      'echo hi',
      optionsWithStatus('deny', '{"status":"applied","abi":3,"downgraded":false,"network":"deny"}'),
    );

    expect(r.policyDenied).toBe(false);
    expect(r.networkPolicy).toBe('deny');
    expect(r.networkSandboxed).toBe(true);
  });

  it('applied allow status reports network unsandboxed', async () => {
    const r = await sb().execute(
      'echo hi',
      optionsWithStatus(
        'allow',
        '{"status":"applied","abi":3,"downgraded":false,"network":"allow"}',
      ),
    );

    expect(r.policyDenied).toBe(false);
    expect(r.networkPolicy).toBe('allow');
    expect(r.networkSandboxed).toBe(false);
  });

  it('applied status that weakens requested network denial fails closed', async () => {
    const r = await sb().execute(
      'echo hi',
      optionsWithStatus(
        'deny',
        '{"status":"applied","abi":3,"downgraded":false,"network":"allow"}',
        true,
      ),
    );

    expect(r.policyDenied).toBe(true);
    expect(r.sandboxed).toBe(false);
    expect(r.denialReason).toContain('network policy mismatch');
    expect(r.networkPolicy).toBe('deny');
    expect(r.networkSandboxed).toBe(false);
  });

  it('missing network on applied status fails closed', async () => {
    const r = await sb().execute(
      'echo hi',
      optionsWithStatus('deny', '{"status":"applied","abi":3,"downgraded":false}', true),
    );

    expect(r.policyDenied).toBe(true);
    expect(r.sandboxed).toBe(false);
    expect(r.networkPolicy).toBe('deny');
    expect(r.networkSandboxed).toBe(false);
  });

  it('wrong network value on applied status fails closed', async () => {
    const r = await sb().execute(
      'echo hi',
      optionsWithStatus(
        'deny',
        '{"status":"applied","abi":3,"downgraded":false,"network":"maybe"}',
        true,
      ),
    );

    expect(r.policyDenied).toBe(true);
    expect(r.sandboxed).toBe(false);
    expect(r.networkPolicy).toBe('deny');
    expect(r.networkSandboxed).toBe(false);
  });

  it('fractional ABI on applied status fails closed', async () => {
    const r = await sb().execute(
      'echo hi',
      optionsWithStatus(
        'deny',
        '{"status":"applied","abi":1.5,"downgraded":false,"network":"deny"}',
        true,
      ),
    );

    expect(r.policyDenied).toBe(true);
    expect(r.sandboxed).toBe(false);
  });

  it('fractional ABI on denied status fails closed', async () => {
    const r = await sb().execute(
      'cat /secret',
      optionsWithStatus('deny', '{"status":"denied","abi":1.5,"missing":"TRUNCATE"}', true),
    );

    expect(r.policyDenied).toBe(true);
    expect(r.sandboxed).toBe(false);
    expect(r.denialReason).toContain('protocol violation');
  });

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
