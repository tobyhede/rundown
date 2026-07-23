/**
 * Drop unused sql.js build variants from a snapshot's `node_modules`.
 *
 * The WebContainer snapshot packs an entire `node_modules` tree into ONE static
 * asset, and Cloudflare Pages rejects any single file over 25 MiB. sql.js ships
 * every build variant it supports — asm.js fallbacks, debug builds, browser
 * variants and their workers, ~18 MB installed — while the driver loads one
 * entry point and its `.wasm` (~0.7 MB). Left intact, those variants alone put
 * the snapshot over the limit and fail the deploy.
 *
 * The keep-set is derived from the package's own `main`/`exports` rather than
 * hardcoded filenames, so a renamed entry point follows automatically instead of
 * silently deleting the file the driver actually loads.
 *
 * Note this DOES break deep imports (`sql.js/dist/<variant>`), which the package
 * permits via its `./dist/*` export. Nothing in Rundown uses them; a consumer
 * that starts to must widen the keep-set here.
 *
 * See issue #639: pruning buys headroom, it does not fix the snapshot's
 * standing proximity to the per-file limit.
 *
 * @module site/scripts/prune-sqljs
 */

import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

/** Directory names never worth descending into when locating installed copies. */
const SKIP_DIRS = new Set(['.bin', '.cache']);

/**
 * Collect every entry-point target a package declares for its root specifier.
 *
 * Reads `main` plus every string leaf under `exports['.']` (conditions may
 * nest). The wildcard `./dist/*` subpath export is deliberately NOT followed —
 * treating it as an entry point would keep the whole directory and defeat the
 * prune.
 *
 * @param {{ main?: string, exports?: unknown }} packageJson - Parsed package.json.
 * @returns {string[]} Declared targets, as written (e.g. `./dist/sql-wasm.js`).
 */
function declaredEntryPoints(packageJson) {
  const targets = [];
  if (typeof packageJson.main === 'string') {
    targets.push(packageJson.main);
  }

  const rootExport = /** @type {Record<string, unknown> | undefined} */ (
    packageJson.exports && typeof packageJson.exports === 'object'
      ? /** @type {Record<string, unknown>} */ (packageJson.exports)['.']
      : undefined
  );

  /** @param {unknown} node - Export condition subtree. */
  const walk = (node) => {
    if (typeof node === 'string') {
      targets.push(node);
      return;
    }
    if (node && typeof node === 'object') {
      for (const value of Object.values(node)) {
        walk(value);
      }
    }
  };
  walk(rootExport);

  return targets;
}

/**
 * Locate every installed `sql.js` package directory beneath a tree.
 *
 * npm hoists, but a conflicting range can leave a nested copy; each one carries
 * the same ~18 MB, so all of them must be pruned.
 *
 * @param {string} dir - Directory to search.
 * @returns {string[]} Absolute paths of `sql.js` package directories.
 */
function findSqlJsPackages(dir) {
  /** @type {string[]} */
  const found = [];
  /** @type {string[]} */
  const queue = [dir];

  while (queue.length > 0) {
    const current = /** @type {string} */ (queue.pop());
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) {
        continue;
      }
      const child = join(current, entry.name);
      if (entry.name === 'sql.js') {
        found.push(child);
        continue;
      }
      queue.push(child);
    }
  }

  return found;
}

/**
 * Prune one installed sql.js copy down to its declared entry points.
 *
 * @param {string} pkgDir - The `sql.js` package directory.
 * @returns {{ pkgDir: string, kept: string[], removed: string[], bytesRemoved: number }} What was kept and dropped.
 * @throws {Error} When a declared entry point is missing after pruning.
 */
function prunePackage(pkgDir) {
  const packageJson = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const distDir = join(pkgDir, 'dist');

  // Each entry point needs its same-named `.wasm` beside it: sql-wasm.js
  // resolves the binary by filename at runtime, so keeping the loader without
  // its payload yields a package that imports cleanly and then fails to init.
  const keep = new Set();
  for (const target of declaredEntryPoints(packageJson)) {
    const name = basename(target);
    keep.add(name);
    keep.add(name.replace(/\.js$/, '.wasm'));
  }

  /** @type {string[]} */
  const removed = [];
  let bytesRemoved = 0;
  for (const name of readdirSync(distDir)) {
    if (keep.has(name)) {
      continue;
    }
    const target = join(distDir, name);
    bytesRemoved += statSync(target).size;
    rmSync(target, { recursive: true, force: true });
    removed.push(name);
  }

  const remaining = new Set(readdirSync(distDir));
  for (const target of declaredEntryPoints(packageJson)) {
    const name = basename(target);
    if (!remaining.has(name)) {
      throw new Error(
        `sql.js at ${pkgDir} declares entry point ${target}, but dist/${name} is not present. ` +
          `Refusing to snapshot a package whose entry point cannot resolve.`,
      );
    }
  }

  return { pkgDir, kept: [...remaining].sort(), removed, bytesRemoved };
}

/**
 * Prune every installed sql.js copy in a snapshot's `node_modules`.
 *
 * Absence of sql.js is treated as an error, not a no-op: this runs on the path
 * that produces the deployed asset, and a prune that quietly did nothing would
 * ship an oversized snapshot that only fails later, in Cloudflare, at upload.
 *
 * @param {string} nodeModulesDir - The snapshot's `node_modules` directory.
 * @returns {{ packages: { pkgDir: string, kept: string[], removed: string[], bytesRemoved: number }[], bytesRemoved: number }} Per-package detail and the total reclaimed.
 * @throws {Error} When no sql.js is installed, or a declared entry point is missing.
 */
export function pruneSqlJsDist(nodeModulesDir) {
  const packages = findSqlJsPackages(nodeModulesDir).map(prunePackage);

  if (packages.length === 0) {
    throw new Error(
      `No sql.js package found under ${nodeModulesDir}. The snapshot prune expects one; ` +
        `a silent no-op would ship an oversized asset that fails at deploy time instead.`,
    );
  }

  return {
    packages,
    bytesRemoved: packages.reduce((total, pkg) => total + pkg.bytesRemoved, 0),
  };
}
