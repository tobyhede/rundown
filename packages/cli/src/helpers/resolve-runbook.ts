import * as fs from 'fs/promises';
import * as path from 'path';
import { findRunbookByName } from '../services/discovery.js';
import { getBundledRunbooksPath } from './bundled-runbooks.js';

/**
 * Resolve runbook file by path (existing logic).
 * Search order:
 * 1. .claude/rundown/runbooks/ (project-local)
 * 2. $CLAUDE_PLUGIN_ROOT/runbooks/ (plugin directory)
 * 3. Relative to cwd
 * 4. Bundled runbooks (lowest priority)
 *
 * @param cwd - Current working directory
 * @param filename - Runbook filename to find
 * @returns Absolute path to runbook file, or null if not found
 */
async function resolveByPath(cwd: string, filename: string): Promise<string | null> {
  // 1. Check project-local .claude/rundown/runbooks/
  const localPath = path.join(cwd, '.claude/rundown/runbooks', filename);
  try {
    await fs.access(localPath);
    return localPath;
  } catch { /* not found */ }

  // 2. Check plugin runbooks directory
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (pluginRoot) {
    const pluginPath = path.join(pluginRoot, 'runbooks', filename);
    try {
      await fs.access(pluginPath);
      return pluginPath;
    } catch { /* not found */ }
  }

  // 3. Check relative to cwd
  const relativePath = path.join(cwd, filename);
  try {
    await fs.access(relativePath);
    return relativePath;
  } catch { /* not found */ }

  // 4. Check bundled runbooks (lowest priority)
  const bundledPath = path.join(getBundledRunbooksPath(), filename);
  try {
    await fs.access(bundledPath);
    return bundledPath;
  } catch { /* not found */ }

  return null;
}

/**
 * Detect if identifier is path-based or name-based.
 * Path mode: contains '/' or ends with '.md'
 * Name mode: plain identifier (e.g., "verify")
 *
 * @param identifier - Workflow identifier
 * @returns true if path-based, false if name-based
 */
function isPathIdentifier(identifier: string): boolean {
  return identifier.includes('/') || identifier.endsWith('.md');
}

/**
 * Resolve runbook file from multiple sources.
 * Supports both path-based and name-based resolution:
 * - Path mode: .claude/rundown/runbooks/file.md, ./path/to/file.md, etc.
 * - Name mode: "verify", "my-runbook", etc.
 *
 * Search order for path mode:
 * 1. .claude/rundown/runbooks/ (project-local)
 * 2. $CLAUDE_PLUGIN_ROOT/runbooks/ (plugin directory)
 * 3. Relative to cwd
 *
 * Search order for name mode:
 * 1. Project runbooks directory
 * 2. Plugin runbooks directory
 *
 * @param cwd - Current working directory
 * @param identifier - Runbook filename or name to find
 * @returns Absolute path to runbook file, or null if not found
 * @throws May throw filesystem errors if directory access fails unexpectedly
 */
export async function resolveRunbookFile(cwd: string, identifier: string): Promise<string | null> {
  // Detect if identifier is path-based or name-based
  if (isPathIdentifier(identifier)) {
    // Path-based resolution: use existing logic
    return resolveByPath(cwd, identifier);
  } else {
    // Name-based resolution: use discovery service
    const discovered = await findRunbookByName(cwd, identifier);
    return discovered ? discovered.path : null;
  }
}
