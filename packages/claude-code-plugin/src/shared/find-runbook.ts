/**
 * Runbook discovery utilities for gate modules.
 */

import * as fs from 'fs';
import * as path from 'path';
import { sanitizePathSegment } from './utils.js';
import { parseRunbookFromFrontmatter } from './frontmatter.js';

/**
 * Configuration for how to build the file path when searching for a runbook.
 */
export interface RunbookSearchConfig {
  /** Build the file path from a root dir and sanitized name */
  buildPath: (root: string, name: string) => string;
}

/**
 * Search for a runbook by parsing frontmatter from candidate files.
 * Searches plugin root first, then project directory.
 *
 * @param rawName - The raw command/skill name, possibly with namespace prefix
 * @param cwd - The current working directory
 * @param config - Configuration for building file paths
 * @returns The runbook path from frontmatter if found, undefined otherwise
 */
export function findRunbookByFrontmatter(
  rawName: string,
  cwd: string,
  config: RunbookSearchConfig
): string | undefined {
  const colonIndex = rawName.indexOf(':');
  const name = sanitizePathSegment(colonIndex >= 0 ? rawName.substring(colonIndex + 1) : rawName);

  const searchPaths: string[] = [];

  // Plugin root (via CLAUDE_PLUGIN_ROOT)
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (pluginRoot) {
    try {
      searchPaths.push(config.buildPath(pluginRoot, name));
    } catch {
      // Path traversal attempt - skip
    }
  }

  // Project directory
  try {
    searchPaths.push(config.buildPath(path.join(cwd, '.claude'), name));
  } catch {
    // Path traversal attempt - skip
  }

  for (const p of searchPaths) {
    try {
      const content = fs.readFileSync(p, 'utf8');
      const runbook = parseRunbookFromFrontmatter(content);
      if (runbook) return runbook;
    } catch {
      continue;
    }
  }

  return undefined;
}
