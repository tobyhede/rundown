/**
 * Policy evaluator for checking permissions against policy configuration.
 *
 * Provides permission checking for command execution, file access, and
 * environment variables using glob pattern matching.
 *
 * @module
 */

import picomatch from 'picomatch';
import * as path from 'path';
import * as os from 'os';
import { type PolicyConfig, type PolicyGrant, type PermissionRules, DEFAULT_POLICY } from './schema.js';
import { extractAllExecutables } from './parser.js';

/**
 * Result of a policy decision.
 */
export interface PolicyDecision {
  /** Whether the operation is allowed */
  allowed: boolean;
  /** Human-readable explanation of the decision */
  reason: string;
  /** Whether the user should be prompted for permission */
  requiresPrompt: boolean;
  /** The pattern that matched (if any) */
  matchedRule?: string;
  /** The specific executable or path that triggered the decision */
  subject?: string;
}

/**
 * Options for creating a policy evaluator.
 */
export interface PolicyEvaluatorOptions {
  /** Repository root path for resolving {repo} placeholder */
  repoRoot?: string;
  /** Temporary directory path for resolving {tmp} placeholder */
  tmpDir?: string;
  /** Current runbook file path (for override matching) */
  runbookPath?: string;
  /** CLI-granted permissions (e.g., --allow-run git,npm) */
  cliGrants?: {
    run?: string[];
    read?: string[];
    write?: string[];
    env?: string[];
  };
  /** Whether to allow all operations (--allow-all flag) */
  allowAll?: boolean;
  /** Whether to deny all operations (--deny-all flag) */
  denyAll?: boolean;
}

/**
 * Policy evaluator for checking permissions.
 *
 * Evaluates commands, paths, and environment variables against the policy
 * configuration, returning detailed decisions with explanations.
 *
 * @example
 * ```typescript
 * const evaluator = new PolicyEvaluator(policy, {
 *   repoRoot: '/path/to/repo',
 *   runbookPath: 'deploy.runbook.md',
 * });
 *
 * const decision = evaluator.checkCommand('git push');
 * if (!decision.allowed && decision.requiresPrompt) {
 *   // Ask user for permission
 * }
 * ```
 */
export class PolicyEvaluator {
  private policy: PolicyConfig;
  private options: PolicyEvaluatorOptions;
  private repoRoot: string;
  private tmpDir: string;
  private sessionGrants: PolicyGrant[] = [];

  /**
   * Create a new policy evaluator.
   *
   * @param policy - Policy configuration to evaluate against
   * @param options - Evaluation options including paths and CLI overrides
   */
  constructor(policy: PolicyConfig = DEFAULT_POLICY, options: PolicyEvaluatorOptions = {}) {
    this.policy = policy;
    this.options = options;
    this.repoRoot = options.repoRoot ?? process.cwd();
    this.tmpDir = options.tmpDir ?? os.tmpdir();
  }

  /**
   * Set the current runbook path for override matching.
   *
   * Call this before evaluating commands to enable runbook-specific policy overrides.
   * The path is matched against override patterns like 'deploy/*.runbook.md'.
   *
   * @param runbookPath - The runbook file path (relative to repo root)
   */
  setRunbookPath(runbookPath: string | undefined): void {
    this.options.runbookPath = runbookPath;
  }

  /**
   * Get the current runbook path.
   *
   * @returns The current runbook path, or undefined if not set
   */
  getRunbookPath(): string | undefined {
    return this.options.runbookPath;
  }

  /**
   * Check if a command is allowed to execute.
   *
   * @param command - The shell command string to check
   * @returns Policy decision with allow/deny and explanation
   */
  checkCommand(command: string): PolicyDecision {
    // Handle global overrides
    if (this.options.denyAll) {
      return {
        allowed: false,
        reason: 'All operations denied (--deny-all)',
        requiresPrompt: false,
        subject: command,
      };
    }

    if (this.options.allowAll) {
      return {
        allowed: true,
        reason: 'All operations allowed (--allow-all)',
        requiresPrompt: false,
        subject: command,
      };
    }

    // Extract all executables from the command
    const executables = extractAllExecutables(command);

    if (executables.length === 0) {
      return {
        allowed: false,
        reason: 'Could not parse command',
        requiresPrompt: false,
        subject: command,
      };
    }

    // Get effective policy (with runbook overrides applied)
    const rules = this.getEffectiveRules('run');

    // Check each executable
    for (const executable of executables) {
      // Check CLI grants first
      if (this.options.cliGrants?.run?.some(pattern => this.matchPattern(executable, pattern))) {
        continue; // CLI grant allows this
      }

      // Check session grants
      if (this.hasSessionGrant('run', executable)) {
        continue;
      }

      // Check deny list first (deny takes precedence)
      const denyMatch = this.findMatchingPattern(executable, rules.deny);
      if (denyMatch) {
        return {
          allowed: false,
          reason: `Command '${executable}' is blocked by policy`,
          requiresPrompt: false,
          matchedRule: denyMatch,
          subject: executable,
        };
      }

      // Check allow list
      const allowMatch = this.findMatchingPattern(executable, rules.allow);
      if (!allowMatch) {
        // Not in allow list - check mode
        const mode = this.getEffectiveMode();
        if (mode === 'deny') {
          return {
            allowed: false,
            reason: `Command '${executable}' is not in the allow list`,
            requiresPrompt: false,
            subject: executable,
          };
        }
        if (mode === 'prompted') {
          return {
            allowed: false,
            reason: `Command '${executable}' requires permission`,
            requiresPrompt: true,
            subject: executable,
          };
        }
      }
    }

    // All executables passed
    return {
      allowed: true,
      reason: 'Command allowed by policy',
      requiresPrompt: false,
      subject: command,
    };
  }

  /**
   * Check if a file path is allowed for the specified access mode.
   *
   * @param filePath - The file path to check
   * @param mode - Access mode: 'read' or 'write'
   * @returns Policy decision with allow/deny and explanation
   */
  checkPath(filePath: string, mode: 'read' | 'write'): PolicyDecision {
    // Handle global overrides
    if (this.options.denyAll) {
      return {
        allowed: false,
        reason: 'All operations denied (--deny-all)',
        requiresPrompt: false,
        subject: filePath,
      };
    }

    if (this.options.allowAll) {
      return {
        allowed: true,
        reason: 'All operations allowed (--allow-all)',
        requiresPrompt: false,
        subject: filePath,
      };
    }

    // Resolve to absolute path
    const absolutePath = path.resolve(filePath);

    // Get effective rules
    const rules = this.getEffectiveRules(mode);

    // Check CLI grants
    if (this.options.cliGrants?.[mode]?.some(pattern => this.matchPathPattern(absolutePath, pattern))) {
      return {
        allowed: true,
        reason: `Path allowed by CLI grant`,
        requiresPrompt: false,
        subject: filePath,
      };
    }

    // Check session grants
    if (this.hasSessionGrant(mode, absolutePath)) {
      return {
        allowed: true,
        reason: 'Path allowed by session grant',
        requiresPrompt: false,
        subject: filePath,
      };
    }

    // Check deny list first
    const denyMatch = this.findMatchingPathPattern(absolutePath, rules.deny);
    if (denyMatch) {
      return {
        allowed: false,
        reason: `Path '${filePath}' is blocked by policy`,
        requiresPrompt: false,
        matchedRule: denyMatch,
        subject: filePath,
      };
    }

    // Check allow list
    const allowMatch = this.findMatchingPathPattern(absolutePath, rules.allow);
    if (!allowMatch) {
      const policyMode = this.getEffectiveMode();
      if (policyMode === 'deny') {
        return {
          allowed: false,
          reason: `Path '${filePath}' is not in the allow list`,
          requiresPrompt: false,
          subject: filePath,
        };
      }
      if (policyMode === 'prompted') {
        return {
          allowed: false,
          reason: `Path '${filePath}' requires permission`,
          requiresPrompt: true,
          subject: filePath,
        };
      }
    }

    return {
      allowed: true,
      reason: 'Path allowed by policy',
      requiresPrompt: false,
      matchedRule: allowMatch ?? undefined,
      subject: filePath,
    };
  }

  /**
   * Check if an environment variable is allowed.
   *
   * @param key - The environment variable name to check
   * @returns Policy decision with allow/deny and explanation
   */
  checkEnv(key: string): PolicyDecision {
    // Handle global overrides
    if (this.options.denyAll) {
      return {
        allowed: false,
        reason: 'All operations denied (--deny-all)',
        requiresPrompt: false,
        subject: key,
      };
    }

    if (this.options.allowAll) {
      return {
        allowed: true,
        reason: 'All operations allowed (--allow-all)',
        requiresPrompt: false,
        subject: key,
      };
    }

    // Get effective rules
    const rules = this.getEffectiveRules('env');

    // Check CLI grants
    if (this.options.cliGrants?.env?.some(pattern => this.matchPattern(key, pattern))) {
      return {
        allowed: true,
        reason: 'Environment variable allowed by CLI grant',
        requiresPrompt: false,
        subject: key,
      };
    }

    // Check session grants
    if (this.hasSessionGrant('env', key)) {
      return {
        allowed: true,
        reason: 'Environment variable allowed by session grant',
        requiresPrompt: false,
        subject: key,
      };
    }

    // Check deny list first
    const denyMatch = this.findMatchingPattern(key, rules.deny);
    if (denyMatch) {
      return {
        allowed: false,
        reason: `Environment variable '${key}' is blocked by policy`,
        requiresPrompt: false,
        matchedRule: denyMatch,
        subject: key,
      };
    }

    // Check allow list
    const allowMatch = this.findMatchingPattern(key, rules.allow);
    if (!allowMatch) {
      const mode = this.getEffectiveMode();
      if (mode === 'deny') {
        return {
          allowed: false,
          reason: `Environment variable '${key}' is not in the allow list`,
          requiresPrompt: false,
          subject: key,
        };
      }
      if (mode === 'prompted') {
        return {
          allowed: false,
          reason: `Environment variable '${key}' requires permission`,
          requiresPrompt: true,
          subject: key,
        };
      }
    }

    return {
      allowed: true,
      reason: 'Environment variable allowed by policy',
      requiresPrompt: false,
      matchedRule: allowMatch ?? undefined,
      subject: key,
    };
  }

  /**
   * Filter environment variables based on policy.
   *
   * Returns a new environment object with only allowed variables.
   *
   * @param env - Environment variables to filter
   * @returns Filtered environment object
   */
  filterEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
    const filtered: Record<string, string> = {};

    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) continue;

      const decision = this.checkEnv(key);
      if (decision.allowed) {
        filtered[key] = value;
      }
    }

    return filtered;
  }

  /**
   * Add a session grant for a specific permission.
   *
   * Session grants are temporary and last until the evaluator is destroyed.
   *
   * @param type - Permission type
   * @param pattern - The pattern being granted
   */
  addSessionGrant(type: 'run' | 'read' | 'write' | 'env', pattern: string): void {
    this.sessionGrants.push({
      type,
      pattern,
      scope: 'session',
      grantedAt: new Date().toISOString(),
    });
  }

  /**
   * Check if there's a session grant for a specific permission.
   *
   * @param type - Permission type
   * @param subject - The subject to check (command, path, or env var)
   * @returns True if a matching session grant exists
   */
  private hasSessionGrant(type: 'run' | 'read' | 'write' | 'env', subject: string): boolean {
    return this.sessionGrants.some(grant => {
      if (grant.type !== type) return false;
      if (type === 'read' || type === 'write') {
        return this.matchPathPattern(subject, grant.pattern);
      }
      return this.matchPattern(subject, grant.pattern);
    });
  }

  /**
   * Get effective rules for a permission type, applying runbook overrides.
   *
   * @param type - Permission type
   * @returns Merged permission rules
   */
  private getEffectiveRules(type: 'run' | 'read' | 'write' | 'env'): PermissionRules {
    const defaultRules = this.policy.default[type];

    // Find matching override
    if (this.options.runbookPath) {
      for (const override of this.policy.overrides) {
        if (picomatch.isMatch(this.options.runbookPath, override.runbook)) {
          const overrideRules = override[type];
          if (overrideRules) {
            // Merge: override extends default
            return {
              allow: [...defaultRules.allow, ...overrideRules.allow],
              deny: [...defaultRules.deny, ...overrideRules.deny],
            };
          }
        }
      }
    }

    // Apply grants from config
    const grants = this.policy.grants.filter(g => g.type === type);
    if (grants.length > 0) {
      return {
        allow: [...defaultRules.allow, ...grants.map(g => g.pattern)],
        deny: defaultRules.deny,
      };
    }

    return defaultRules;
  }

  /**
   * Get effective policy mode, applying runbook overrides.
   *
   * @returns The effective policy mode
   */
  private getEffectiveMode(): 'prompted' | 'execute' | 'deny' {
    if (this.options.runbookPath) {
      for (const override of this.policy.overrides) {
        if (picomatch.isMatch(this.options.runbookPath, override.runbook) && override.mode) {
          return override.mode;
        }
      }
    }
    return this.policy.default.mode;
  }

  /**
   * Match a string against a glob pattern.
   *
   * @param str - String to match
   * @param pattern - Glob pattern
   * @returns True if matches
   */
  private matchPattern(str: string, pattern: string): boolean {
    return picomatch.isMatch(str, pattern, { nocase: true });
  }

  /**
   * Match a path against a pattern with placeholder resolution.
   *
   * @param absolutePath - Absolute path to match
   * @param pattern - Pattern with optional {repo}, {tmp} placeholders
   * @returns True if matches
   */
  private matchPathPattern(absolutePath: string, pattern: string): boolean {
    // Resolve placeholders
    const resolvedPattern = pattern
      .replace(/\{repo\}/g, this.repoRoot)
      .replace(/\{tmp\}/g, this.tmpDir);

    return picomatch.isMatch(absolutePath, resolvedPattern, {
      dot: true, // Match dotfiles
    });
  }

  /**
   * Find the first matching pattern from a list.
   *
   * @param str - String to match
   * @param patterns - Array of patterns to check
   * @returns The matching pattern or null
   */
  private findMatchingPattern(str: string, patterns: string[]): string | null {
    for (const pattern of patterns) {
      if (this.matchPattern(str, pattern)) {
        return pattern;
      }
    }
    return null;
  }

  /**
   * Find the first matching path pattern from a list.
   *
   * @param absolutePath - Absolute path to match
   * @param patterns - Array of patterns to check
   * @returns The matching pattern or null
   */
  private findMatchingPathPattern(absolutePath: string, patterns: string[]): string | null {
    for (const pattern of patterns) {
      if (this.matchPathPattern(absolutePath, pattern)) {
        return pattern;
      }
    }
    return null;
  }
}

/**
 * Create a policy evaluator with the default policy.
 *
 * @param options - Evaluator options
 * @returns Configured policy evaluator
 */
export function createDefaultEvaluator(options?: PolicyEvaluatorOptions): PolicyEvaluator {
  return new PolicyEvaluator(DEFAULT_POLICY, options);
}
