/**
 * Pure path assembly logic for the rdpath CLI tool.
 *
 * Builds artifact paths with optional context scoping and date-prefixed filenames.
 * Provides glob-based file discovery within artifact directories.
 *
 * @module
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { isNodeError } from './shared/errors.js';
import { isPathInside } from './shared/utils.js';

/** Valid context identifier: alphanumeric, hyphens, underscores. */
const VALID_CTX = /^[a-zA-Z0-9_-]+$/;

/** Valid filename: alphanumeric, dots, hyphens, underscores. */
const VALID_FILE = /^[a-zA-Z0-9._-]+$/;

/** Pattern containing `..` as a path segment (directory traversal). */
const TRAVERSAL_PATTERN = /(?:^|[/\\])\.\.(?:$|[/\\])/;

/**
 * Validate a context identifier.
 *
 * @param ctx - The context identifier to validate
 * @throws {Error} When ctx contains invalid characters
 */
export function validateCtx(ctx: string): void {
  if (!VALID_CTX.test(ctx)) {
    throw new Error(`Invalid ctx: must match ${VALID_CTX.source}`);
  }
}

/**
 * Resolve the base directory with optional context scoping.
 *
 * @param dir - Base directory path
 * @param ctx - Optional context identifier — appends `.rd-<ctx>/` subdirectory
 * @returns The resolved directory path
 */
export function resolveBaseDir(dir: string, ctx?: string): string {
  if (ctx) {
    return path.join(dir, `.rd-${ctx}`);
  }
  return dir;
}

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
  if (options.ctx != null) {
    validateCtx(options.ctx);
  }
  if (options.file != null) {
    if (options.file === '..' || options.file === '.' || !VALID_FILE.test(options.file)) {
      throw new Error(`Invalid file: must match ${VALID_FILE.source}`);
    }
  }

  const resolved = resolveBaseDir(options.dir, options.ctx);
  if (options.file) {
    const date = new Date().toISOString().slice(0, 10);
    return path.join(resolved, `${date}-${options.file}`);
  }
  return resolved;
}

/**
 * Options for finding files via glob pattern.
 */
export interface RdPathFindOptions {
  /** Base directory for the search. */
  dir: string;
  /** Optional context scope — searches within `.rd-<ctx>/` subdirectory. */
  ctx?: string;
}

/**
 * Find files matching a glob pattern within an artifact directory.
 *
 * Uses Node's built-in `fs.glob()` for cross-platform matching.
 * Results are filtered to prevent directory traversal and sorted lexicographically.
 *
 * @param options - Directory and optional context scope
 * @param pattern - Glob pattern to match files against
 * @returns Sorted array of matching file paths (relative to cwd, assembled with dir/ctx prefix)
 * @throws {Error} When ctx is invalid, pattern contains traversal, or directory doesn't exist
 */
export async function findFiles(options: RdPathFindOptions, pattern: string): Promise<string[]> {
  if (options.ctx != null) {
    validateCtx(options.ctx);
  }

  if (TRAVERSAL_PATTERN.test(pattern)) {
    throw new Error('Invalid pattern: must not contain ".." path segments');
  }

  const resolvedDir = resolveBaseDir(options.dir, options.ctx);
  const absoluteDir = path.resolve(resolvedDir);

  // Verify directory exists
  try {
    const stat = await fs.stat(absoluteDir);
    if (!stat.isDirectory()) {
      throw new Error(`Not a directory: ${resolvedDir}`);
    }
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new Error(`Directory not found: ${resolvedDir}`);
    }
    throw error;
  }

  // Collect glob matches
  const matches: string[] = [];
  for await (const match of fs.glob(pattern, { cwd: absoluteDir })) {
    const absoluteMatch = path.resolve(absoluteDir, match);
    if (isPathInside(absoluteDir, absoluteMatch)) {
      matches.push(path.join(resolvedDir, match));
    }
  }

  return matches.sort();
}
