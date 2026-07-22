import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../check-dated-docs-immutable.mjs', import.meta.url));

// Isolate the temp repos from any ambient git config (e.g. commit signing) so
// the tests behave identically on every machine and in CI.
const ISOLATED_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

/**
 * Run a git command in the given repo and return trimmed stdout.
 */
function git(repo, ...args) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: ISOLATED_GIT_ENV,
  }).trim();
}

/**
 * Write a file, creating parent directories as needed.
 */
function put(repo, relPath, contents) {
  const abs = join(repo, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
}

/**
 * Run the guard against a base ref. Returns { status, stdout, stderr }.
 */
function runGuard(repo, base) {
  try {
    const stdout = execFileSync('node', [scriptPath, '--base', base], {
      cwd: repo,
      encoding: 'utf8',
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      status: err.status ?? 1,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
    };
  }
}

let repo;
let baseSha;

before(() => {
  repo = mkdtempSync(join(tmpdir(), 'dated-immutable-'));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');

  // Baseline: a committed dated plan plus a non-dated doc.
  put(repo, 'docs/superpowers/plans/2026-07-15-example-plan.md', '# Plan\n\nAs planned.\n');
  put(repo, 'docs/superpowers/README.md', '# Index\n');
  put(repo, 'docs/internal/architecture.md', '# Architecture\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'baseline');
  baseSha = git(repo, 'rev-parse', 'HEAD');
});

after(() => {
  rmSync(repo, { recursive: true, force: true });
});

test('flags a modified committed dated plan and names it', () => {
  put(
    repo,
    'docs/superpowers/plans/2026-07-15-example-plan.md',
    '# Plan\n\nRewritten after the fact.\n',
  );
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'rewrite dated plan');

  const result = runGuard(repo, baseSha);
  assert.equal(result.status, 1, 'guard must exit non-zero on a modified dated file');
  assert.match(
    result.stderr,
    /docs\/superpowers\/plans\/2026-07-15-example-plan\.md/,
    'guard must name the offending file',
  );

  // Reset to baseline for isolation of subsequent tests.
  git(repo, 'reset', '-q', '--hard', baseSha);
});

test('passes when a brand-new dated file is added', () => {
  put(repo, 'docs/superpowers/plans/2026-08-01-new-plan.md', '# New Plan\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'add new dated plan');

  const result = runGuard(repo, baseSha);
  assert.equal(result.status, 0, `added dated file must pass; stderr: ${result.stderr}`);

  git(repo, 'reset', '-q', '--hard', baseSha);
});

test('passes on a clean tree (no changes vs base)', () => {
  const result = runGuard(repo, baseSha);
  assert.equal(result.status, 0, `clean tree must pass; stderr: ${result.stderr}`);
});

test('passes when a committed dated file is deleted', () => {
  rmSync(join(repo, 'docs/superpowers/plans/2026-07-15-example-plan.md'));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'delete dated plan');

  const result = runGuard(repo, baseSha);
  assert.equal(result.status, 0, `deletion must pass; stderr: ${result.stderr}`);

  git(repo, 'reset', '-q', '--hard', baseSha);
});

test('flags a renamed committed dated file (rename rewrites the record)', () => {
  git(
    repo,
    'mv',
    'docs/superpowers/plans/2026-07-15-example-plan.md',
    'docs/superpowers/plans/2026-07-16-example-plan.md',
  );
  git(repo, 'commit', '-qm', 'rename dated plan');

  const result = runGuard(repo, baseSha);
  assert.equal(result.status, 1, 'renaming a dated file must be flagged as a modification');
  assert.match(
    result.stderr,
    /2026-07-15-example-plan\.md/,
    'guard must name the original dated path on rename',
  );

  git(repo, 'reset', '-q', '--hard', baseSha);
});

test('ignores a modified non-dated doc under docs/superpowers', () => {
  put(repo, 'docs/superpowers/README.md', '# Index\n\nUpdated index.\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'update index');

  const result = runGuard(repo, baseSha);
  assert.equal(result.status, 0, `non-dated superpowers doc must pass; stderr: ${result.stderr}`);

  git(repo, 'reset', '-q', '--hard', baseSha);
});

test('ignores a modified doc outside docs/superpowers', () => {
  put(repo, 'docs/internal/architecture.md', '# Architecture\n\nEdited in place by design.\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'edit internal doc');

  const result = runGuard(repo, baseSha);
  assert.equal(result.status, 0, `docs/internal edits must pass; stderr: ${result.stderr}`);

  git(repo, 'reset', '-q', '--hard', baseSha);
});

test('no-ops (exit 0) with a note when the base ref cannot be resolved', () => {
  const result = runGuard(repo, 'refs/heads/does-not-exist');
  assert.equal(result.status, 0, `unresolvable base must no-op; stderr: ${result.stderr}`);
});
