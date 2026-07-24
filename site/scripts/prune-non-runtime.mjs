/**
 * Drop files nothing in the snapshot can execute from a `node_modules` tree.
 *
 * The WebContainer snapshot packs an entire `node_modules` into ONE static
 * asset, and Cloudflare Pages rejects any single file over 25 MiB. Inside that
 * asset there is no `tsc`, no bundler and no devtools: type declarations,
 * published TypeScript sources, source maps and package docs are weight against
 * a hard ceiling and nothing else. Source maps are doubly dead — they name
 * `../src/*` sources that the tarballs they ship in never publish.
 *
 * Two things are deliberately NOT pruned:
 *
 * - **`runbooks/` trees**, entirely. `@rundown-org/cli` ships its bundled
 *   runbooks as `.runbook.md` under `dist/runbooks/`; those are runtime data
 *   that happens to be markdown, and a filename-shaped rule would eventually
 *   catch one. The directory is off limits rather than filtered.
 * - **Licence and notice texts.** The snapshot redistributes third-party code
 *   to every visitor, which is exactly the case those notices exist for.
 *
 * TypeScript pruning is gated per package on the package's own manifest: a
 * source-first package that resolves to `.ts` at runtime keeps its sources,
 * mirroring how {@link module:site/scripts/prune-sqljs} derives its keep-set
 * from `main`/`exports` rather than hardcoded filenames.
 *
 * See issue #639.
 *
 * @module site/scripts/prune-non-runtime
 */

import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Directory names that are not packages and hold nothing worth pruning. */
const SKIP_DIRS = new Set(['.bin', '.cache']);

/** Directory names holding runtime data, never descended into. */
const KEEP_DIRS = new Set(['runbooks']);

/** Source maps: dangling references to sources no tarball ships. */
const SOURCE_MAP = /\.map$/;

/** TypeScript, declarations and `.tsx` included. Nothing in the snapshot compiles. */
const TYPESCRIPT = /\.(c|m)?tsx?$/;

/**
 * Package docs, matched only with a documentation extension or none.
 *
 * The extension is anchored to a doc-shaped set rather than "anything", because
 * `history.js` and `changes.json` are ordinary modules a package requires
 * internally — never declared entry points, so nothing else here would protect
 * them — and deleting one is a runtime `MODULE_NOT_FOUND` in the browser.
 * Licence and notice texts are deliberately absent from the name set.
 */
const PACKAGE_DOC =
  /^(readme|changelog|changes|history|contributing|contributors|authors)(\.(md|markdown|mdown|txt|rst|adoc))?$/i;

/**
 * Export conditions the snapshot's Node can actually resolve.
 *
 * Everything else in an `exports` map is opt-in for a specific consumer —
 * `@zod/source` points at `./src/index.ts` for bundlers configured to ask for
 * it — and unreachable from a plain `import`/`require` inside WebContainer.
 */
const RESOLVABLE_CONDITIONS = new Set([
  'node',
  'node-addons',
  'import',
  'require',
  'default',
  'development',
  'production',
]);

/**
 * Collect every path a package declares as runnable *here*.
 *
 * `main`, `bin` and the `exports` leaves reachable under
 * {@link RESOLVABLE_CONDITIONS} are what a resolver in the snapshot can land
 * on. Three exclusions are deliberate: `types`, because it is compiler-facing
 * and nothing here type-checks; `module`, because it is bundler metadata Node
 * never resolves; and bundler-specific export conditions, because honouring
 * them protects sources no import in the demo can reach.
 *
 * @param {{ main?: unknown, exports?: unknown, bin?: unknown }} packageJson - Parsed package.json.
 * @returns {string[]} Declared targets, as written (e.g. `./dist/index.js`).
 */
function declaredTargets(packageJson) {
  /** @type {string[]} */
  const targets = [];

  /** @param {unknown} node - A `main`/`bin` value: string, or map of names to strings. */
  const walkPaths = (node) => {
    if (typeof node === 'string') {
      targets.push(node);
      return;
    }
    if (node && typeof node === 'object') {
      for (const value of Object.values(node)) {
        walkPaths(value);
      }
    }
  };

  /** @param {unknown} node - An `exports` subtree: subpath map, condition map, fallback array or string. */
  const walkExports = (node) => {
    if (typeof node === 'string') {
      targets.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const value of node) {
        walkExports(value);
      }
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        // Subpath keys ('.', './mini') name exports; anything else is a
        // condition, and only the resolvable ones count.
        if (key.startsWith('.') || RESOLVABLE_CONDITIONS.has(key)) {
          walkExports(value);
        }
      }
    }
  };

  walkPaths(packageJson.main);
  walkPaths(packageJson.bin);
  walkExports(packageJson.exports);

  return targets;
}

/**
 * Read a package's manifest, tolerating its absence.
 *
 * Directories under `node_modules` that carry no manifest (`.bin`, leftovers)
 * are still walked — they simply declare nothing.
 *
 * @param {string} pkgDir - Package directory.
 * @returns {Record<string, unknown>} Parsed manifest, or an empty object.
 */
function readManifest(pkgDir) {
  try {
    return JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Locate the package directories directly installed in a `node_modules`.
 *
 * Scoped packages live one level deeper (`@scope/name`), which is why this
 * cannot be a flat listing.
 *
 * @param {string} nodeModulesDir - A `node_modules` directory.
 * @returns {string[]} Absolute package directory paths.
 */
function installedPackages(nodeModulesDir) {
  /** @type {string[]} */
  const packages = [];
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = readdirSync(nodeModulesDir, { withFileTypes: true });
  } catch {
    return packages;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const child = join(nodeModulesDir, entry.name);
    if (entry.name.startsWith('@')) {
      for (const scoped of readdirSync(child, { withFileTypes: true })) {
        if (scoped.isDirectory()) {
          packages.push(join(child, scoped.name));
        }
      }
      continue;
    }
    packages.push(child);
  }

  return packages;
}

/**
 * Prune one installed package.
 *
 * @param {string} pkgDir - Package directory.
 * @param {string[]} queue - Nested `node_modules` directories found, appended in place.
 * @returns {{ bytesRemoved: number, filesRemoved: number }} What this package gave up.
 */
function prunePackage(pkgDir, queue) {
  const targets = declaredTargets(readManifest(pkgDir));
  const protectedPaths = new Set(
    targets.filter((target) => !target.includes('*')).map((target) => resolve(pkgDir, target)),
  );
  // A package that resolves to TypeScript at runtime keeps its sources: the
  // entry point alone is useless without the modules it imports.
  const prunesTypeScript = !targets.some((target) => TYPESCRIPT.test(target));

  let bytesRemoved = 0;
  let filesRemoved = 0;

  /** @param {string} dir - Directory to walk. */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') {
          queue.push(child);
        } else if (!KEEP_DIRS.has(entry.name)) {
          walk(child);
        }
        continue;
      }
      if (!entry.isFile() || protectedPaths.has(child)) {
        continue;
      }
      const removable =
        SOURCE_MAP.test(entry.name) ||
        (prunesTypeScript && TYPESCRIPT.test(entry.name)) ||
        PACKAGE_DOC.test(entry.name);
      if (!removable) {
        continue;
      }
      bytesRemoved += statSync(child).size;
      filesRemoved += 1;
      rmSync(child, { force: true });
    }
  };

  walk(pkgDir);

  return { bytesRemoved, filesRemoved };
}

/**
 * Prune every package installed beneath a `node_modules` tree.
 *
 * @param {string} nodeModulesDir - The snapshot's `node_modules` directory.
 * @returns {{ bytesRemoved: number, filesRemoved: number }} Total reclaimed.
 */
export function pruneNonRuntimeFiles(nodeModulesDir) {
  const queue = [nodeModulesDir];
  let bytesRemoved = 0;
  let filesRemoved = 0;

  while (queue.length > 0) {
    const current = /** @type {string} */ (queue.pop());
    for (const pkgDir of installedPackages(current)) {
      const pruned = prunePackage(pkgDir, queue);
      bytesRemoved += pruned.bytesRemoved;
      filesRemoved += pruned.filesRemoved;
    }
  }

  return { bytesRemoved, filesRemoved };
}
