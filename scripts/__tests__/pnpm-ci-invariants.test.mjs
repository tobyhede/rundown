import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const workflowsDir = join(repoRoot, '.github/workflows');
const compositeAction = join(repoRoot, '.github/actions/setup-node-deps/action.yml');

/**
 * List every CI definition file: the workflows plus the shared composite action.
 *
 * @returns absolute paths to all `.yml` workflow/action definitions
 */
async function ciFiles() {
  const workflows = (await readdir(workflowsDir))
    .filter((name) => name.endsWith('.yml'))
    .map((name) => join(workflowsDir, name));
  return [...workflows, compositeAction];
}

test('every pnpm/action-setup ref is SHA-pinned and identical across CI', async () => {
  const files = await ciFiles();
  const pins = new Set();
  for (const file of files) {
    const text = await readFile(file, 'utf-8');
    for (const match of text.matchAll(/pnpm\/action-setup@(\S+)/g)) {
      const ref = match[1];
      assert.match(
        ref,
        /^[0-9a-f]{40}$/,
        `${file}: pnpm/action-setup must be pinned to a 40-char commit SHA, got "${ref}"`,
      );
      pins.add(ref);
    }
  }
  assert.ok(pins.size > 0, 'expected at least one pnpm/action-setup reference in CI');
  assert.equal(
    pins.size,
    1,
    `pnpm/action-setup SHA must be consistent across CI, found: ${[...pins].join(', ')}`,
  );
});

test('no workflow uses npm ci / npm run (dev installs are pnpm)', async () => {
  const files = await ciFiles();
  for (const file of files) {
    const text = await readFile(file, 'utf-8');
    const lines = text.split('\n').filter((line) => !line.trimStart().startsWith('#'));
    for (const line of lines) {
      // Negative lookbehind excludes the `pnpm ci`/`pnpm run` substring.
      assert.doesNotMatch(
        line,
        /(?<!p)\bnpm ci\b/,
        `${file}: found "npm ci" — use "pnpm install --frozen-lockfile"`,
      );
      assert.doesNotMatch(line, /(?<!p)\bnpm run\b/, `${file}: found "npm run" — use "pnpm run"`);
    }
  }
});

test('osv-scanner targets pnpm-lock.yaml and no workflow references package-lock.json', async () => {
  const osv = await readFile(join(workflowsDir, 'osv-scanner.yml'), 'utf-8');
  assert.match(osv, /--lockfile=pnpm-lock\.yaml/, 'osv-scanner must scan pnpm-lock.yaml');

  for (const file of await ciFiles()) {
    const text = await readFile(file, 'utf-8');
    assert.doesNotMatch(
      text,
      /package-lock\.json/,
      `${file}: references deleted package-lock.json`,
    );
  }
});

test('osv-scanner blocks on findings (no continue-on-error)', async () => {
  const osv = await readFile(join(workflowsDir, 'osv-scanner.yml'), 'utf-8');
  // The 17 security overrides exist to keep this green; a CVE regression must
  // fail the PR rather than scroll by.
  assert.doesNotMatch(
    osv,
    /continue-on-error:\s*true/,
    'osv-scanner.yml must not set continue-on-error: true — a CVE finding should block the PR',
  );
});

test('Changesets uses pnpm as its package manager', async () => {
  const config = JSON.parse(await readFile(join(repoRoot, '.changeset/config.json'), 'utf-8'));
  assert.equal(config.packageManager, 'pnpm');
});
