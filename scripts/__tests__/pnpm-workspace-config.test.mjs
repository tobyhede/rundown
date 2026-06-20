import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Read a repository-relative file as UTF-8 text.
 *
 * @param path - repository-relative path
 * @returns the file contents
 */
async function readRepoFile(path) {
  return readFile(join(repoRoot, path), 'utf-8');
}

/**
 * Extract a top-level block of indented `key: value` entries from a
 * pnpm-workspace.yaml-style document. Returns the entries under `blockName:`
 * (a `key:` line followed by more-indented lines), stopping at the next
 * column-0 key or blank-line-then-column-0-key boundary.
 *
 * The whole point of this test is to pin a small, security-sensitive set of
 * keys, so a deliberately minimal parser (no YAML dependency in the strict
 * pnpm layout) is sufficient and keeps the guard self-contained.
 *
 * @param yaml - the full pnpm-workspace.yaml text
 * @param blockName - the top-level key whose child map to extract
 * @returns a map of child key -> raw (unquoted) value string
 */
function extractBlock(yaml, blockName) {
  const lines = yaml.split('\n');
  const start = lines.indexOf(`${blockName}:`);
  assert.notEqual(start, -1, `expected a top-level "${blockName}:" block in pnpm-workspace.yaml`);

  const entries = {};
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    // A column-0 non-space character ends the block (next top-level key).
    if (!/^\s/.test(line)) break;
    const match = line.match(/^\s+("?)([^":]+)\1\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[2].trim();
    const value = match[3].trim().replace(/^"(.*)"$/, '$1');
    entries[key] = value;
  }
  return entries;
}

// The intended supply-chain allowlist. pnpm 11 hard-fails an unreviewed
// dependency build script (strictDepBuilds); only these three may run theirs.
// Editing this set is a security decision and must be made deliberately here.
const EXPECTED_ALLOW_BUILDS = {
  esbuild: 'true',
  sharp: 'true',
  'unrs-resolver': 'true',
};

// The intended security override pins (CVE patches). A dropped or downgraded
// entry silently un-patches a CVE, so the set is asserted both ways.
const EXPECTED_OVERRIDES = {
  lodash: '^4.17.23',
  flatted: '^3.4.0',
  devalue: '^5.8.1',
  'brace-expansion': '^5.0.6',
  qs: '^6.15.2',
  '@modelcontextprotocol/sdk>hono': '^4.12.21',
  '@modelcontextprotocol/sdk>@hono/node-server': '^1.19.13',
  '@modelcontextprotocol/sdk>express-rate-limit': '^8.5.2',
  '@hono/node-server>hono': '^4.12.21',
  'express-rate-limit>ip-address': '^10.1.1',
  'astro>esbuild': '^0.28.1',
  'astro>svgo': '^4.0.1',
  'vite>esbuild': '^0.28.1',
  'vite>postcss': '^8.5.10',
  'tsx>esbuild': '^0.28.1',
  'yaml-language-server>yaml': '^2.8.3',
  'test-exclude>minimatch': '^3.1.3',
  'gray-matter>js-yaml': '^4.2.0',
  'read-yaml-file>js-yaml': '^4.2.0',
  '@istanbuljs/load-nyc-config>js-yaml': '^4.2.0',
};

// Security patches that swap js-yaml 3.x safeLoad/safeDump (GHSA-h67p-54hq-rp68)
// for the 4.x load/dump equivalents. Dropping a patch silently re-exposes the DoS.
const EXPECTED_PATCHES = {
  'gray-matter@4.0.3': 'patches/gray-matter@4.0.3.patch',
  'read-yaml-file@1.1.0': 'patches/read-yaml-file@1.1.0.patch',
};

test('pnpm-workspace.yaml allowBuilds is exactly the reviewed supply-chain allowlist', async () => {
  const yaml = await readRepoFile('pnpm-workspace.yaml');
  const allowBuilds = extractBlock(yaml, 'allowBuilds');
  // Set-equality both ways: an extra key means an unreviewed build script was
  // approved (supply-chain risk); a missing key means a needed build broke.
  assert.deepEqual(
    allowBuilds,
    EXPECTED_ALLOW_BUILDS,
    'allowBuilds drifted — approving a new package build script is a security decision; update EXPECTED_ALLOW_BUILDS deliberately',
  );
});

test('pnpm-workspace.yaml overrides match the security CVE manifest exactly', async () => {
  const yaml = await readRepoFile('pnpm-workspace.yaml');
  const overrides = extractBlock(yaml, 'overrides');
  assert.deepEqual(
    overrides,
    EXPECTED_OVERRIDES,
    'overrides drifted from the CVE manifest — a dropped/downgraded pin un-patches a CVE',
  );
});

test('pnpm-workspace.yaml patchedDependencies match the security-patch manifest', async () => {
  const yaml = await readRepoFile('pnpm-workspace.yaml');
  const patches = extractBlock(yaml, 'patchedDependencies');
  assert.deepEqual(
    patches,
    EXPECTED_PATCHES,
    'patchedDependencies drifted — dropping the gray-matter/read-yaml-file js-yaml patch re-exposes GHSA-h67p-54hq-rp68',
  );
  // The .patch files themselves must exist and stay applied.
  for (const file of Object.values(EXPECTED_PATCHES)) {
    await readRepoFile(file);
  }
});

test('pnpm-workspace.yaml carries the pnpm settings that .npmrc no longer can', async () => {
  const yaml = await readRepoFile('pnpm-workspace.yaml');
  // pnpm 11 reads only auth/registry settings from .npmrc; these must live here.
  assert.match(
    yaml,
    /^nodeOptions:\s*--experimental-vm-modules\s*$/m,
    'missing nodeOptions (Jest ESM)',
  );
  assert.match(yaml, /^linkWorkspacePackages:\s*true\s*$/m, 'missing linkWorkspacePackages');
  assert.match(yaml, /^preferWorkspacePackages:\s*true\s*$/m, 'missing preferWorkspacePackages');
  assert.match(yaml, /^autoInstallPeers:\s*true\s*$/m, 'missing autoInstallPeers');
});

test('.npmrc stays auth-only and never relaxes the strict pnpm layout', async () => {
  const npmrc = await readRepoFile('.npmrc');
  // Assert on ACTIVE settings only — the explanatory comments legitimately name
  // these forbidden settings to document why they must not be enabled.
  const active = npmrc
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));

  for (const line of active) {
    const key = line.split('=')[0].trim().toLowerCase();
    // The strict isolated layout is the whole point of the migration; relaxing
    // it throws away the correctness and disk benefits.
    assert.notEqual(key, 'shamefully-hoist', '.npmrc must not enable shamefully-hoist');
    assert.notEqual(key, 'node-linker', '.npmrc must not set node-linker (hoisted)');
    // pnpm 11 silently ignores these in .npmrc — keeping them out prevents the
    // illusion that they apply (they belong in pnpm-workspace.yaml).
    assert.ok(
      ![
        'node-options',
        'link-workspace-packages',
        'prefer-workspace-packages',
        'auto-install-peers',
      ].includes(key),
      `.npmrc sets "${key}", which pnpm 11 ignores — move it to pnpm-workspace.yaml`,
    );
  }
});

test('root package.json carries no pnpm-11-dead config keys', async () => {
  const pkg = JSON.parse(await readRepoFile('package.json'));
  // pnpm 11 ignores both of these in package.json; their presence would be a
  // silently-dead config and (for overrides) a silent security-pin failure.
  assert.equal(
    pkg.pnpm,
    undefined,
    'remove the dead "pnpm" field — config lives in pnpm-workspace.yaml',
  );
  assert.equal(
    pkg.overrides,
    undefined,
    'remove the dead "overrides" field — pins live in pnpm-workspace.yaml',
  );
});

test('CLI Jest config wires the live-cwd environment', async () => {
  // The CLI normal/Stryker configs are generated from a single
  // `jest.config.shared.js` factory, so pin the resolved value rather than the
  // entry file's text — the entry file is now a one-line `makeConfig` call.
  const { makeConfig } = await import(join(repoRoot, 'packages/cli/jest.config.shared.js'));
  // The live-cwd environment (jest.live-cwd-environment.cjs) is retained as
  // defensive insurance: the graceful-fs/process.cwd bug reproduced under pnpm
  // 10.x (29 RUNBOOK_NOT_FOUND failures) and no longer reproduces at 11.7, but
  // CI runs on Linux and the interaction is realm/layout-sensitive. This pins
  // the wiring so it is not dropped silently; a behavioural guard is impossible
  // while the bug does not reproduce.
  assert.equal(
    makeConfig({ sandboxed: false }).testEnvironment,
    '<rootDir>/jest.live-cwd-environment.cjs',
    'CLI normal Jest config must use the live-cwd Jest environment',
  );
});

test('CLI jest.config.js entrypoint resolves to the live-cwd environment', async () => {
  // Pinning makeConfig alone leaves a gap: the entry file could call
  // makeConfig({ sandboxed: true }) (or stop calling it) and the factory test
  // would still pass. Assert the resolved default export of the real entrypoint
  // so the non-sandbox wiring is guarded end-to-end, not just at the factory.
  const { default: config } = await import(join(repoRoot, 'packages/cli/jest.config.js'));
  assert.equal(
    config.testEnvironment,
    '<rootDir>/jest.live-cwd-environment.cjs',
    'packages/cli/jest.config.js must export the non-sandbox (live-cwd) config',
  );
});
