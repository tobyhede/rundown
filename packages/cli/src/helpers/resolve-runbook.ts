import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  runbooksDir,
  RunbookRefSchema,
  type RunbookRef,
  type RunbookSource,
} from '@rundown-org/core';
import {
  findRunbookByNameIn,
  findRunbookByNameInSource,
  runtimeSearchRoots,
  scanDirectory,
  type RunbookDirectoryScanner,
  type RunbookSearchRoots,
} from '../services/discovery.js';
import { getBundledRunbooksPath } from './bundled-runbooks.js';
import { getPluginRoot } from './plugin-root.js';

type DiscoverableRunbookSource = Exclude<RunbookSource, 'external'>;

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
  source: RunbookSource;
  /** Source root used to derive persisted source-root-relative identity */
  sourceRoot: string;
}

/**
 * Successful re-resolution of a persisted runbook reference.
 */
export interface ResolveRunbookRefSuccess {
  /** Discriminator for successful resolution */
  readonly ok: true;
  /** Filesystem path and source metadata for the persisted runbook reference */
  readonly resolved: ResolvedRunbook;
}

/**
 * Failure while re-resolving a persisted runbook reference.
 */
export interface ResolveRunbookRefFailure {
  /** Discriminator for failed resolution */
  readonly ok: false;
  /** Whether resolution failed because plugin context was unavailable or the file was missing */
  readonly reason: 'plugin-context-missing' | 'file-missing';
  /** Persisted runbook reference that could not be re-resolved */
  readonly runbookRef: RunbookRef;
}

/** Result of re-resolving a persisted runbook reference. */
export type ResolveRunbookRefResult = ResolveRunbookRefSuccess | ResolveRunbookRefFailure;

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
function namespaceToSource(namespace: string): DiscoverableRunbookSource | null {
  if (namespace === 'rundown') {
    return 'plugin';
  }
  // Future: could support other namespaces
  return null;
}

function isWithinResolvedRoot(root: string, target: string): boolean {
  const relativePath = path.relative(root, target);
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${path.sep}`) &&
      relativePath !== '..' &&
      !path.isAbsolute(relativePath))
  );
}

async function realpathOrResolve(filePath: string): Promise<string> {
  try {
    return await fs.realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

async function pathUnderRoot(root: string, target: string): Promise<string | null> {
  const [realRoot, realTarget] = await Promise.all([
    realpathOrResolve(root),
    realpathOrResolve(target),
  ]);
  if (!isWithinResolvedRoot(realRoot, realTarget)) {
    return null;
  }
  return path.join(root, path.relative(realRoot, realTarget));
}

async function resolveAbsolutePath(cwd: string, filename: string): Promise<ResolvedRunbook | null> {
  const absoluteFilename = path.resolve(filename);
  try {
    await fs.access(absoluteFilename);
  } catch {
    return null;
  }

  const projectRunbookPath = await pathUnderRoot(runbooksDir(cwd), absoluteFilename);
  if (projectRunbookPath) {
    return { path: projectRunbookPath, source: 'project', sourceRoot: cwd };
  }

  const pluginRoot = getPluginRoot();
  const pluginRunbooksDir = pluginRoot ? path.join(pluginRoot, 'runbooks') : null;
  if (pluginRunbooksDir) {
    const pluginRunbookPath = await pathUnderRoot(pluginRunbooksDir, absoluteFilename);
    if (pluginRunbookPath) {
      return { path: pluginRunbookPath, source: 'plugin', sourceRoot: pluginRunbooksDir };
    }
  }

  const bundledRunbooksDir = getBundledRunbooksPath();
  const bundledRunbookPath = await pathUnderRoot(bundledRunbooksDir, absoluteFilename);
  if (bundledRunbookPath) {
    return { path: bundledRunbookPath, source: 'bundled', sourceRoot: bundledRunbooksDir };
  }

  const projectPath = await pathUnderRoot(cwd, absoluteFilename);
  if (projectPath) {
    return { path: projectPath, source: 'project', sourceRoot: cwd };
  }

  return {
    path: absoluteFilename,
    source: 'external',
    sourceRoot: path.dirname(absoluteFilename),
  };
}

/**
 * Where a relative runbook identifier resolves, before source-root bookkeeping.
 */
export interface LocatedRunbook {
  /** Absolute path to the runbook file. */
  readonly path: string;
  /** The source whose root held it. */
  readonly source: DiscoverableRunbookSource;
  /** The search directory that held it: a project, plugin runbooks, cwd or bundled root. */
  readonly root: string;
  /** Whether it was found as a path under a root or by name discovery. */
  readonly via: 'path' | 'discovery';
}

/**
 * Locate a relative runbook file by path.
 * Search order:
 * 1. The project runbooks directory (`.rundown/runbooks/`)
 * 2. Plugin runbooks (`<plugin>/runbooks/`)
 * 3. Relative to cwd
 * 4. Bundled runbooks (lowest priority)
 *
 * @param roots - The directories to search
 * @param filename - Relative runbook path to find
 * @returns The located runbook, or null if not found
 */
async function locateByPath(
  roots: RunbookSearchRoots,
  filename: string,
): Promise<LocatedRunbook | null> {
  const candidates: { root: string; path: string; source: DiscoverableRunbookSource }[] = [];
  if (roots.project !== null) {
    candidates.push({
      root: roots.project,
      path: path.join(roots.project, filename),
      source: 'project',
    });
  }
  if (roots.plugin !== null) {
    const pluginRunbooks = path.join(roots.plugin, 'runbooks');
    candidates.push({
      root: pluginRunbooks,
      path: path.join(pluginRunbooks, filename),
      source: 'plugin',
    });
  }
  if (roots.cwd !== null) {
    candidates.push({
      root: roots.cwd,
      path: path.resolve(roots.cwd, filename),
      source: 'project',
    });
  }
  candidates.push({
    root: roots.bundled,
    path: path.join(roots.bundled, filename),
    source: 'bundled',
  });

  for (const candidate of candidates) {
    try {
      await fs.access(candidate.path);
      return { ...candidate, via: 'path' };
    } catch {
      /* not found */
    }
  }
  return null;
}

/**
 * Locate a relative runbook identifier over explicit search roots — the one
 * resolution rule both the runtime ({@link resolveRunbookFile}) and scenario
 * suite staging use.
 *
 * A path identifier (containing `/` or ending in `.md`) is tried as a path
 * under each root in turn; a bare `*.runbook.md` filename found under none
 * falls back to name discovery by its stem. A plain name goes straight to name
 * discovery: the first runbook, in project, plugin, bundled order, whose
 * frontmatter `name` or filename stem matches.
 *
 * @param roots - The directories to search
 * @param name - Relative runbook path or name (no namespace, not absolute)
 * @param scan - Directory scanner for name discovery; defaults to the runtime's
 * @returns The located runbook, or null if not found
 */
export async function locateRunbook(
  roots: RunbookSearchRoots,
  name: string,
  scan: RunbookDirectoryScanner = scanDirectory,
): Promise<LocatedRunbook | null> {
  let lookupName = name;
  if (isPathIdentifier(name)) {
    const byPath = await locateByPath(roots, name);
    if (byPath) return byPath;
    // Bare .runbook.md filename not found by path — try name-based discovery
    // (handles runbooks in subdirectories)
    if (name.includes('/') || !name.endsWith('.runbook.md')) return null;
    lookupName = name.replace(/\.runbook\.md$/, '');
  }
  const discovered = await findRunbookByNameIn(roots, lookupName, scan);
  return discovered
    ? {
        path: discovered.runbook.path,
        source: discovered.runbook.source,
        root: discovered.searchRoot,
        via: 'discovery',
      }
    : null;
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

/** Options for {@link resolveRunbookFile}. */
export interface ResolveRunbookFileOptions {
  /**
   * Absolute path of the runbook that composes this one (a Child Run's
   * parent). When the identifier is a path that no search root holds, it is
   * tried relative to this file's directory, last.
   */
  readonly composedFrom?: string;
}

/**
 * Resolve a child runbook path beside the runbook that composes it — the last
 * resort after every search root has missed.
 *
 * @param cwd - Current working directory
 * @param composedFrom - Absolute path of the composing runbook
 * @param name - Relative runbook path
 * @returns The resolved sibling, or null when it does not exist or lies outside
 *   the composing runbook's source root
 */
async function resolveBesideComposer(
  cwd: string,
  composedFrom: string,
  name: string,
): Promise<ResolvedRunbook | null> {
  const candidate = path.resolve(path.dirname(composedFrom), name);
  try {
    await fs.access(candidate);
  } catch {
    return null;
  }
  // A sibling stays inside the root its composer was found in; a path that
  // climbs out of it is not resolved.
  const composer = await resolveAbsolutePath(cwd, composedFrom);
  if (composer === null || (await pathUnderRoot(composer.sourceRoot, candidate)) === null) {
    return null;
  }
  return resolveAbsolutePath(cwd, candidate);
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
 * A path that every source misses is then tried beside `options.composedFrom`
 * (a Child Run's parent), inside that runbook's own source root.
 *
 * Namespace mode (e.g., rundown:write-plan):
 * - Searches only in the specified source (plugin for 'rundown' namespace)
 *
 * @param cwd - Current working directory
 * @param identifier - Runbook filename, name, or namespaced name to find
 * @param options - Resolution options; `composedFrom` names the composing runbook
 * @returns Resolved runbook with path and source, or null if not found
 * @throws {Error} May throw filesystem errors if directory access fails unexpectedly
 */
export async function resolveRunbookFile(
  cwd: string,
  identifier: string,
  options: ResolveRunbookFileOptions = {},
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
    return discovered ? resolvedFromDiscovered(cwd, discovered) : null;
  }

  if (path.isAbsolute(name)) {
    return resolveAbsolutePath(cwd, name);
  }

  const located = await locateRunbook(runtimeSearchRoots(cwd), name);
  if (!located) {
    return options.composedFrom !== undefined && isPathIdentifier(name)
      ? resolveBesideComposer(cwd, options.composedFrom, name)
      : null;
  }
  return located.via === 'discovery'
    ? resolvedFromDiscovered(cwd, located)
    : {
        path: located.path,
        source: located.source,
        sourceRoot: sourceRootForDiscovered(cwd, located.source),
      };
}

async function resolvedFromDiscovered(
  cwd: string,
  discovered: { path: string; source: DiscoverableRunbookSource },
): Promise<ResolvedRunbook> {
  const sourceRoot = sourceRootForDiscovered(cwd, discovered.source);
  const normalizedPath = (await pathUnderRoot(sourceRoot, discovered.path)) ?? discovered.path;
  return {
    path: normalizedPath,
    source: discovered.source,
    sourceRoot,
  };
}

function sourceRootForDiscovered(cwd: string, source: DiscoverableRunbookSource): string {
  switch (source) {
    case 'project':
      return cwd;
    case 'plugin': {
      const pluginRoot = getPluginRoot();
      if (!pluginRoot) {
        throw new Error('Plugin runbook discovered without CLAUDE_PLUGIN_ROOT');
      }
      return path.join(pluginRoot, 'runbooks');
    }
    case 'bundled':
      return getBundledRunbooksPath();
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

async function toSourceRootRelativePath(filePath: string, sourceRoot: string): Promise<string> {
  const safePath = await pathUnderRoot(sourceRoot, filePath);
  if (safePath === null) {
    throw new Error(`Resolved runbook path is outside ${sourceRoot}: ${filePath}`);
  }
  const relative = path.relative(sourceRoot, safePath).split(path.sep).join('/');
  if (
    relative.length === 0 ||
    relative === '..' ||
    relative.startsWith('../') ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Resolved runbook path is outside ${sourceRoot}: ${filePath}`);
  }
  return relative;
}

async function derivePersistedRunbookRef(
  filePath: string,
  source: RunbookSource,
  sourceRoot: string,
): Promise<RunbookRef> {
  if (source === 'external') {
    return RunbookRefSchema.parse({
      source,
      path: filePath,
    });
  }

  return RunbookRefSchema.parse({
    source,
    path: await toSourceRootRelativePath(filePath, sourceRoot),
  });
}

/**
 * Build the canonical runtime runbook reference for a resolved runbook file.
 *
 * @param resolved - Filesystem resolution result carrying path, source, and source root
 * @returns Canonical `RunbookRef` derived from the resolved file and validated by `RunbookRefSchema`
 * @throws {Error} If the resolved file cannot be represented as a safe source-root-relative Markdown path
 */
export async function buildRunbookRef(resolved: ResolvedRunbook): Promise<RunbookRef> {
  return derivePersistedRunbookRef(resolved.path, resolved.source, resolved.sourceRoot);
}

/**
 * Resolve a persisted runbook reference back to a filesystem path.
 *
 * @param cwd - Current working directory for project runbooks
 * @param runbookRef - Canonical persisted runbook identity
 * @returns Typed success with source metadata, or typed failure describing why resolution failed
 */
export async function resolveRunbookRef(
  cwd: string,
  runbookRef: RunbookRef,
): Promise<ResolveRunbookRefResult> {
  const canonical = runbookRef;
  switch (canonical.source) {
    case 'external':
      try {
        // External refs intentionally trust a normalized absolute path only.
        // Persistence does not bind file contents, so replacing the file between
        // delegation and claim is outside the current integrity model.
        await fs.access(canonical.path);
        return {
          ok: true,
          resolved: {
            path: canonical.path,
            source: canonical.source,
            sourceRoot: path.dirname(canonical.path),
          },
        };
      } catch {
        return { ok: false, reason: 'file-missing', runbookRef: canonical };
      }
    case 'project':
      return resolveRunbookRefCandidates(canonical, [
        { sourceRoot: cwd, path: path.join(cwd, canonical.path) },
      ]);
    case 'plugin': {
      const pluginRoot = getPluginRoot();
      if (!pluginRoot) {
        return { ok: false, reason: 'plugin-context-missing', runbookRef: canonical };
      }
      const pluginRunbooksDir = path.join(pluginRoot, 'runbooks');
      return resolveRunbookRefCandidates(canonical, [
        { sourceRoot: pluginRunbooksDir, path: path.join(pluginRunbooksDir, canonical.path) },
      ]);
    }
    case 'bundled': {
      const bundledRunbooksDir = getBundledRunbooksPath();
      return resolveRunbookRefCandidates(canonical, [
        { sourceRoot: bundledRunbooksDir, path: path.join(bundledRunbooksDir, canonical.path) },
      ]);
    }
    default: {
      const _exhaustive: never = canonical.source;
      return _exhaustive;
    }
  }
}

async function resolveRunbookRefCandidates(
  runbookRef: RunbookRef,
  candidates: readonly { readonly sourceRoot: string; readonly path: string }[],
): Promise<ResolveRunbookRefResult> {
  for (const candidate of candidates) {
    try {
      await fs.access(candidate.path);
      return {
        ok: true,
        resolved: {
          path: candidate.path,
          source: runbookRef.source,
          sourceRoot: candidate.sourceRoot,
        },
      };
    } catch {
      // Continue to next candidate.
    }
  }
  return { ok: false, reason: 'file-missing', runbookRef };
}
