/**
 * Pure path assembly logic for the rdpath CLI tool.
 *
 * Builds artifact paths with optional context scoping and date-prefixed filenames.
 *
 * @module
 */

import * as path from 'node:path';

/** Valid context identifier: alphanumeric, hyphens, underscores. */
const VALID_CTX = /^[a-zA-Z0-9_-]+$/;

/** Valid filename: alphanumeric, dots, hyphens, underscores. */
const VALID_FILE = /^[a-zA-Z0-9._-]+$/;

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
 * @throws {Error} When ctx or file contains invalid characters or path traversal
 */
export function assemblePath(options: RdPathOptions): string {
  if (options.ctx != null && !VALID_CTX.test(options.ctx)) {
    throw new Error(`Invalid ctx: must match ${VALID_CTX.source}`);
  }
  if (options.file != null) {
    if (options.file === '..' || !VALID_FILE.test(options.file)) {
      throw new Error(`Invalid file: must match ${VALID_FILE.source}`);
    }
  }

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
