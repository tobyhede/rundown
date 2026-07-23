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

// Security overrides are justified in override-policy.json (the single source of
// truth), not a static manifest here. The gate below enforces a 1:1 mapping between
// the overrides block and that file, so an override cannot be added or removed
// without a dated, CVE-annotated entry.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_OVERRIDE_CATEGORIES = new Set(['A', 'B']);

/**
 * Load the override justification manifest.
 *
 * @returns the `overrides` map from override-policy.json
 */
async function readOverridePolicy() {
  return JSON.parse(await readRepoFile('override-policy.json')).overrides;
}

// Every workspace package.json plus the root — the set whose directly-declared
// dependency floors a blanket override must never resolve below.
const WORKSPACE_MANIFEST_PATHS = [
  'package.json',
  'site/package.json',
  'packages/cli/package.json',
  'packages/core/package.json',
  'packages/parser/package.json',
  'packages/mcp/package.json',
  'packages/claude-code-plugin/package.json',
];

/**
 * Extract the [major, minor, patch] floor of a semver range like `^1.10.0`,
 * `~1.9.0`, `>=1.2.3`, or a bare `1.2.3`.
 *
 * @param range - a semver range string
 * @returns the floor triple, or null when no `x.y.z` is present
 */
function semverFloor(range) {
  const m = range.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Compare two [major, minor, patch] triples.
 *
 * @param a - left triple
 * @param b - right triple
 * @returns negative when a < b, 0 when equal, positive when a > b
 */
function cmpSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Extract the package name from a blanket override key, stripping any trailing
 * `@<version-selector>` (e.g. `brace-expansion@5` -> `brace-expansion`) while
 * preserving a scoped package's leading `@` (e.g. `@babel/core`).
 *
 * @param key - a blanket (no `>`) override key
 * @returns the bare package name
 */
function blanketOverrideName(key) {
  const at = key.lastIndexOf('@');
  return at > 0 ? key.slice(0, at) : key;
}

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

test('every pnpm override is justified in override-policy.json (1:1) and pins the recorded version', async () => {
  const yaml = await readRepoFile('pnpm-workspace.yaml');
  const overrides = extractBlock(yaml, 'overrides');
  const policy = await readOverridePolicy();

  // Set-equality both ways is the gate: a new override with no policy entry fails
  // here, and so does a stale policy entry whose override was dropped. This is what
  // stops an override being added without a dated, CVE-annotated justification.
  assert.deepEqual(
    Object.keys(overrides).sort(),
    Object.keys(policy).sort(),
    'overrides <-> override-policy.json drift: every pin needs a dated CVE justification and vice-versa',
  );

  // The policy records the exact pin, so a silently downgraded override (which can
  // un-patch a CVE) fails against its own justification.
  for (const [key, value] of Object.entries(overrides)) {
    assert.equal(
      value,
      policy[key].override,
      `override "${key}" pins ${value} but override-policy.json records ${policy[key].override}`,
    );
  }
});

test('override-policy.json entries carry a category, GHSA list, reason, and review date', async () => {
  const policy = await readOverridePolicy();
  for (const [key, entry] of Object.entries(policy)) {
    assert.ok(
      VALID_OVERRIDE_CATEGORIES.has(entry.category),
      `override "${key}": category must be "A" (parent forbids fix) or "B" (in-range, override is the bump lever)`,
    );
    assert.ok(
      Array.isArray(entry.ghsa) &&
        entry.ghsa.length > 0 &&
        entry.ghsa.every((g) => /^GHSA-/.test(g)),
      `override "${key}": needs a non-empty ghsa list of GHSA-… ids`,
    );
    assert.ok(
      typeof entry.reason === 'string' && entry.reason.trim().length >= 20,
      `override "${key}": needs a substantive reason`,
    );
    assert.match(
      entry.added,
      ISO_DATE,
      `override "${key}": "added" must be an ISO date (YYYY-MM-DD)`,
    );
    assert.match(
      entry.reviewBy,
      ISO_DATE,
      `override "${key}": "reviewBy" must be an ISO date (YYYY-MM-DD)`,
    );
    assert.ok(entry.reviewBy > entry.added, `override "${key}": "reviewBy" must be after "added"`);
  }
});

test('no blanket override downgrades a directly-declared workspace dependency', async () => {
  // A bare (non-scoped) override REPLACES a package's declared version spec. If a
  // workspace package declares the same dependency at a higher floor, the override
  // silently downgrades it — discarding fixes and (for a security pin) potentially
  // resolving BELOW the patched version. Scoped `parent>child` overrides cannot do
  // this (they only touch the child inside parent's subtree), so only bare keys are
  // checked. Regression guard for the shell-quote ^1.9.0 downgrade of cli/core's
  // declared ^1.10.0.
  const policy = await readOverridePolicy();

  const declared = new Map(); // name -> [{ pkg, range }]
  for (const path of WORKSPACE_MANIFEST_PATHS) {
    const pkg = JSON.parse(await readRepoFile(path));
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, range] of Object.entries(pkg[field] ?? {})) {
        const list = declared.get(name) ?? [];
        list.push({ pkg: path, range });
        declared.set(name, list);
      }
    }
  }

  const violations = [];
  for (const [key, entry] of Object.entries(policy)) {
    if (key.includes('>')) continue; // scoped: cannot touch a package's own direct dep
    const name = blanketOverrideName(key);
    const overrideFloor = semverFloor(entry.override);
    if (!overrideFloor) continue;
    for (const { pkg, range } of declared.get(name) ?? []) {
      const declaredFloor = semverFloor(range);
      if (declaredFloor && cmpSemver(overrideFloor, declaredFloor) < 0) {
        violations.push(
          `override "${key}" (${entry.override}) downgrades ${pkg}'s "${name}": "${range}" — scope the override to the vulnerable consumer or raise its floor`,
        );
      }
    }
  }
  assert.deepEqual(violations, [], violations.join('\n'));
});

test('.osv-scanner.toml exists and the OSV workflow wires it via --config', async () => {
  // The OSV job is blocking and passes `--config=.osv-scanner.toml`; if the file is
  // missing from the tree the scanner errors while loading config and the gate
  // hard-fails. Guards the P1 "config not in the patch" foot-gun.
  const toml = await readRepoFile('.osv-scanner.toml');
  assert.ok(toml.includes('[[IgnoredVulns]]'), '.osv-scanner.toml must contain the ignore table');
  const workflow = await readRepoFile('.github/workflows/osv-scanner.yml');
  assert.match(
    workflow,
    /--config=\.osv-scanner\.toml/,
    'osv-scanner.yml must pass --config=.osv-scanner.toml',
  );
});

test('no per-package package.json carries a pnpm-11-dead overrides/pnpm block', async () => {
  // pnpm 11 reads overrides ONLY from pnpm-workspace.yaml. A per-package block is
  // silently ignored, so it is dead config that misleads readers into thinking a
  // pin is in effect. These two files historically mirrored the workspace pins.
  for (const path of ['packages/mcp/package.json', 'site/package.json']) {
    const pkg = JSON.parse(await readRepoFile(path));
    assert.equal(
      pkg.overrides,
      undefined,
      `${path}: remove the dead "overrides" field — pins live only in pnpm-workspace.yaml`,
    );
    assert.equal(
      pkg.pnpm,
      undefined,
      `${path}: remove the dead "pnpm" field — pnpm 11 ignores per-package pnpm config`,
    );
  }
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
