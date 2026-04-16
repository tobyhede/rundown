// packages/core/src/runbook/context-outputs.ts

/**
 * Context output storage for runbook-to-runbook context passing.
 *
 * Outputs are keyed by ContextId and stored as simple string key-value pairs in
 * `.rundown/contexts/{contextId}/outputs.json`. Any runbook sharing the same
 * ContextId (via delegation inheritance) can read and augment context outputs.
 *
 * @module
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import { isNodeError } from '../errors.js';
import { logger } from '../logger.js';
import { contextOutputsLockPath, contextOutputsPath, contextsDir, locksDir } from '../paths.js';
import { acquireFileLock, releaseFileLock } from './file-lock.js';

/**
 * Resolve a path through symlinks and assert it stays inside `contextsDir`.
 *
 * The id-string check ({@link assertSafeId}) blocks `..`, `.`, and unsafe
 * characters but cannot detect a *symlink* placed at `.rundown/contexts/<id>`
 * by another process or user that points outside the project root. This guard
 * is the runtime defense for that case. Symlink-resolution-on-write is a
 * trust-boundary check: `.rundown/` is a per-project trust root, but multi-user
 * CI setups or shared volumes can violate that assumption.
 *
 * @param target - Path to validate (typically the per-context outputs directory)
 * @param cwd    - Project root directory used to anchor the contexts root
 * @throws {Error} when the resolved path escapes `contextsDir(cwd)`
 */
async function assertPathInsideContextsDir(target: string, cwd: string): Promise<void> {
  const root = await fs.realpath(contextsDir(cwd)).catch(() => contextsDir(cwd));
  let resolved: string;
  try {
    resolved = await fs.realpath(target);
  } catch (err) {
    // ENOENT is fine — the target hasn't been created yet, no symlink to follow.
    if (isNodeError(err) && err.code === 'ENOENT') return;
    throw err;
  }
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `Refusing to access context outputs: resolved path "${resolved}" escapes contexts directory "${root}"`,
    );
  }
}

/**
 * Load context outputs for a given context ID.
 *
 * Returns an empty object if the outputs file does not exist yet — this is
 * the normal state before any runbook in the context has produced outputs.
 *
 * @param cwd - Project root directory
 * @param contextId - Context identifier shared across the delegation tree
 * @returns Record of variable names to their string values
 * @throws {Error} If the file exists but cannot be read or parsed as JSON
 * @throws {Error} If the parsed JSON is not a plain object (e.g. array, null, primitive)
 */
export async function loadContextOutputs(
  cwd: string,
  contextId: string,
): Promise<Record<string, string>> {
  const filePath = contextOutputsPath(cwd, contextId);
  const dir = path.dirname(filePath);
  await assertPathInsideContextsDir(dir, cwd);

  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return {};
    }
    throw err;
  }

  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    const shape = Array.isArray(parsed) ? 'array' : parsed === null ? 'null' : typeof parsed;
    throw new Error(
      `outputs.json has unexpected top-level shape (expected JSON object, got ${shape}) at ${filePath}`,
    );
  }

  // Coerce to Record<string, string> — keep only string-valued entries.
  // Non-string values are dropped with a warning so corruption or schema drift
  // is visible rather than silently hiding data.
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(parsed)) {
    if (typeof val === 'string') {
      result[key] = val;
    } else {
      void logger.warn('context outputs: dropping non-string value', {
        key,
        type: typeof val,
        filePath,
      });
    }
  }
  return result;
}

/**
 * Store context outputs for a given context ID.
 *
 * Merges new outputs into any existing outputs (additive, not replace). Creates
 * the directory if it does not exist. The write is atomic (write-then-rename) to
 * prevent partial-write corruption on crash.
 *
 * Concurrent callers sharing the same `contextId` are serialized with a file
 * lock under `.rundown/locks/ctx-<contextId>.context-outputs.lock` so that no
 * read-merge-write entries are lost to a race.
 *
 * @remarks
 * **TOCTOU race defense (two-layer):**
 * - **Layer A:** Tmp file is opened with `O_NOFOLLOW` (on Unix) to prevent symlink
 *   planting at the temporary path from bypassing write permissions.
 * - **Layer B:** Directory inode is captured before `mkdir` and again after `rename`.
 *   A mismatch (or post-rename symlink) indicates the directory was swapped for an
 *   escaping symlink during the write window; the final file is unlinked and an error
 *   is thrown. Post-rename realpath re-validation confirms the final path still
 *   resolves inside the contexts root.
 *
 * @param cwd - Project root directory
 * @param contextId - Context identifier shared across the delegation tree
 * @param outputs - New key-value pairs to publish
 * @throws {Error} If the directory cannot be created or the file cannot be written
 * @throws {Error} If the lock cannot be acquired within 5 seconds
 * @throws {Error} If context directory is swapped for a symlink during write
 */
export async function storeContextOutputs(
  cwd: string,
  contextId: string,
  outputs: Record<string, string>,
): Promise<void> {
  const filePath = contextOutputsPath(cwd, contextId);
  const dir = path.dirname(filePath);
  const lockFile = contextOutputsLockPath(cwd, contextId);
  const lockDir = locksDir(cwd);

  await acquireFileLock(lockFile, lockDir);
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });

    // After mkdir, verify the directory hasn't been swapped for a symlink that
    // escapes the contexts root. assertSafeId blocks traversal in the id string
    // but not a malicious pre-existing symlink at the directory path.
    await assertPathInsideContextsDir(dir, cwd);

    // Capture directory inode before write (Layer B defense start).
    const statBefore = await fs.lstat(dir);

    // Layer B: Pre-validate that the final outputs file path, if it exists, is not
    // a symlink (which would indicate it's escaping). This check happens before we
    // attempt to read, preventing silent symlink-following in loadContextOutputs.
    try {
      const statFile = await fs.lstat(filePath);
      if (statFile.isSymbolicLink()) {
        throw new Error(
          `context outputs file for "${contextId}" is a symlink (escapes contexts directory)`,
        );
      }
    } catch (err) {
      // ENOENT is fine — file doesn't exist yet.
      if (!isNodeError(err) || err.code !== 'ENOENT') {
        throw err;
      }
    }

    // read-merge-write must stay inside the lock — moving loadContextOutputs out would
    // reintroduce the race where two writers read the same stale snapshot.
    const existing = await loadContextOutputs(cwd, contextId);
    const merged = { ...existing, ...outputs };

    // Atomic write: write to a temp file then rename to prevent partial-write corruption.
    // Layer A: Use O_NOFOLLOW (on Unix) to prevent symlink planting at the tmp path.
    // Use a cryptographically random suffix and O_CREAT | O_EXCL so a pre-existing
    // file or symlink at the tmp path cannot be silently followed/overwritten.
    const tmp = `${filePath}.${randomBytes(8).toString('hex')}.tmp`;
    const openFlags =
      fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      (process.platform !== 'win32' ? fsConstants.O_NOFOLLOW : 0);

    try {
      const handle = await fs.open(tmp, openFlags, 0o600);
      try {
        await handle.writeFile(JSON.stringify(merged, null, 2));
      } finally {
        await handle.close();
      }

      await fs.rename(tmp, filePath);

      // Layer B: Check directory inode after rename. If it changed or became a symlink,
      // the directory was swapped for an escaping symlink. Unlink the final file and reject.
      const statAfter = await fs.lstat(dir);
      if (statBefore.ino !== statAfter.ino || statAfter.isSymbolicLink()) {
        await fs.unlink(filePath).catch(() => {});
        throw new Error(`context directory for "${contextId}" was replaced during write`);
      }

      // Re-validate that the final path still resolves inside contexts/.
      await assertPathInsideContextsDir(dir, cwd);
    } catch (err) {
      // Clean up temp file on failure (best-effort)
      await fs.unlink(tmp).catch(() => undefined);
      throw err;
    }
  } finally {
    await releaseFileLock(lockFile);
  }
}
