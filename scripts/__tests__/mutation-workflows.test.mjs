import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const read = (p) => readFile(new URL(`../../${p}`, import.meta.url), 'utf-8');

test('mutation-pr.yml runs the advisory gate with ignoreStatic on', async () => {
  const yml = await read('.github/workflows/mutation-pr.yml');
  assert.match(yml, /STRYKER_IGNORE_STATIC:\s*'true'/, 'PR run must opt into ignoreStatic');
  assert.match(yml, /continue-on-error:\s*true/, 'advisory steps must be non-fatal');
  assert.match(yml, /dashboard\.stryker-mutator\.io\/api\/reports/, 'PR run must download the dashboard baseline');
  assert.doesNotMatch(yml, /STRYKER_DASHBOARD_API_KEY/, 'PR workflow must not reference the upload secret');
});

test('mutation-pr.yml uploads per-package markdown summaries', async () => {
  const yml = await read('.github/workflows/mutation-pr.yml');
  assert.match(yml, /mutation-summary-/, 'PR run must upload a per-package markdown summary artifact');
});

void repoRoot;
