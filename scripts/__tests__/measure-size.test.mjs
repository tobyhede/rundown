import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../measure-size.mjs', import.meta.url));

// Every fixture lives in a temp dir created per run. The script is pointed at it
// with `--root` and `--allowlist`, so nothing here reads a repo file: the suite
// must stay runnable from inside a Stryker sandbox and must not drift when the
// real allowlist changes.
let root;

/**
 * Write a UTF-8 file under the fixture root, creating parent directories.
 *
 * @param {string} rel - path relative to the fixture root
 * @param {string} content - file content
 */
function writeFixture(rel, content) {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

/**
 * Write an allowlist JSON under the fixture root and return its absolute path.
 *
 * @param {string} name - file name for the allowlist
 * @param {object} allowlist - allowlist object to serialise
 * @returns {string} absolute path of the written allowlist
 */
function writeAllowlist(name, allowlist) {
  const abs = join(root, name);
  writeFileSync(abs, JSON.stringify(allowlist));
  return abs;
}

/**
 * Run the measurement script and capture its exit status and stdout.
 *
 * @param {string[]} args - CLI args appended after `--root <root>`
 * @returns {{ code: number, stdout: string }} exit code and stdout
 */
function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, '--root', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status, stdout: error.stdout ?? '' };
  }
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'measure-size-'));
  // `wc -l` semantics: a file counts its newlines, so an unterminated last
  // line does not count and an empty file is 0.
  writeFixture('pkg/src/a.ts', 'one\ntwo\nthree\n');
  writeFixture('pkg/src/b.ts', 'one\ntwo'); // 1 newline
  writeFixture('pkg/src/nested/c.ts', 'x\n'.repeat(10));
  writeFixture('pkg/src/nested/skip.md', 'not\ncounted\n');
  writeFixture('pkg/src/empty.ts', '');
  writeFixture('other/d.ts', 'a\nb\nc\nd\n');
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

test('counts newlines per matching file and totals each list', () => {
  const allowlist = writeAllowlist('allow-basic.json', {
    authority: ['pkg/src/a.ts', 'pkg/src/b.ts', 'pkg/src/empty.ts'],
    machinery: ['other/d.ts'],
    gates: { authority: 100, machinery: 100 },
  });
  const { code, stdout } = run(['--allowlist', allowlist]);
  assert.equal(code, 0);
  const report = JSON.parse(stdout);
  assert.deepEqual(report.authority.files, [
    { path: 'pkg/src/a.ts', lines: 3 },
    { path: 'pkg/src/b.ts', lines: 1 },
    { path: 'pkg/src/empty.ts', lines: 0 },
  ]);
  assert.equal(report.authority.total, 4);
  assert.deepEqual(report.machinery.files, [{ path: 'other/d.ts', lines: 4 }]);
  assert.equal(report.machinery.total, 4);
});

test('expands dir/**/*.ts globs recursively and only to the given extension', () => {
  const allowlist = writeAllowlist('allow-glob.json', {
    authority: ['pkg/src/**/*.ts'],
    machinery: [],
    gates: { authority: 100, machinery: 100 },
  });
  const report = JSON.parse(run(['--allowlist', allowlist]).stdout);
  assert.deepEqual(
    report.authority.files.map((f) => f.path),
    ['pkg/src/a.ts', 'pkg/src/b.ts', 'pkg/src/empty.ts', 'pkg/src/nested/c.ts'],
    'sorted, recursive, .md excluded',
  );
  assert.equal(report.authority.total, 14);
  assert.deepEqual(report.machinery, {
    files: [],
    total: 0,
    gate: 100,
    missing: [],
  });
});

test('lists absent files under missing instead of failing', () => {
  const allowlist = writeAllowlist('allow-missing.json', {
    authority: ['pkg/src/a.ts', 'pkg/src/deleted-module.ts'],
    machinery: ['gone/**/*.ts'],
    gates: { authority: 100, machinery: 100 },
  });
  const { code, stdout } = run(['--allowlist', allowlist]);
  assert.equal(code, 0);
  const report = JSON.parse(stdout);
  assert.deepEqual(report.authority.missing, ['pkg/src/deleted-module.ts']);
  assert.equal(report.authority.total, 3);
  assert.deepEqual(report.machinery.missing, ['gone/**/*.ts']);
  assert.equal(report.machinery.total, 0);
});

test('JSON report carries the documented shape', () => {
  const allowlist = writeAllowlist('allow-shape.json', {
    authority: ['pkg/src/a.ts'],
    machinery: ['other/d.ts'],
    gates: { authority: 6400, machinery: 8600 },
  });
  const report = JSON.parse(run(['--allowlist', allowlist]).stdout);
  assert.deepEqual(Object.keys(report).sort(), ['authority', 'generatedAt', 'machinery']);
  for (const key of ['authority', 'machinery']) {
    assert.deepEqual(Object.keys(report[key]).sort(), ['files', 'gate', 'missing', 'total']);
  }
  assert.equal(report.authority.gate, 6400);
  assert.equal(report.machinery.gate, 8600);
  assert.ok(!Number.isNaN(Date.parse(report.generatedAt)), 'generatedAt is an ISO timestamp');
});

test('report mode exits 0 even when a total exceeds its gate', () => {
  const allowlist = writeAllowlist('allow-over-report.json', {
    authority: ['pkg/src/a.ts'],
    machinery: ['other/d.ts'],
    gates: { authority: 1, machinery: 1 },
  });
  assert.equal(run(['--allowlist', allowlist]).code, 0);
  assert.equal(run(['--allowlist', allowlist, '--text']).code, 0);
});

test('--enforce exits 1 when any total exceeds its gate', () => {
  const overAuthority = writeAllowlist('allow-over-authority.json', {
    authority: ['pkg/src/a.ts'], // 3 lines
    machinery: ['other/d.ts'], // 4 lines
    gates: { authority: 2, machinery: 100 },
  });
  assert.equal(run(['--allowlist', overAuthority, '--enforce']).code, 1);

  const overMachinery = writeAllowlist('allow-over-machinery.json', {
    authority: ['pkg/src/a.ts'],
    machinery: ['other/d.ts'],
    gates: { authority: 100, machinery: 3 },
  });
  assert.equal(run(['--allowlist', overMachinery, '--enforce']).code, 1);
});

test('--enforce exits 0 when every total is at or under its gate', () => {
  const allowlist = writeAllowlist('allow-under.json', {
    authority: ['pkg/src/a.ts'], // 3 lines
    machinery: ['other/d.ts'], // 4 lines
    gates: { authority: 3, machinery: 4 },
  });
  const { code, stdout } = run(['--allowlist', allowlist, '--enforce']);
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout).authority.total, 3, 'enforce still prints the report');
});

test('--text renders a two-column table with totals against gates', () => {
  const allowlist = writeAllowlist('allow-text.json', {
    authority: ['pkg/src/a.ts', 'pkg/src/deleted-module.ts'],
    machinery: ['other/d.ts'],
    gates: { authority: 6400, machinery: 8600 },
  });
  const { code, stdout } = run(['--allowlist', allowlist, '--text']);
  assert.equal(code, 0);
  assert.match(stdout, /^FILE\s+LINES$/m, 'UPPERCASE two-column header');
  assert.match(stdout, /^pkg\/src\/a\.ts\s+3$/m);
  assert.match(stdout, /^other\/d\.ts\s+4$/m);
  assert.match(stdout, /authority.*\b3\b.*\/.*\b6400\b/i, 'authority total vs gate');
  assert.match(stdout, /machinery.*\b4\b.*\/.*\b8600\b/i, 'machinery total vs gate');
  assert.match(stdout, /missing.*pkg\/src\/deleted-module\.ts/i);
  assert.throws(() => JSON.parse(stdout), 'text mode is not JSON');
});
