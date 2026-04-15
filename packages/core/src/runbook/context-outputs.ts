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
import * as path from 'node:path';
import { isNodeError } from '../errors.js';
import { contextOutputsLockPath, contextOutputsPath, locksDir } from '../paths.js';
import { acquireFileLock, releaseFileLock } from './file-lock.js';

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
 */
export async function loadContextOutputs(
  cwd: string,
  contextId: string,
): Promise<Record<string, string>> {
  const filePath = contextOutputsPath(cwd, contextId);

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
    return {};
  }

  // Coerce to Record<string, string> — keep only string-valued entries
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(parsed)) {
    if (typeof val === 'string') {
      result[key] = val;
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
 * @param cwd - Project root directory
 * @param contextId - Context identifier shared across the delegation tree
 * @param outputs - New key-value pairs to publish
 * @throws {Error} If the directory cannot be created or the file cannot be written
 * @throws {Error} If the lock cannot be acquired within 5 seconds
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
    await fs.mkdir(dir, { recursive: true });

    // read-merge-write must stay inside the lock — moving loadContextOutputs out would
    // reintroduce the race where two writers read the same stale snapshot.
    const existing = await loadContextOutputs(cwd, contextId);
    const merged = { ...existing, ...outputs };

    // Atomic write: write to a temp file then rename to prevent partial-write corruption.
    // Use a cryptographically random suffix and O_CREAT | O_EXCL (flag: 'wx') so a
    // pre-existing file or symlink at the tmp path cannot be silently followed/overwritten.
    const tmp = `${filePath}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(merged, null, 2), {
        encoding: 'utf-8',
        flag: 'wx',
      });
      await fs.rename(tmp, filePath);
    } catch (err) {
      // Clean up temp file on failure (best-effort)
      await fs.unlink(tmp).catch(() => undefined);
      throw err;
    }
  } finally {
    await releaseFileLock(lockFile);
  }
}
