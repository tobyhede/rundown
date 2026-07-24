import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkToolchain } from '../check-toolchain.mjs';

const scriptPath = fileURLToPath(new URL('../check-toolchain.mjs', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const workspaceYaml = readFileSync(new URL('../../pnpm-workspace.yaml', import.meta.url), 'utf8');

// The values this repo actually declares. The guard reads the real files, so the
// tests drive it by varying only the ENVIRONMENT — which is exactly the axis that
// broke in practice (right repo, wrong host toolchain).
const DECLARED_PNPM_MAJOR = /^pnpm@(\d+)\./.exec(pkg.packageManager)[1];
const DECLARED_NODE_OPTIONS = /^nodeOptions:[ \t]*(.*)$/m.exec(workspaceYaml)[1].trim();

/**
 * Build an environment that satisfies every check, so each test can break one
 * dimension in isolation.
 *
 * Starts from an empty base rather than `process.env` so an ambient
 * `npm_config_user_agent` or `NODE_OPTIONS` on the test host cannot mask a
 * regression.
 *
 * @param overrides - env entries to add or replace; set a key to null to delete it
 * @returns the environment to hand the spawned guard
 */
function envWith(overrides = {}) {
  const base = {
    PATH: process.env.PATH,
    npm_config_user_agent: `pnpm/${DECLARED_PNPM_MAJOR}.0.0 npm/? node/${process.version} darwin arm64`,
    NODE_OPTIONS: DECLARED_NODE_OPTIONS,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) delete base[key];
    else base[key] = value;
  }
  return base;
}

/**
 * Run the guard and capture its exit status and combined output.
 *
 * @param env - environment for the spawned process
 * @returns `{ code, output }`
 */
function runGuard(env) {
  try {
    const output = execFileSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, output };
  } catch (err) {
    return { code: err.status, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

test('passes when the running toolchain matches every declaration', () => {
  const { code, output } = runGuard(envWith());
  assert.equal(code, 0, output);
  assert.match(output, /toolchain ok:/);
});

test('fails when the running pnpm major differs from packageManager', () => {
  const wrongMajor = Number(DECLARED_PNPM_MAJOR) - 2;
  const { code, output } = runGuard(
    envWith({
      npm_config_user_agent: `pnpm/${wrongMajor}.15.3 npm/? node/${process.version} darwin arm64`,
    }),
  );
  assert.equal(code, 1);
  assert.match(output, /pnpm major mismatch/);
  assert.match(output, new RegExp(`pnpm ${wrongMajor}\\.15\\.3 is running`));
  // The remediation must name the two things that actually fix it.
  assert.match(output, /corepack enable/);
  assert.match(output, /which -a pnpm/);
});

test('accepts a minor or patch difference within the declared major', () => {
  const { code, output } = runGuard(
    envWith({
      npm_config_user_agent: `pnpm/${DECLARED_PNPM_MAJOR}.999.999 npm/? node/${process.version} darwin arm64`,
    }),
  );
  assert.equal(code, 0, output);
});

test('fails when NODE_OPTIONS lacks a flag pnpm-workspace.yaml declares', () => {
  const { code, output } = runGuard(envWith({ NODE_OPTIONS: '' }));
  assert.equal(code, 1);
  assert.match(output, /NODE_OPTIONS/);
  assert.match(output, /missing: .*--experimental-vm-modules/);
  assert.match(output, /every Jest ESM suite fails to parse/);
});

test('fails on the exact incident shape: right repo, pnpm 9, no NODE_OPTIONS', () => {
  const { code, output } = runGuard(
    envWith({
      npm_config_user_agent: `pnpm/9.15.3 npm/? node/${process.version} darwin arm64`,
      NODE_OPTIONS: null,
    }),
  );
  assert.equal(code, 1);
  // Both layers report in one run, so a single invocation shows the whole story.
  assert.match(output, /pnpm major mismatch/);
  assert.match(output, /missing: .*--experimental-vm-modules/);
});

test('fails with a run-me-through-pnpm message when the user agent is absent', () => {
  const { code, output } = runGuard(envWith({ npm_config_user_agent: null }));
  assert.equal(code, 1);
  assert.match(output, /must run through pnpm/);
});

// The node-version dimension cannot be driven by spawning (a child process
// reports its own real version), so it is exercised against the exported
// function, which takes the version as a parameter.
test('fails when the running node is older than engines.node', () => {
  const required = /^>=\s*(\d+)/.exec(pkg.engines?.node ?? '');
  assert.ok(required, 'expected package.json engines.node to use the >=<major> form');
  const tooOld = `v${Number(required[1]) - 1}.0.0`;

  const failures = checkToolchain(envWith(), tooOld);
  assert.equal(failures.length, 1, `unexpected failures: ${failures.join(' | ')}`);
  assert.match(failures[0], /node too old/);
  assert.match(failures[0], new RegExp(`${tooOld} is running`));
});

test('accepts a node newer than engines.node requires', () => {
  const required = /^>=\s*(\d+)/.exec(pkg.engines?.node ?? '');
  const newer = `v${Number(required[1]) + 5}.0.0`;
  assert.deepEqual(checkToolchain(envWith(), newer), []);
});
