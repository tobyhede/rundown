/**
 * Policy to Sandbox Options Mapper
 *
 * Converts Rundown policy configuration into sandbox options that can
 * be used by the OS-level sandbox implementations.
 *
 * @module
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import picomatch from 'picomatch';
import type { PolicyEvaluator } from '../policy/evaluator.js';
import type { PolicyConfig } from '../policy/schema.js';
import type { SandboxOptions } from './types.js';

/**
 * Options for creating sandbox options from policy.
 */
export interface PolicyMapperOptions {
  /** Working directory for command execution */
  cwd: string;

  /** Repository root path */
  repoRoot?: string;

  /** Temporary directory path */
  tmpDir?: string;

  /** Whether to allow execution without sandbox if unavailable */
  allowUnsandboxed?: boolean;
}

/**
 * Resolve placeholder variables in a path pattern.
 *
 * Supports:
 * - {repo} - Repository root path
 * - {tmp} - System temporary directory
 *
 * @param pattern - Path pattern with optional placeholders
 * @param repoRoot - Repository root path
 * @param tmpDir - Temporary directory path
 * @returns Resolved path
 */
function resolvePlaceholders(pattern: string, repoRoot: string, tmpDir: string): string {
  return pattern.replace(/\{repo\}/g, repoRoot).replace(/\{tmp\}/g, tmpDir);
}

function hasGlob(pattern: string): boolean {
  return /[*?[\]{}]/.test(pattern);
}

function isSubtreeDenyPattern(pattern: string): boolean {
  return /(?:\/|\\)\*\*$/.test(pattern);
}

/**
 * Convert glob patterns to concrete paths for sandbox.
 *
 * The sandbox implementations need concrete paths, not glob patterns.
 * This function resolves placeholders and handles the base directory
 * extraction from glob patterns.
 *
 * @param patterns - Array of path patterns
 * @param repoRoot - Repository root path
 * @param tmpDir - Temporary directory path
 * @returns Array of concrete paths
 */
function resolvePathPatterns(patterns: string[], repoRoot: string, tmpDir: string): string[] {
  const resolved: string[] = [];

  for (const pattern of patterns) {
    // Resolve placeholders first
    const resolvedPattern = resolvePlaceholders(pattern, repoRoot, tmpDir);

    // For glob patterns like "{repo}/**", extract the base directory
    // The sandbox will grant access to the entire subtree
    const baseDir = extractBasePath(resolvedPattern);

    if (baseDir && !resolved.includes(baseDir)) {
      resolved.push(baseDir);
    }
  }

  return resolved;
}

/**
 * Extract the base path from a glob pattern.
 *
 * Examples:
 * - "/home/user/**" -> "/home/user"
 * - "/home/user/*.txt" -> "/home/user"
 * - "/home/user" -> "/home/user"
 *
 * @param pattern - Glob pattern or path
 * @returns Base directory path
 */
function extractBasePath(pattern: string): string {
  // Remove glob characters and everything after them
  const globIndex = pattern.search(/[*?[\]{}]/);

  if (globIndex === -1) {
    // No glob characters, return as-is
    return pattern;
  }

  // Get the directory portion before the glob
  const beforeGlob = pattern.substring(0, globIndex);
  return path.dirname(`${beforeGlob}x`); // Add 'x' to handle trailing slash
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..');
}

function selectExpansionRoots(roots: string[], repoRoot: string, cwd: string): string[] {
  return [...new Set(roots)].filter((root) => {
    return isWithinRoot(root, repoRoot) || isWithinRoot(root, cwd);
  });
}

function collectConcreteDenyPaths(
  patterns: string[],
  roots: string[],
  repoRoot: string,
  cwd: string,
): string[] {
  const concrete = new Set<string>();
  const expansionRoots = selectExpansionRoots(roots, repoRoot, cwd);

  for (const pattern of patterns) {
    if (!hasGlob(pattern)) {
      concrete.add(pattern);
      continue;
    }

    const basePath = extractBasePath(pattern);
    if (
      isSubtreeDenyPattern(pattern) &&
      basePath !== '.' &&
      basePath !== path.sep &&
      !basePath.includes('*') &&
      !basePath.includes('?')
    ) {
      concrete.add(basePath);
      continue;
    }

    const matcher = picomatch(pattern, { dot: true });
    for (const root of expansionRoots) {
      collectMatches(root, matcher, concrete);
    }
  }

  return [...concrete];
}

function collectMatches(
  currentPath: string,
  matcher: (value: string) => boolean,
  matches: Set<string>,
): void {
  if (!fs.existsSync(currentPath)) {
    return;
  }

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(currentPath);
  } catch {
    return;
  }

  if (matcher(currentPath)) {
    matches.add(currentPath);
  }

  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(currentPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') {
      continue;
    }
    collectMatches(path.join(currentPath, entry.name), matcher, matches);
  }
}

/**
 * Convert a policy evaluator's configuration to sandbox options.
 *
 * Maps the policy's read/write allow/deny rules to concrete paths
 * that can be used by the sandbox implementations.
 *
 * @param evaluator - Policy evaluator instance
 * @param options - Mapping options
 * @returns Sandbox options for execution
 *
 * @example
 * ```typescript
 * const evaluator = new PolicyEvaluator(policy, { repoRoot: cwd });
 * const sandboxOptions = policyToSandboxOptions(evaluator, { cwd });
 *
 * const result = await executeWithSandbox(command, sandboxOptions);
 * ```
 */
export function policyToSandboxOptions(
  evaluator: PolicyEvaluator,
  options: PolicyMapperOptions,
): SandboxOptions {
  const repoRoot = options.repoRoot ?? options.cwd;
  const tmpDir = options.tmpDir ?? os.tmpdir();

  const readRules = evaluator.getEffectiveRules('read');
  const writeRules = evaluator.getEffectiveRules('write');

  // Resolve read-only paths (from read.allow minus write.allow)
  const readAllowPaths = resolvePathPatterns(readRules.allow, repoRoot, tmpDir);
  const writeAllowPaths = resolvePathPatterns(writeRules.allow, repoRoot, tmpDir);

  // Read-only: paths in read.allow but not in write.allow
  const readOnlyPaths = readAllowPaths.filter((p) => !writeAllowPaths.includes(p));

  // Read-write: paths in write.allow (implies read as well)
  const readWritePaths = writeAllowPaths;

  const denyPatterns = [...readRules.deny, ...writeRules.deny].map((pattern) =>
    resolvePlaceholders(pattern, repoRoot, tmpDir),
  );
  const denyPaths = collectConcreteDenyPaths(
    denyPatterns,
    [...readAllowPaths, ...writeAllowPaths],
    repoRoot,
    options.cwd,
  );

  return {
    cwd: options.cwd,
    repoRoot,
    readOnlyPaths: [...new Set(readOnlyPaths)],
    readWritePaths: [...new Set(readWritePaths)],
    denyPatterns: [...new Set(denyPatterns)],
    denyPaths: [...new Set(denyPaths)],
    env: {},
    allowUnsandboxed: options.allowUnsandboxed,
  };
}

/**
 * Create sandbox options from a policy configuration directly.
 *
 * Alternative to using an evaluator, this takes the raw policy config.
 *
 * @param policy - Policy configuration
 * @param options - Mapping options
 * @returns Sandbox options for execution
 */
export function policyConfigToSandboxOptions(
  policy: PolicyConfig,
  options: PolicyMapperOptions,
): SandboxOptions {
  const repoRoot = options.repoRoot ?? options.cwd;
  const tmpDir = options.tmpDir ?? os.tmpdir();

  const readAllowPaths = resolvePathPatterns(policy.default.read.allow, repoRoot, tmpDir);
  const writeAllowPaths = resolvePathPatterns(policy.default.write.allow, repoRoot, tmpDir);

  const readOnlyPaths = readAllowPaths.filter((p) => !writeAllowPaths.includes(p));
  const readWritePaths = writeAllowPaths;

  const denyPatterns = [...policy.default.read.deny, ...policy.default.write.deny].map((pattern) =>
    resolvePlaceholders(pattern, repoRoot, tmpDir),
  );
  const denyPaths = collectConcreteDenyPaths(
    denyPatterns,
    [...readAllowPaths, ...writeAllowPaths],
    repoRoot,
    options.cwd,
  );

  return {
    cwd: options.cwd,
    repoRoot,
    readOnlyPaths: [...new Set(readOnlyPaths)],
    readWritePaths: [...new Set(readWritePaths)],
    denyPatterns: [...new Set(denyPatterns)],
    denyPaths: [...new Set(denyPaths)],
    env: {},
    allowUnsandboxed: options.allowUnsandboxed,
  };
}
