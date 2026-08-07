import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

test('verify:site makes Playwright reuse the Astro server it starts in CI', async () => {
  const script = await readFile(join(repoRoot, 'scripts/verify-site.sh'), 'utf-8');
  const config = await readFile(join(repoRoot, 'site/playwright.config.ts'), 'utf-8');

  assert.match(
    script,
    /PLAYWRIGHT_REUSE_EXISTING_SERVER=1\s+pnpm --filter site test/,
    'verify-site.sh must explicitly request reuse of its already-running server',
  );
  assert.match(
    config,
    /reuseExistingServer:\s*process\.env\.PLAYWRIGHT_REUSE_EXISTING_SERVER === '1' \|\| !process\.env\.CI/,
    'Playwright must honor verify:site server reuse while retaining local reuse',
  );
});
