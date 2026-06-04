import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const configs = [
  'packages/claude-code-plugin/stryker.config.mjs',
  'packages/cli/stryker.config.mjs',
  'packages/core/stryker.config.mjs',
  'packages/parser/stryker.config.mjs',
];

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
}
