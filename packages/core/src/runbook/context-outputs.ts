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

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { contextOutputsPath } from '../paths.js';
import { isNodeError } from '../errors.js';

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
 * the directory if it does not exist.
 *
 * @param cwd - Project root directory
 * @param contextId - Context identifier shared across the delegation tree
 * @param outputs - New key-value pairs to publish
 * @throws {Error} If the directory cannot be created or the file cannot be written
 */
export async function storeContextOutputs(
  cwd: string,
  contextId: string,
  outputs: Record<string, string>,
): Promise<void> {
  const filePath = contextOutputsPath(cwd, contextId);
  const dir = path.dirname(filePath);

  await fs.mkdir(dir, { recursive: true });

  // Merge with existing outputs (existing wins for already-set keys only if we want idempotency;
  // new outputs overwrite old ones for the same key — caller controls what they publish)
  const existing = await loadContextOutputs(cwd, contextId);
  const merged = { ...existing, ...outputs };

  await fs.writeFile(filePath, JSON.stringify(merged, null, 2), 'utf-8');
}
