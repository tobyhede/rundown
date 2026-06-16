import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

// dir = package directory; each ships a stryker.config.mjs + a package.json.
const packages = ['claude-code-plugin', 'cli', 'core', 'parser'];
const configs = packages.map((pkg) => `packages/${pkg}/stryker.config.mjs`);

async function loadConfig(configPath, value) {
  const previous = process.env.STRYKER_CONCURRENCY;
  try {
    if (value === undefined) {
      delete process.env.STRYKER_CONCURRENCY;
    } else {
      process.env.STRYKER_CONCURRENCY = value;
    }

    const configUrl = pathToFileURL(join(repoRoot, configPath));
    configUrl.searchParams.set('case', `${value ?? 'default'}-${Date.now()}-${Math.random()}`);
    return (await import(configUrl.href)).default;
  } finally {
    if (previous === undefined) {
      delete process.env.STRYKER_CONCURRENCY;
    } else {
      process.env.STRYKER_CONCURRENCY = previous;
    }
  }
}

for (const configPath of configs) {
  test(`${configPath} parses STRYKER_CONCURRENCY overrides`, async () => {
    assert.equal((await loadConfig(configPath, '1')).concurrency, 1);
    assert.equal((await loadConfig(configPath, 'invalid')).concurrency, 2);
    assert.equal((await loadConfig(configPath, '-1')).concurrency, 2);
    assert.equal((await loadConfig(configPath, undefined)).concurrency, 2);
  });

  test(`${configPath} pins pnpm + the explicit jest-runner plugin`, async () => {
    const config = await loadConfig(configPath, undefined);
    // pnpm's isolated layout breaks Stryker's default '@stryker-mutator/*'
    // plugin auto-discovery, so both must be set explicitly or mutation runs
    // fail with "Cannot find TestRunner plugin jest".
    assert.equal(config.packageManager, 'pnpm', `${configPath}: packageManager must be 'pnpm'`);
    assert.ok(
      Array.isArray(config.plugins) && config.plugins.includes('@stryker-mutator/jest-runner'),
      `${configPath}: plugins must explicitly include '@stryker-mutator/jest-runner'`,
    );
  });
}

for (const pkg of packages) {
  test(`packages/${pkg} declares the Stryker devDependencies`, async () => {
    const manifest = JSON.parse(
      await readFile(join(repoRoot, `packages/${pkg}/package.json`), 'utf-8'),
    );
    const devDeps = manifest.devDependencies ?? {};
    // pnpm only exposes a package's declared deps; the root no longer hoists
    // these, so each mutating package must declare them itself.
    for (const dep of ['@stryker-mutator/core', '@stryker-mutator/jest-runner']) {
      assert.ok(
        devDeps[dep],
        `packages/${pkg}/package.json must declare ${dep} in devDependencies`,
      );
    }
  });
}
