// packages/core/src/runbook/artifact-paths.ts

/**
 * Shared artifact path construction utilities.
 *
 * Provides validated, date-prefixed path assembly for context-scoped artifacts.
 * Consumed by the CLI template renderer and any other package that needs to
 * produce artifact paths compatible with the `rdpath` convention.
 *
 * @module
 */

import * as path from 'node:path';

/** Valid context identifier: alphanumeric, hyphens, underscores. */
export const VALID_CTX = /^[a-zA-Z0-9_-]+$/;

/** Valid artifact filename: alphanumeric, dots, hyphens, underscores. */
export const VALID_FILE = /^[a-zA-Z0-9._-]+$/;

/**
 * Validate a context identifier.
 *
 * @param ctx - The context identifier to validate
 * @throws {Error} When ctx contains invalid characters
 */
export function validateArtifactCtx(ctx: string): void {
  if (!VALID_CTX.test(ctx)) {
    throw new Error(`Invalid ctx: must match ${VALID_CTX.source}`);
  }
}

/**
 * Assemble a date-prefixed artifact path in the context scope.
 *
 * Produces: `<dir>/.rd-<ctx>/YYYY-MM-DD-<file>`
 *
 * This is identical to `rdpath --dir <dir> --ctx <ctx> --file <file>`.
 *
 * @param dir - Base directory for the artifact path
 * @param ctx - Context identifier — must match `VALID_CTX`
 * @param file - Filename — must match `VALID_FILE` and not be `..` or `.`
 * @returns The assembled artifact path
 * @throws {Error} When ctx or file fails validation
 */
export function assembleArtifactPath(dir: string, ctx: string, file: string): string {
  validateArtifactCtx(ctx);
  if (file === '..' || file === '.' || !VALID_FILE.test(file)) {
    throw new Error(`Invalid file: must match ${VALID_FILE.source}`);
  }
  const date = new Date().toISOString().slice(0, 10);
  return path.join(dir, `.rd-${ctx}`, `${date}-${file}`);
}
