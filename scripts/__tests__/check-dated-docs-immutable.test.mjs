import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../check-dated-docs-immutable.mjs', import.meta.url));

// Isolate the temp repos from any ambient git config (e.g. commit signing) so
// the tests behave identically on every machine and in CI.
const ISOLATED_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

// Baseline env for the guard's own `node` spawn. It inherits the isolated git
// config (so the guard's git invocations are hermetic too — Finding 4) and,
// critically, strips any ambient CI signal from the test host: the guard's
// CI-mode failure path (Finding 1) keys off GITHUB_ACTIONS / CI, so leaving them
// set would flip the local-mode no-op tests. Each test opts back into CI mode by
// passing an explicit `extraEnv`.
const GUARD_BASE_ENV = { ...ISOLATED_GIT_ENV };
delete GUARD_BASE_ENV.CI;
delete GUARD_BASE_ENV.GITHUB_ACTIONS;
delete GUARD_BASE_ENV.GITHUB_BASE_REF;

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
 * Run the guard. Returns { status, stdout, stderr }.
 *
 * @param {string} repo - repo working directory
 * @param {string | null} base - explicit `--base` ref, or null/undefined to omit it
 *   (drives resolution through GITHUB_BASE_REF / origin fallbacks instead)
 * @param {Record<string, string>} [extraEnv] - env overrides merged onto the
 *   hermetic base env (e.g. `{ GITHUB_ACTIONS: 'true' }` or `{ GITHUB_BASE_REF }`)
 */
function runGuard(repo, base, extraEnv = {}) {
  const args = [scriptPath];
  if (base) args.push('--base', base);
  const env = { ...GUARD_BASE_ENV, ...extraEnv };
  try {
    const stdout = execFileSync('node', args, {
      cwd: repo,
      encoding: 'utf8',
      env,
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

  // Move the working branch off `main`/`master` so resolveBase's `origin/main` /
  // `main` fallback cannot silently resolve to HEAD — that would mask the
  // "unresolvable base" path the CI-mode and local-mode no-op tests exercise.
  git(repo, 'branch', '-m', 'topic');
});

after(() => {
  rmSync(repo, { recursive: true, force: true });
});

// Restore the repo to the pristine baseline before every test, independent of
// whether the previous test reached its happy path (Finding 3). A test that
// throws before an inline reset can no longer leave the shared repo dirty.
beforeEach(() => {
  git(repo, 'reset', '-q', '--hard', baseSha);
  git(repo, 'clean', '-q', '-f', '-d', '-x');
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
});

test('passes when a brand-new dated file is added', () => {
  put(repo, 'docs/superpowers/plans/2026-08-01-new-plan.md', '# New Plan\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'add new dated plan');

  const result = runGuard(repo, baseSha);
  assert.equal(result.status, 0, `added dated file must pass; stderr: ${result.stderr}`);
});

test('passes on a clean tree (no changes vs base)', () => {
  const result = runGuard(repo, baseSha);
  assert.equal(result.status, 0, `clean tree must pass; stderr: ${result.stderr}`);
});

test('success output names the resolved base and the compared commit range', () => {
  const mergeBase = git(repo, 'merge-base', baseSha, 'HEAD');
  const result = runGuard(repo, baseSha);
  assert.equal(result.status, 0, `clean tree must pass; stderr: ${result.stderr}`);
  assert.match(
    result.stdout,
    new RegExp(`${mergeBase}\\.\\.HEAD`),
    'success line must show the compared <mergeBase>..HEAD range so CI logs prove a real comparison',
  );
  assert.match(result.stdout, new RegExp(baseSha), 'success line must name the resolved base');
});

test('passes when a committed dated file is deleted', () => {
  rmSync(join(repo, 'docs/superpowers/plans/2026-07-15-example-plan.md'));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'delete dated plan');

  const result = runGuard(repo, baseSha);
  assert.equal(result.status, 0, `deletion must pass; stderr: ${result.stderr}`);
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
});

test('flags a dated file moved out of docs/superpowers into docs/internal', () => {
  // Moving a dated record into docs/internal/ rewrites the record just as a
  // same-directory rename does. The guard must catch it even though the new
  // path lands outside docs/superpowers/ — rename detection has to consider all
  // paths, not just those under the scope prefix.
  git(
    repo,
    'mv',
    'docs/superpowers/plans/2026-07-15-example-plan.md',
    'docs/internal/2026-07-15-example-plan.md',
  );
  git(repo, 'commit', '-qm', 'move dated plan into docs/internal');

  const result = runGuard(repo, baseSha);
  assert.equal(
    result.status,
    1,
    `moving a dated file out of docs/superpowers must be flagged; stderr: ${result.stderr}`,
  );
  assert.match(
    result.stderr,
    /2026-07-15-example-plan\.md/,
    'guard must name the original dated path when it is moved out of scope',
  );
});

test('flags a modified dated file whose path contains non-ASCII characters', () => {
  // git's default --name-status C-quotes paths with non-ASCII bytes (wrapping
  // them in double quotes with octal escapes), which breaks tab-splitting and
  // hides the real path from isDatedDoc. NUL-delimited (-z) output emits the raw
  // literal path, so the guard must still flag the rewrite.
  const special = 'docs/superpowers/plans/2026-07-15-café-plan.md';
  put(repo, special, '# Plan\n\nAs planned.\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'add dated plan with non-ascii name');
  const specialBase = git(repo, 'rev-parse', 'HEAD');

  put(repo, special, '# Plan\n\nRewritten after the fact.\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'rewrite non-ascii dated plan');

  const result = runGuard(repo, specialBase);
  assert.equal(
    result.status,
    1,
    `modified dated file with a non-ASCII path must be flagged; stderr: ${result.stderr}`,
  );
});

test('ignores a modified non-dated doc under docs/superpowers', () => {
  put(repo, 'docs/superpowers/README.md', '# Index\n\nUpdated index.\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'update index');

  const result = runGuard(repo, baseSha);
  assert.equal(result.status, 0, `non-dated superpowers doc must pass; stderr: ${result.stderr}`);
});

test('ignores a modified doc outside docs/superpowers', () => {
  put(repo, 'docs/internal/architecture.md', '# Architecture\n\nEdited in place by design.\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'edit internal doc');

  const result = runGuard(repo, baseSha);
  assert.equal(result.status, 0, `docs/internal edits must pass; stderr: ${result.stderr}`);
});

test('resolves the base via GITHUB_BASE_REF (origin/<branch>) and flags a modification', () => {
  // Stand in for the PR base branch's remote-tracking ref without a real remote.
  git(repo, 'update-ref', 'refs/remotes/origin/release', baseSha);

  put(
    repo,
    'docs/superpowers/plans/2026-07-15-example-plan.md',
    '# Plan\n\nRewritten on a PR branch.\n',
  );
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'rewrite dated plan on PR branch');

  // No --base: resolution must flow through GITHUB_BASE_REF -> origin/release.
  const result = runGuard(repo, null, { GITHUB_BASE_REF: 'release' });
  assert.equal(
    result.status,
    1,
    `GITHUB_BASE_REF resolution must diff against origin/release and flag the edit; stderr: ${result.stderr}`,
  );
  assert.match(
    result.stderr,
    /docs\/superpowers\/plans\/2026-07-15-example-plan\.md/,
    'guard must name the offending file when resolving via GITHUB_BASE_REF',
  );
});

test('CI mode: unresolvable base exits non-zero naming the misconfiguration', () => {
  const result = runGuard(repo, 'refs/heads/does-not-exist', {
    GITHUB_ACTIONS: 'true',
  });
  assert.equal(
    result.status,
    1,
    `CI mode must fail loudly on an unresolvable base rather than pass a no-op; stdout: ${result.stdout}`,
  );
  assert.match(
    result.stderr,
    /misconfiguration/i,
    'CI-mode failure must explain the misconfiguration',
  );
  assert.match(
    result.stderr,
    /origin\/main|--base|full history/,
    'CI-mode failure must point at the fix (full history / origin/main / --base)',
  );
});

test('local mode (no CI env): unresolvable base no-ops with a note (exit 0)', () => {
  // GUARD_BASE_ENV strips CI/GITHUB_ACTIONS, so an ambient CI=true on the test
  // host cannot flip this into the CI-mode failure path.
  const result = runGuard(repo, 'refs/heads/does-not-exist');
  assert.equal(result.status, 0, `unresolvable base must no-op locally; stderr: ${result.stderr}`);
  assert.match(result.stdout, /skipping/, 'local no-op must print the skip note');
});
