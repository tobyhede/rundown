import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isNodeError } from '../errors.js';
import { assertSafeId } from '../paths.js';
import { assembleArtifactPath } from './artifact-paths.js';

const TRAVERSAL_PATTERN = /(?:^|[/\\])\.\.(?:$|[/\\])/;
const RDPATH_CTX_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Options for assembling an `rdpath` output path.
 */
export interface RdPathOptions {
  /** Base directory where the path should be assembled. */
  readonly dir: string;
  /** Optional dot-free context id used to select a `.rd-<ctx>` directory. */
  readonly ctx?: string;
  /** Optional safe artifact-style file name to date-prefix. */
  readonly file?: string;
}

/**
 * Options for searching files under an `rdpath` directory.
 */
export interface RdPathFindOptions {
  /** Base directory to search from. */
  readonly dir: string;
  /** Optional dot-free context id used to search within `.rd-<ctx>`. */
  readonly ctx?: string;
}

/**
 * Validate a context id for `rdpath` directory naming.
 *
 * @param ctx - Candidate context id.
 * @throws {Error} If the context id contains characters outside the `rdpath` safe set.
 */
export function validateRdPathCtx(ctx: string): void {
  if (!RDPATH_CTX_PATTERN.test(ctx)) {
    throw new Error(`Invalid ctx: must match ${RDPATH_CTX_PATTERN.source}`);
  }
}

/**
 * Validate a file name for `rdpath` output.
 *
 * @param file - Candidate file name.
 * @throws {Error} If the file name is not a safe artifact identifier.
 */
export function validateRdPathFile(file: string): void {
  try {
    assertSafeId(file, 'file');
  } catch {
    throw new Error('Invalid file: must be a safe artifact identifier');
  }
}

/**
 * Resolve the base directory for an `rdpath` operation.
 *
 * @param dir - Base directory supplied by the caller.
 * @param ctx - Optional context id for `.rd-<ctx>` scoping.
 * @returns The resolved base directory path.
 * @throws {Error} If `ctx` is not valid for `rdpath`.
 */
export function resolveRdPathBaseDir(dir: string, ctx?: string): string {
  if (ctx !== undefined) {
    validateRdPathCtx(ctx);
    return path.join(dir, `.rd-${ctx}`);
  }
  return dir;
}

/**
 * Assemble an `rdpath` directory or date-prefixed file path.
 *
 * @param options - Directory, optional context, and optional file components.
 * @returns The assembled path.
 * @throws {Error} If any supplied context or file component is unsafe.
 */
export function assembleRdPath(options: RdPathOptions): string {
  const resolved = resolveRdPathBaseDir(options.dir, options.ctx);
  if (options.file === undefined) return resolved;
  if (options.ctx !== undefined) {
    return assembleArtifactPath(options.dir, options.ctx, options.file);
  }
  validateRdPathFile(options.file);
  const date = new Date().toISOString().slice(0, 10);
  return path.join(resolved, `${date}-${options.file}`);
}

/**
 * Find files below an `rdpath` directory without allowing traversal or symlink escapes.
 *
 * @param options - Directory and optional context that define the search root.
 * @param pattern - Relative glob pattern to match.
 * @returns Matching file paths constrained to the resolved search root.
 * @throws {Error} If the pattern is absolute, traverses upward, or the directory is invalid.
 */
export async function findRdPathFiles(
  options: RdPathFindOptions,
  pattern: string,
): Promise<string[]> {
  if (path.isAbsolute(pattern)) {
    throw new Error('Invalid pattern: must be relative to the target directory');
  }
  if (TRAVERSAL_PATTERN.test(pattern)) {
    throw new Error('Invalid pattern: must not contain ".." path segments');
  }

  const resolvedDir = resolveRdPathBaseDir(options.dir, options.ctx);
  const absoluteDir = path.resolve(resolvedDir);
  const stat = await fs.stat(absoluteDir).catch((error: unknown) => {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new Error(`Directory not found: ${resolvedDir}`);
    }
    throw error;
  });
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${resolvedDir}`);
  }

  const realDir = await fs.realpath(absoluteDir);
  const matches: string[] = [];
  for await (const match of fs.glob(pattern, { cwd: absoluteDir })) {
    const absoluteMatch = path.resolve(absoluteDir, match);
    try {
      const realMatch = await fs.realpath(absoluteMatch);
      if (!isPathInside(realDir, realMatch)) continue;
      const matchStat = await fs.lstat(realMatch);
      if (matchStat.isFile()) {
        matches.push(path.join(resolvedDir, match));
      }
    } catch (error) {
      if (
        isNodeError(error) &&
        ['ENOENT', 'EACCES', 'EPERM', 'ELOOP'].includes(String(error.code))
      ) {
        continue;
      }
      throw error;
    }
  }
  return matches.sort();
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
