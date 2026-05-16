/**
 * Helper registry for user-defined template transformation functions.
 *
 * Loads synchronous `(value: string) => string` functions from explicitly
 * declared JS/ESM modules. The registry is read-only after startup.
 *
 * @module
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { types } from 'node:util';
import { pathToFileURL } from 'node:url';
import { RESERVED_TEMPLATE_HELPER_NAMES, detectTemplateHelperCollisions } from '@rundown-org/core';

/**
 * Map of helper name to synchronous transformation function.
 * Read-only after {@link loadHelperModules} completes.
 */
export type HelperRegistry = ReadonlyMap<string, (value: string) => string>;

/**
 * Validate a helper module path is within the project root.
 *
 * Resolves the path relative to `cwd`, then canonicalises with `realpath`
 * (falls back to the resolved path if the file does not yet exist).
 * Returns the canonical path when valid, or `null` when the path escapes
 * the project root.
 *
 * @param rawPath - Path as declared in config or CLI flag
 * @param cwd - Working directory for relative path resolution
 * @param projectRoot - Canonical project root (pre-resolved)
 * @returns Canonical absolute path, or null if traversal is detected
 */
export async function validateHelperPath(
  rawPath: string,
  cwd: string,
  projectRoot: string,
): Promise<string | null> {
  // Canonicalize projectRoot (handles macOS /var → /private/var symlinks)
  let canonicalRoot = projectRoot;
  try {
    canonicalRoot = await fs.realpath(projectRoot);
  } catch {
    // If root doesn't exist, use as-is
  }

  // Absolute paths that don't exist are passed through to fail at import time.
  // Absolute paths that do exist are validated via realpath below.
  const resolved = path.resolve(cwd, rawPath);

  let canonical = resolved;
  try {
    canonical = await fs.realpath(resolved);
  } catch {
    // File doesn't exist — canonicalize the nearest existing ancestor so the
    // comparison is valid even on macOS where /var is a symlink to /private/var.
    const dir = path.dirname(resolved);
    let canonicalDir = dir;
    try {
      canonicalDir = await fs.realpath(dir);
    } catch {
      // For relative source paths, try to resolve cwd to canonicalize symlinks
      // (e.g. macOS /tmp → /private/tmp) without remapping the basename.
      // For absolute source paths we do NOT fall back to cwd: an absolute path
      // whose directory doesn't exist should fail the traversal guard as-is.
      if (!path.isAbsolute(rawPath)) {
        try {
          canonicalDir = await fs.realpath(cwd);
        } catch {
          // use dir as-is
        }
      }
    }
    canonical = path.join(canonicalDir, path.basename(resolved));
  }

  // Apply traversal guard uniformly — covers both existing and non-existing files.
  const rel = path.relative(canonicalRoot, canonical);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    console.warn(`Warning: Helper path "${rawPath}" escapes project directory — skipping.`);
    return null;
  }
  return canonical;
}

/**
 * Load all helper modules from the given list of paths.
 *
 * Each module is loaded via dynamic `import()`. Named function exports become
 * helpers. Non-function exports, async functions, and reserved built-in helper
 * names are skipped with a warning. Module load failures are warned and skipped.
 *
 * @param paths - Absolute or project-relative paths to JS/ESM modules
 * @param cwd - Working directory for resolving relative paths
 * @param projectRoot - Canonical project root for traversal validation
 * @returns Populated read-only `HelperRegistry`
 */
export async function loadHelperModules(
  paths: readonly string[],
  cwd: string,
  projectRoot: string,
): Promise<HelperRegistry> {
  const registry = new Map<string, (value: string) => string>();

  for (const rawPath of paths) {
    const canonical = await validateHelperPath(rawPath, cwd, projectRoot);
    if (!canonical) continue;

    let mod: Record<string, unknown>;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      mod = await import(pathToFileURL(canonical).href);
    } catch (err) {
      console.warn(`Warning: Failed to load helper module "${rawPath}": ${String(err)}`);
      continue;
    }

    for (const [name, value] of Object.entries(mod)) {
      if (name === 'default') continue;

      if (RESERVED_TEMPLATE_HELPER_NAMES.has(name)) {
        console.warn(
          `Warning: Helper export "${name}" in "${rawPath}" uses a reserved name — "${name}" is reserved and cannot be overridden. Skipping.`,
        );
        continue;
      }

      if (typeof value !== 'function') {
        console.warn(
          `Warning: Helper export "${name}" in "${rawPath}" is not a function (got ${typeof value}) — skipping.`,
        );
        continue;
      }

      if (/^class[\s{]/.test(Function.prototype.toString.call(value))) {
        console.warn(
          `Warning: Helper export "${name}" in "${rawPath}" is a class — only synchronous functions are supported. Skipping.`,
        );
        continue;
      }

      if (types.isAsyncFunction(value)) {
        console.warn(
          `Warning: Helper export "${name}" in "${rawPath}" is an async function — only synchronous helpers are supported. Skipping.`,
        );
        continue;
      }

      // Sync functions that return a Promise (not caught by isAsyncFunction)
      // and helpers that return non-string values are validated at call time
      // by `invokeHelperSafely` in `@rundown-org/core`. Doing so here would
      // require running user code during CLI startup with a synthetic empty
      // string — a side-effect we deliberately defer until the helper is
      // actually invoked.
      registry.set(name, value as (value: string) => string);
    }
  }

  return registry;
}

/** Module-level singleton registry, installed at CLI startup. */
let _helperRegistry: HelperRegistry = new Map();

/**
 * Install the global helper registry.
 *
 * Called once at CLI startup after loading all declared helper modules.
 * The registry is read-only after this point.
 *
 * @param registry - Loaded helper registry
 */
export function setHelperRegistry(registry: HelperRegistry): void {
  _helperRegistry = registry;
}

/**
 * Get the current global helper registry.
 *
 * @returns The installed helper registry (empty map if not yet installed)
 */
export function getHelperRegistry(): HelperRegistry {
  return _helperRegistry;
}

/**
 * Reset the registry to empty (for testing only).
 */
export function resetHelperRegistry(): void {
  _helperRegistry = new Map();
}

/**
 * Detect variable names that collide with registered helper names.
 *
 * Called at startup after both variable resolution and registry loading complete.
 * Helper wins at resolution time; users must use `{{ ./VarName }}` to access a
 * shadowed variable.
 *
 * @param registry - Built helper registry
 * @param variables - Resolved template variable map
 * @returns Array of names that appear in both the registry and the variable map
 */
export const detectHelperCollisions = detectTemplateHelperCollisions;
