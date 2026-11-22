// packages/cli/src/services/discovery.ts

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { extractFrontmatter, nameFromFilename } from '@rundown-org/parser';
import { runbooksDir } from '@rundown-org/core';
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
  source: 'project' | 'plugin' | 'bundled';
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
  source: 'project' | 'plugin' | 'bundled';
}

/**
 * The directories runbook resolution searches, in priority order.
 *
 * The runtime builds these from the process ({@link runtimeSearchRoots}); a
 * caller that must resolve a runbook the way a different workspace will — the
 * scenario suite staging a child before its case runs — supplies its own, so
 * both resolve through one implementation.
 */
export interface RunbookSearchRoots {
  /** The project's runbooks directory (`<project root>/.rundown/runbooks`), or null when there is none. */
  readonly project: string | null;
  /** The plugin root (`$CLAUDE_PLUGIN_ROOT`); its runbooks live under `<plugin>/runbooks`. */
  readonly plugin: string | null;
  /**
   * The directory a relative runbook path is tried against after the plugin —
   * where the CLI was invoked, which may be below the project root — or null
   * to skip it.
   */
  readonly cwd: string | null;
  /** The bundled runbooks directory, searched last. */
  readonly bundled: string;
}

/**
 * The search roots the runtime resolves runbooks from in this process.
 *
 * @param cwd - Project root (see `getProjectRoot`)
 * @param invocationDir - Directory a relative runbook path is tried against
 *   after the plugin: where the CLI was invoked. Defaults to the project root.
 * @returns Project runbooks under the project root, the plugin root, the
 *   invocation directory, and the bundled runbooks
 */
export function runtimeSearchRoots(cwd: string, invocationDir: string = cwd): RunbookSearchRoots {
  return {
    project: runbooksDir(cwd),
    plugin: getPluginRoot(),
    cwd: invocationDir,
    bundled: getBundledRunbooksPath(),
  };
}

/**
 * Scans one search directory for runbooks. {@link scanDirectory} is the
 * runtime's; a caller resolving many names over the same roots may pass a
 * memoised one.
 */
export type RunbookDirectoryScanner = (
  dirPath: string,
  source: 'project' | 'plugin' | 'bundled',
) => Promise<DiscoveredRunbook[]>;

function searchPathsFor(roots: RunbookSearchRoots): SearchPath[] {
  const paths: SearchPath[] = [];
  if (roots.project !== null) paths.push({ path: roots.project, source: 'project' });
  if (roots.plugin !== null) {
    paths.push({ path: path.join(roots.plugin, 'runbooks'), source: 'plugin' });
  }
  paths.push({ path: roots.bundled, source: 'bundled' });
  return paths;
}

/**
 * Get search paths for runbooks.
 * Returns project directory first (takes precedence), then plugin directory, then bundled.
 * @param cwd - Current working directory
 * @returns Array of search paths with source information
 */
export function getSearchPaths(cwd: string): SearchPath[] {
  return searchPathsFor(runtimeSearchRoots(cwd));
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
  source: 'project' | 'plugin' | 'bundled',
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

  for (const { path: dirPath, source } of searchPaths) {
    const runbooks = await scanDirectory(dirPath, source);

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
  return (await findRunbookByNameIn(runtimeSearchRoots(cwd), name))?.runbook ?? null;
}

/** A runbook name discovery found, with the search directory that held it. */
export interface DiscoveredInRoot {
  /** The discovered runbook. */
  readonly runbook: DiscoveredRunbook;
  /** The search directory scanned to find it: project, `<plugin>/runbooks` or bundled. */
  readonly searchRoot: string;
}

/**
 * Find a runbook by name over explicit search roots: the first runbook, in
 * project, plugin, bundled order and each directory's recursive `readdir`
 * order, whose frontmatter `name` or filename stem matches `name` as a slug.
 *
 * @param roots - The directories to search
 * @param name - Runbook name to search for
 * @param scan - Directory scanner; defaults to {@link scanDirectory}
 * @returns The discovered runbook and its search directory, or null if not found
 */
export async function findRunbookByNameIn(
  roots: RunbookSearchRoots,
  name: string,
  scan: RunbookDirectoryScanner = scanDirectory,
): Promise<DiscoveredInRoot | null> {
  const lookupSlug = toSlug(name);
  for (const { path: dirPath, source } of searchPathsFor(roots)) {
    const runbooks = await scan(dirPath, source);
    for (const runbook of runbooks) {
      if (toSlug(runbook.name) === lookupSlug || toSlug(runbook.filenameStem) === lookupSlug) {
        return { runbook, searchRoot: dirPath };
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
  targetSource: 'project' | 'plugin' | 'bundled',
): Promise<DiscoveredRunbook | null> {
  const searchPaths = getSearchPaths(cwd);

  for (const { path: dirPath, source } of searchPaths) {
    // Only search in the specified source
    if (source !== targetSource) continue;

    const runbooks = await scanDirectory(dirPath, source);

    const lookupSlug = toSlug(name);
    for (const runbook of runbooks) {
      if (toSlug(runbook.name) === lookupSlug || toSlug(runbook.filenameStem) === lookupSlug) {
        return runbook;
      }
    }
  }

  return null;
}
