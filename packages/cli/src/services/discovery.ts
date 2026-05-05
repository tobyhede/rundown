// packages/cli/src/services/discovery.ts

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { extractFrontmatter, nameFromFilename } from '@rundown-org/parser';
import { runbooksDir, type RunbookSource } from '@rundown-org/core';
import { getBundledRunbooksPath } from '../helpers/bundled-runbooks.js';
import { getPluginRoot } from '../helpers/plugin-root.js';

/**
 * Normalize a name to a slug for lookup comparison.
 * Converts spaces to hyphens, lowercases, collapses repeated hyphens.
 *
 * @param name - The name to normalize
 * @returns Slug-normalized string for comparison
 */
function toSlug(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-').replace(/-+/g, '-');
}

/**
 * Metadata for a discovered runbook file.
 * Contains information about the runbook's location, source, and frontmatter metadata.
 */
export interface DiscoveredRunbook {
  /** Runbook name from frontmatter or derived from filename */
  name: string;
  /** Filename stem (without .runbook.md extension), always populated */
  filenameStem: string;
  /** Absolute path to the runbook file */
  path: string;
  /** Source directory where the runbook was found */
  source: RunbookSource;
  /** Source root used to derive persisted runbook identity */
  sourceRoot: string;
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
  source: RunbookSource;
  sourceRoot: string;
}

/**
 * Get search paths for runbooks.
 * Returns project directory first (takes precedence), then plugin directory, then bundled.
 * @param cwd - Current working directory
 * @returns Array of search paths with source information
 */
export function getSearchPaths(cwd: string): SearchPath[] {
  const paths: SearchPath[] = [];

  // Project runbooks directory (highest priority)
  const projectRunbooksDir = runbooksDir(cwd);
  paths.push({
    path: projectRunbooksDir,
    source: 'project',
    sourceRoot: cwd,
  });

  // Plugin runbooks directory (env var or sibling package discovery)
  const pluginRoot = getPluginRoot();
  if (pluginRoot) {
    const pluginRunbooksDir = path.join(pluginRoot, 'runbooks');
    paths.push({
      path: pluginRunbooksDir,
      source: 'plugin',
      sourceRoot: pluginRunbooksDir,
    });
  }

  // Bundled runbooks (lowest priority - fallback)
  const bundledRunbooksDir = getBundledRunbooksPath();
  paths.push({
    path: bundledRunbooksDir,
    source: 'bundled',
    sourceRoot: bundledRunbooksDir,
  });

  return paths;
}

/**
 * Scan a directory recursively for *.runbook.md files and extract metadata.
 * Files that cannot be read or parsed are silently skipped.
 * Returns empty array if directory doesn't exist or cannot be read.
 * @param dirPath - Directory path to scan
 * @param source - Source type for discovered runbooks
 * @returns Array of discovered runbooks with extracted metadata
 */
export async function scanDirectory(
  dirPath: string,
  source: RunbookSource,
  sourceRoot: string,
): Promise<DiscoveredRunbook[]> {
  const runbooks: DiscoveredRunbook[] = [];

  async function scanRecursive(currentPath: string): Promise<void> {
    try {
      const entries = await fs.readdir(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);

        if (entry.isDirectory()) {
          // Recursively scan subdirectories
          await scanRecursive(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.runbook.md')) {
          try {
            const content = await fs.readFile(fullPath, 'utf-8');
            const { frontmatter } = extractFrontmatter(content);

            const filenameStem = nameFromFilename(entry.name);
            const runbookName = frontmatter?.name ?? filenameStem;

            runbooks.push({
              name: runbookName,
              filenameStem,
              path: fullPath,
              source,
              sourceRoot,
              description: frontmatter?.description,
              tags: frontmatter?.tags,
            });
          } catch {}
        }
      }
    } catch {
      // Directory doesn't exist or can't be read
    }
  }

  await scanRecursive(dirPath);
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

  for (const { path: dirPath, source, sourceRoot } of searchPaths) {
    const runbooks = await scanDirectory(dirPath, source, sourceRoot);

    for (const runbook of runbooks) {
      // Skip if already seen (project takes precedence over plugin)
      const slug = toSlug(runbook.name);
      if (seen.has(slug)) continue;

      allRunbooks.push(runbook);
      seen.add(slug);
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
export async function findRunbookByName(
  cwd: string,
  name: string,
): Promise<DiscoveredRunbook | null> {
  const searchPaths = getSearchPaths(cwd);

  for (const { path: dirPath, source, sourceRoot } of searchPaths) {
    const runbooks = await scanDirectory(dirPath, source, sourceRoot);

    const lookupSlug = toSlug(name);
    for (const runbook of runbooks) {
      if (toSlug(runbook.name) === lookupSlug || toSlug(runbook.filenameStem) === lookupSlug) {
        return runbook;
      }
    }
  }

  return null;
}

/**
 * Find a runbook by name in a specific source.
 * Used for explicit namespace resolution (e.g., rundown:write-plan).
 * @param cwd - Current working directory
 * @param name - Runbook name to search for
 * @param targetSource - Source to search in ('project', 'plugin', or 'bundled')
 * @returns The discovered runbook if found, or null if not found
 */
export async function findRunbookByNameInSource(
  cwd: string,
  name: string,
  targetSource: RunbookSource,
): Promise<DiscoveredRunbook | null> {
  const searchPaths = getSearchPaths(cwd);

  for (const { path: dirPath, source, sourceRoot } of searchPaths) {
    // Only search in the specified source
    if (source !== targetSource) continue;

    const runbooks = await scanDirectory(dirPath, source, sourceRoot);

    const lookupSlug = toSlug(name);
    for (const runbook of runbooks) {
      if (toSlug(runbook.name) === lookupSlug || toSlug(runbook.filenameStem) === lookupSlug) {
        return runbook;
      }
    }
  }

  return null;
}
