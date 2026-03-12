/**
 * Pure path assembly logic for the rdpath CLI tool.
 *
 * Builds artifact paths with optional context scoping and date-prefixed filenames.
 *
 * @module
 */

import * as path from 'node:path';

/**
 * Options for assembling an artifact path.
 */
export interface RdPathOptions {
  /** Base directory for the artifact path. */
  dir: string;
  /** Optional context scope — creates a `.rd-<ctx>/` subdirectory. */
  ctx?: string;
  /** Optional filename to date-prefix (YYYY-MM-DD). */
  file?: string;
}

/**
 * Assemble an artifact path with optional context scoping and date-prefixed filename.
 *
 * @param options - Path assembly options
 * @returns The assembled path string
 */
export function assemblePath(options: RdPathOptions): string {
  const parts: string[] = [options.dir];
  if (options.ctx) {
    parts.push(`.rd-${options.ctx}`);
  }
  if (options.file) {
    const date = new Date().toISOString().slice(0, 10);
    parts.push(`${date}-${options.file}`);
  }
  return path.join(...parts);
}
