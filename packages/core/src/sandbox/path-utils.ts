/**
 * Shared path helpers for sandbox policy construction.
 *
 * @module
 */

import { dirname, sep } from 'node:path';

/**
 * Collect each path plus its non-root ancestor directories.
 *
 * @param paths - Concrete paths that need metadata traversal support.
 * @returns Unique paths and ancestors ordered from shortest to longest.
 */
export function collectAncestorPaths(paths: readonly string[]): string[] {
  const ancestors = new Set<string>(paths);
  for (const candidate of paths) {
    let current = dirname(candidate);
    while (current !== dirname(current)) {
      ancestors.add(current);
      current = dirname(current);
    }
  }
  ancestors.delete(sep);
  return [...ancestors].sort((a, b) => a.length - b.length);
}
