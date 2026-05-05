import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runbooksDir } from '@rundown-org/core';
import { findRunbookByName, findRunbookByNameInSource } from '../services/discovery.js';
import { getBundledRunbooksPath } from './bundled-runbooks.js';
import { getPluginRoot } from './plugin-root.js';

/**
 * Result of resolving a runbook file, including its source.
 *
 * Provides the absolute filesystem path alongside the source that
 * the runbook was discovered from, enabling downstream consumers
 * to derive source-specific context (e.g., plugin root directory).
 */
export interface ResolvedRunbook {
  /** Absolute path to the resolved runbook file */
  path: string;
  /** Source directory where the runbook was found */
  source: 'project' | 'plugin' | 'bundled';
}

/**
 * Parsed runbook identifier with optional namespace.
 */
export interface ParsedIdentifier {
  /** Namespace prefix (e.g., 'rundown') or null if none */
  namespace: string | null;
  /** Runbook name or path */
  name: string;
}

/**
 * Parse a runbook identifier into namespace and name components.
 * Namespace syntax: `namespace:name` (e.g., `rundown:write-plan`)
 *
 * @param identifier - Runbook identifier to parse
 * @returns Parsed identifier with namespace and name
 */
export function parseIdentifier(identifier: string): ParsedIdentifier {
  // Match namespace:name pattern where namespace is lowercase alphanumeric with hyphens
  const regex = /^([a-z][a-z0-9-]*):(.+)$/;
  const match = regex.exec(identifier);
  if (match) {
    return { namespace: match[1], name: match[2] };
  }
  return { namespace: null, name: identifier };
}

/**
 * Map namespace to source type.
 * Currently only 'rundown' namespace maps to 'plugin' source.
 *
 * @param namespace - Namespace string
 * @returns Source type or null if namespace not recognized
 */
function namespaceToSource(namespace: string): 'project' | 'plugin' | 'bundled' | null {
  if (namespace === 'rundown') {
    return 'plugin';
  }
  // Future: could support other namespaces
  return null;
}

function pathWithin(root: string, target: string): boolean {
  const relativePath = path.relative(path.resolve(root), path.resolve(target));
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${path.sep}`) &&
      relativePath !== '..' &&
      !path.isAbsolute(relativePath))
  );
}

async function resolveAbsolutePath(cwd: string, filename: string): Promise<ResolvedRunbook | null> {
  try {
    await fs.access(filename);
  } catch {
    return null;
  }

  if (pathWithin(runbooksDir(cwd), filename)) {
    return { path: filename, source: 'project' };
  }

  const pluginRoot = getPluginRoot();
  if (pluginRoot && pathWithin(path.join(pluginRoot, 'runbooks'), filename)) {
    return { path: filename, source: 'plugin' };
  }

  if (pathWithin(getBundledRunbooksPath(), filename)) {
    return { path: filename, source: 'bundled' };
  }

  return { path: filename, source: 'project' };
}

/**
 * Resolve runbook file by path (existing logic).
 * Search order:
 * 1. .rundown/runbooks/ (project-local)
 * 2. Plugin runbooks (via CLAUDE_PLUGIN_ROOT env var or sibling package discovery)
 * 3. Relative to cwd
 * 4. Bundled runbooks (lowest priority)
 *
 * @param cwd - Current working directory
 * @param filename - Runbook filename to find
 * @returns Resolved runbook with path and source, or null if not found
 */
async function resolveByPath(cwd: string, filename: string): Promise<ResolvedRunbook | null> {
  if (path.isAbsolute(filename)) {
    return resolveAbsolutePath(cwd, filename);
  }

  // 1. Check project-local .rundown/runbooks/
  const localPath = path.join(runbooksDir(cwd), filename);
  try {
    await fs.access(localPath);
    return { path: localPath, source: 'project' };
  } catch {
    /* not found */
  }

  // 2. Check plugin runbooks directory (env var or sibling package discovery)
  const pluginRoot = getPluginRoot();
  if (pluginRoot) {
    const pluginPath = path.join(pluginRoot, 'runbooks', filename);
    try {
      await fs.access(pluginPath);
      return { path: pluginPath, source: 'plugin' };
    } catch {
      /* not found */
    }
  }

  // 3. Check relative to cwd
  const relativePath = path.resolve(cwd, filename);
  try {
    await fs.access(relativePath);
    return { path: relativePath, source: 'project' };
  } catch {
    /* not found */
  }

  // 4. Check bundled runbooks (lowest priority)
  const bundledPath = path.join(getBundledRunbooksPath(), filename);
  try {
    await fs.access(bundledPath);
    return { path: bundledPath, source: 'bundled' };
  } catch {
    /* not found */
  }

  return null;
}

/**
 * Detect if identifier is path-based or name-based.
 * Path mode: contains '/' or ends with '.md'
 * Name mode: plain identifier (e.g., "verify")
 *
 * @param identifier - Runbook identifier
 * @returns true if path-based, false if name-based
 */
function isPathIdentifier(identifier: string): boolean {
  return identifier.includes('/') || identifier.endsWith('.md');
}

/**
 * Resolve runbook file from multiple sources.
 * Supports both path-based and name-based resolution:
 * - Path mode: .rundown/runbooks/file.md, ./path/to/file.md, etc.
 * - Name mode: "verify", "my-runbook", etc.
 * - Namespace mode: "rundown:write-plan" (explicit source targeting)
 *
 * Search order for path mode:
 * 1. .rundown/runbooks/ (project-local)
 * 2. $CLAUDE_PLUGIN_ROOT/runbooks/ (plugin directory)
 * 3. Relative to cwd
 * 4. Bundled runbooks
 *
 * Search order for name mode (no namespace):
 * 1. Project runbooks directory
 * 2. Plugin runbooks directory
 * 3. Bundled runbooks
 *
 * Namespace mode (e.g., rundown:write-plan):
 * - Searches only in the specified source (plugin for 'rundown' namespace)
 *
 * @param cwd - Current working directory
 * @param identifier - Runbook filename, name, or namespaced name to find
 * @returns Resolved runbook with path and source, or null if not found
 * @throws {Error} May throw filesystem errors if directory access fails unexpectedly
 */
export async function resolveRunbookFile(
  cwd: string,
  identifier: string,
): Promise<ResolvedRunbook | null> {
  // Parse namespace from identifier
  const { namespace, name } = parseIdentifier(identifier);

  // If namespace specified, use explicit source lookup
  if (namespace !== null) {
    const source = namespaceToSource(namespace);
    if (source === null) {
      // Unknown namespace - not found
      return null;
    }
    const discovered = await findRunbookByNameInSource(cwd, name, source);
    return discovered ? { path: discovered.path, source: discovered.source } : null;
  }

  // Detect if identifier is path-based or name-based
  if (isPathIdentifier(name)) {
    // Path-based resolution: use existing logic
    const result = await resolveByPath(cwd, name);
    if (result) return result;

    // Bare .runbook.md filename not found by path — try name-based discovery
    // (handles bundled runbooks in subdirectories)
    if (!name.includes('/') && name.endsWith('.runbook.md')) {
      const stem = name.replace(/\.runbook\.md$/, '');
      const discovered = await findRunbookByName(cwd, stem);
      return discovered ? { path: discovered.path, source: discovered.source } : null;
    }
    return null;
  } else {
    // Name-based resolution: use discovery service
    const discovered = await findRunbookByName(cwd, name);
    return discovered ? { path: discovered.path, source: discovered.source } : null;
  }
}
