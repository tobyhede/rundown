// packages/cli/src/services/discovery.ts

import * as fs from 'fs/promises';
import * as path from 'path';
import { extractFrontmatter, nameFromFilename } from '@rundown/parser';

/**
 * Metadata for a discovered runbook file.
 * Contains information about the runbook's location, source, and frontmatter metadata.
 */
export interface DiscoveredRunbook {
  /** Runbook name from frontmatter or derived from filename */
  name: string;
  /** Absolute path to the runbook file */
  path: string;
  /** Source directory where the runbook was found */
  source: 'project' | 'plugin';
  /** Optional description from frontmatter */
  description?: string;
  /** Optional tags from frontmatter for filtering */
  tags?: string[];
}

/**
 * Search path with source information
 */
interface SearchPath {
  path: string;
  source: 'project' | 'plugin';
}

/**
 * Get search paths for runbooks.
 * Returns project directory first (takes precedence), then plugin directory.
 * @param cwd - Current working directory
 * @returns Array of search paths with source information
 */
export function getSearchPaths(cwd: string): SearchPath[] {
  const paths: SearchPath[] = [];

  // Project runbooks directory
  const projectRunbooksDir = path.join(cwd, '.claude', 'rundown', 'runbooks');
  paths.push({
    path: projectRunbooksDir,
    source: 'project',
  });

  // Plugin runbooks directory (from CLAUDE_PLUGIN_ROOT environment variable)
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (pluginRoot) {
    const pluginRunbooksDir = path.join(pluginRoot, 'runbooks');
    paths.push({
      path: pluginRunbooksDir,
      source: 'plugin',
    });
  }

  return paths;
}

/**
 * Scan a directory for *.runbook.md files and extract metadata.
 * Files that cannot be read or parsed are silently skipped.
 * Returns empty array if directory doesn't exist or cannot be read.
 * @param dirPath - Directory path to scan
 * @param source - Source type for discovered runbooks
 * @returns Array of discovered runbooks with extracted metadata
 */
export async function scanDirectory(dirPath: string, source: 'project' | 'plugin'): Promise<DiscoveredRunbook[]> {
  const runbooks: DiscoveredRunbook[] = [];

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.runbook.md')) continue;

      try {
        const filePath = path.join(dirPath, entry.name);
        const content = await fs.readFile(filePath, 'utf-8');
        const { frontmatter } = extractFrontmatter(content);

        // Match by frontmatter name or filename stem
        const runbookName = frontmatter?.name ?? nameFromFilename(entry.name);

        runbooks.push({
          name: runbookName,
          path: filePath,
          source,
          description: frontmatter?.description,
          tags: frontmatter?.tags,
        });
      } catch {
        // Skip files that can't be read or parsed
        continue;
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
    return [];
  }

  return runbooks;
}

/**
 * Discover all runbooks from project and plugin directories.
 * Project runbooks take precedence over plugin runbooks with same name.
 * @param cwd - Current working directory
 * @returns Array of all discovered runbooks, deduplicated by name
 */
export async function discoverRunbooks(cwd: string): Promise<DiscoveredRunbook[]> {
  const searchPaths = getSearchPaths(cwd);
  const allRunbooks: DiscoveredRunbook[] = [];
  const seen = new Set<string>();

  for (const { path: dirPath, source } of searchPaths) {
    const runbooks = await scanDirectory(dirPath, source);

    for (const runbook of runbooks) {
      // Skip if already seen (project takes precedence over plugin)
      if (seen.has(runbook.name)) continue;

      allRunbooks.push(runbook);
      seen.add(runbook.name);
    }
  }

  return allRunbooks;
}

/**
 * Find a runbook by name.
 * Project runbooks take precedence over plugin runbooks.
 * @param cwd - Current working directory
 * @param name - Runbook name to search for
 * @returns The discovered runbook if found, or null if not found
 */
export async function findRunbookByName(cwd: string, name: string): Promise<DiscoveredRunbook | null> {
  const searchPaths = getSearchPaths(cwd);

  for (const { path: dirPath, source } of searchPaths) {
    const runbooks = await scanDirectory(dirPath, source);

    for (const runbook of runbooks) {
      if (runbook.name === name) {
        return runbook;
      }
    }
  }

  return null;
}
