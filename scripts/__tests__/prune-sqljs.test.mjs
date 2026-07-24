import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

import { pruneSqlJsDist } from '../../site/scripts/prune-sqljs.mjs';

// The WebContainer snapshot packs an entire node_modules tree into ONE static
// asset, and Cloudflare Pages rejects any file over 25 MiB. sql.js ships every
// build variant it has ever supported (~18 MB: asm.js fallbacks, debug builds,
// browser variants, workers) while the driver loads one entry (~0.7 MB), so the
// unused variants are pure static-asset weight. See issue #639 for why the
// snapshot's proximity to that limit is a standing problem, not just this one.

let root;
const created = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'prune-sqljs-'));
  created.push(root);
});

after(() => {
  for (const dir of created) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Write a fake installed sql.js package.
 *
 * @param {string} nodeModulesDir - Directory to install into.
 * @param {object} options - Fixture options.
 * @param {object} [options.packageJson] - package.json contents.
 * @param {Record<string, number>} [options.dist] - dist filename → byte size.
 * @returns {string} The package directory.
 */
function installFakeSqlJs(nodeModulesDir, { packageJson, dist } = {}) {
  const pkgDir = join(nodeModulesDir, 'sql.js');
  mkdirSync(join(pkgDir, 'dist'), { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify(
      packageJson ?? {
        name: 'sql.js',
        main: './dist/sql-wasm.js',
        exports: {
          '.': { browser: './dist/sql-wasm-browser.js', default: './dist/sql-wasm.js' },
          './dist/*': './dist/*',
        },
      },
    ),
  );
  writeFileSync(join(pkgDir, 'LICENSE'), 'license text');
  const files = dist ?? {
    'sql-wasm.js': 100,
    'sql-wasm.wasm': 200,
    'sql-wasm-browser.js': 100,
    'sql-wasm-browser.wasm': 200,
    'sql-asm.js': 5000,
    'sql-asm-debug.js': 9000,
    'worker.sql-asm.js': 5000,
    'sql-wasm-debug.js': 3000,
    'sql-wasm-debug.wasm': 4000,
  };
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(pkgDir, 'dist', name), distContent(name, value));
  }
  return pkgDir;
}

/**
 * Body for one fixture `dist/` file.
 *
 * A number produces a loader that resolves its own `.wasm` sibling by name,
 * padded to exactly that many bytes — mirroring how the real `sql-wasm.js`
 * locates its payload. A string is written literally, which is how an asm.js
 * build (no payload at all) is expressed.
 *
 * @param {string} name - Filename within `dist/`.
 * @param {number | string} value - Byte size, or literal content.
 * @returns {string} File contents.
 */
function distContent(name, value) {
  if (typeof value === 'string') {
    return value;
  }
  if (!name.endsWith('.js')) {
    return 'x'.repeat(value);
  }
  const locate = `locateFile("${name.replace(/\.js$/, '.wasm')}");`;
  return locate + 'x'.repeat(Math.max(0, value - locate.length));
}

test('keeps every entry point the package declares, plus each one’s wasm sibling', () => {
  const pkgDir = installFakeSqlJs(root);

  pruneSqlJsDist(root);

  assert.deepEqual(readdirSync(join(pkgDir, 'dist')).sort(), [
    'sql-wasm-browser.js',
    'sql-wasm-browser.wasm',
    'sql-wasm.js',
    'sql-wasm.wasm',
  ]);
});

test('leaves files outside dist/ untouched', () => {
  const pkgDir = installFakeSqlJs(root);

  pruneSqlJsDist(root);

  assert.deepEqual(
    readdirSync(pkgDir).sort(),
    ['LICENSE', 'dist', 'package.json'],
    'pruning is scoped to build variants, not package metadata',
  );
});

test('reports the bytes it reclaimed so a no-op prune is visible in the build log', () => {
  installFakeSqlJs(root);

  const result = pruneSqlJsDist(root);

  // 5000 + 9000 + 5000 + 3000 + 4000 across the dropped variants.
  assert.equal(result.bytesRemoved, 26_000);
  assert.equal(result.packages.length, 1);
});

test('follows a renamed entry point rather than a hardcoded filename', () => {
  // Derived from the package's own main/exports: if sql.js renames its entry,
  // the prune follows instead of deleting the file the driver actually loads.
  const pkgDir = installFakeSqlJs(root, {
    packageJson: { name: 'sql.js', main: './dist/sql-next.js' },
    dist: { 'sql-next.js': 100, 'sql-next.wasm': 200, 'sql-asm.js': 9000 },
  });

  pruneSqlJsDist(root);

  assert.deepEqual(readdirSync(join(pkgDir, 'dist')).sort(), ['sql-next.js', 'sql-next.wasm']);
});

test('prunes every installed copy, not just the first', () => {
  const hoisted = installFakeSqlJs(root);
  const nested = installFakeSqlJs(join(root, 'other-pkg', 'node_modules'));

  const result = pruneSqlJsDist(root);

  for (const pkgDir of [hoisted, nested]) {
    assert.equal(readdirSync(join(pkgDir, 'dist')).length, 4);
  }
  assert.equal(result.packages.length, 2);
});

test('refuses a tree with no sql.js at all', () => {
  // A silent no-op is the whole failure mode: the snapshot would sail past the
  // build and only fail later, in Cloudflare, at upload time.
  mkdirSync(join(root, 'some-other-package'), { recursive: true });

  assert.throws(() => pruneSqlJsDist(root), /sql\.js/);
});

test('refuses a retained loader whose wasm payload is missing', () => {
  // Keeping the loader without its payload yields a package that imports
  // cleanly and then fails at initSqlJs() — inside WebContainer, long after the
  // build that could have caught it.
  installFakeSqlJs(root, {
    packageJson: { name: 'sql.js', main: './dist/sql-wasm.js' },
    dist: { 'sql-wasm.js': 100, 'sql-asm.js': 9000 },
  });

  assert.throws(() => pruneSqlJsDist(root), /sql-wasm\.wasm/);
});

test('allows an entry point that needs no wasm payload at all', () => {
  // sql.js's asm.js builds ship no .wasm whatsoever. Demanding a payload for
  // every retained loader would fail them for being correctly packaged, so the
  // requirement keys off whether the loader actually names its sibling.
  const pkgDir = installFakeSqlJs(root, {
    packageJson: { name: 'sql.js', main: './dist/sql-asm.js' },
    dist: { 'sql-asm.js': 'var Module = {};', 'sql-wasm.js': 9000 },
  });

  pruneSqlJsDist(root);

  assert.deepEqual(readdirSync(join(pkgDir, 'dist')), ['sql-asm.js']);
});

test('refuses to leave a package whose declared entry point is missing', () => {
  installFakeSqlJs(root, {
    packageJson: { name: 'sql.js', main: './dist/sql-wasm.js' },
    dist: { 'sql-asm.js': 9000 },
  });

  assert.throws(() => pruneSqlJsDist(root), /sql-wasm\.js/);
});
