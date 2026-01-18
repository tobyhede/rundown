/**
 * Policy to Sandbox Options Mapper
 *
 * Converts Rundown policy configuration into sandbox options that can
 * be used by the OS-level sandbox implementations.
 *
 * @module
 */

import * as path from 'path';
import * as os from 'os';
import { type PolicyEvaluator } from '../policy/evaluator.js';
import { type PolicyConfig } from '../policy/schema.js';
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
  return pattern
    .replace(/\{repo\}/g, repoRoot)
    .replace(/\{tmp\}/g, tmpDir);
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
  return path.dirname(beforeGlob + 'x'); // Add 'x' to handle trailing slash
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
  options: PolicyMapperOptions
): SandboxOptions {
  const repoRoot = options.repoRoot ?? options.cwd;
  const tmpDir = options.tmpDir ?? os.tmpdir();

  // Get the policy from evaluator (we'll need to access it)
  // For now, we use a simplified approach based on common patterns
  const policy = getEffectivePolicy(evaluator);

  // Resolve read-only paths (from read.allow minus write.allow)
  const readAllowPaths = resolvePathPatterns(policy.read.allow, repoRoot, tmpDir);
  const writeAllowPaths = resolvePathPatterns(policy.write.allow, repoRoot, tmpDir);

  // Read-only: paths in read.allow but not in write.allow
  const readOnlyPaths = readAllowPaths.filter(p => !writeAllowPaths.includes(p));

  // Read-write: paths in write.allow (implies read as well)
  const readWritePaths = writeAllowPaths;

  // Deny paths (from both read.deny and write.deny)
  const denyPaths = [
    ...resolvePathPatterns(policy.read.deny, repoRoot, tmpDir),
    ...resolvePathPatterns(policy.write.deny, repoRoot, tmpDir),
  ];

  return {
    cwd: options.cwd,
    repoRoot,
    readOnlyPaths: [...new Set(readOnlyPaths)],
    readWritePaths: [...new Set(readWritePaths)],
    denyPaths: [...new Set(denyPaths)],
    allowUnsandboxed: options.allowUnsandboxed,
  };
}

/**
 * Get the effective policy rules from an evaluator.
 *
 * This extracts the read/write rules that will be used for
 * sandbox path restrictions.
 *
 * @param evaluator - Policy evaluator
 * @returns Policy rules for read/write access
 */
function getEffectivePolicy(evaluator: PolicyEvaluator): {
  read: { allow: string[]; deny: string[] };
  write: { allow: string[]; deny: string[] };
} {
  const policy = evaluator.getPolicy();
  return {
    read: policy.default.read,
    write: policy.default.write,
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
  options: PolicyMapperOptions
): SandboxOptions {
  const repoRoot = options.repoRoot ?? options.cwd;
  const tmpDir = options.tmpDir ?? os.tmpdir();

  const readAllowPaths = resolvePathPatterns(policy.default.read.allow, repoRoot, tmpDir);
  const writeAllowPaths = resolvePathPatterns(policy.default.write.allow, repoRoot, tmpDir);

  const readOnlyPaths = readAllowPaths.filter(p => !writeAllowPaths.includes(p));
  const readWritePaths = writeAllowPaths;

  const denyPaths = [
    ...resolvePathPatterns(policy.default.read.deny, repoRoot, tmpDir),
    ...resolvePathPatterns(policy.default.write.deny, repoRoot, tmpDir),
  ];

  return {
    cwd: options.cwd,
    repoRoot,
    readOnlyPaths: [...new Set(readOnlyPaths)],
    readWritePaths: [...new Set(readWritePaths)],
    denyPaths: [...new Set(denyPaths)],
    allowUnsandboxed: options.allowUnsandboxed,
  };
}
