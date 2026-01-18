/**
 * Policy context service for CLI.
 *
 * Stores and retrieves the loaded policy configuration and evaluator
 * for use across CLI commands.
 *
 * @module
 */

import {
  type PolicyConfig,
  type PolicyEvaluator,
  type PolicyPrompter,
  loadPolicy,
  PolicyEvaluator as Evaluator,
  PolicyPrompter as Prompter,
  DEFAULT_POLICY,
} from '@rundown/core';

/**
 * CLI policy options from command line flags.
 */
export interface PolicyCliOptions {
  /** Specific commands to allow (--allow-run) */
  allowRun?: string[];
  /** Specific read paths to allow (--allow-read) */
  allowRead?: string[];
  /** Specific write paths to allow (--allow-write) */
  allowWrite?: string[];
  /** Specific env vars to allow (--allow-env) */
  allowEnv?: string[];
  /** Allow all operations (--allow-all) */
  allowAll?: boolean;
  /** Deny all operations (--deny-all) */
  denyAll?: boolean;
  /** Path to policy config file (--policy) */
  policyPath?: string;
  /** Skip confirmation prompts (--yes) */
  yes?: boolean;
  /** Non-interactive mode - no prompts (--non-interactive) */
  nonInteractive?: boolean;
}

/**
 * Global policy context.
 *
 * Holds the loaded policy, evaluator, and prompter for the current CLI session.
 */
interface PolicyContext {
  /** Loaded policy configuration */
  policy: PolicyConfig;
  /** Path to the loaded config file (if any) */
  configPath?: string;
  /** Whether using built-in defaults */
  isDefault: boolean;
  /** Policy evaluator instance */
  evaluator: PolicyEvaluator;
  /** Policy prompter instance */
  prompter: PolicyPrompter;
  /** CLI options that were applied */
  cliOptions: PolicyCliOptions;
}

/** Global policy context storage */
let policyContext: PolicyContext | null = null;

/**
 * Initialize the policy context.
 *
 * Loads policy from config file or uses defaults,
 * creates evaluator and prompter instances.
 *
 * @param options - CLI options for policy configuration
 * @param cwd - Current working directory (for config search and path resolution)
 * @returns Initialized policy context
 */
export async function initializePolicyContext(
  options: PolicyCliOptions = {},
  cwd: string = process.cwd()
): Promise<PolicyContext> {
  // Load policy from file or defaults
  const { policy, filepath, isDefault, warnings } = await loadPolicy({
    cwd,
    configPath: options.policyPath,
  });

  // Log warnings if any
  if (warnings && warnings.length > 0) {
    for (const warning of warnings) {
      console.warn(`Warning: ${warning}`);
    }
  }

  // Create evaluator with CLI grants
  const evaluator = new Evaluator(policy, {
    repoRoot: cwd,
    cliGrants: {
      run: options.allowRun,
      read: options.allowRead,
      write: options.allowWrite,
      env: options.allowEnv,
    },
    allowAll: options.allowAll,
    denyAll: options.denyAll,
  });

  // Create prompter
  const prompter = new Prompter({
    autoYes: options.yes,
    nonInteractive: options.nonInteractive ?? !process.stdin.isTTY,
    evaluator,
  });

  // Store context
  policyContext = {
    policy,
    configPath: filepath,
    isDefault,
    evaluator,
    prompter,
    cliOptions: options,
  };

  return policyContext;
}

/**
 * Get the current policy context.
 *
 * If not initialized, creates a default context with built-in policy.
 *
 * @returns Current policy context
 */
export function getPolicyContext(): PolicyContext {
  if (!policyContext) {
    // Create default context synchronously
    const evaluator = new Evaluator(DEFAULT_POLICY, {
      repoRoot: process.cwd(),
    });
    const prompter = new Prompter({
      nonInteractive: !process.stdin.isTTY,
      evaluator,
    });

    policyContext = {
      policy: DEFAULT_POLICY,
      isDefault: true,
      evaluator,
      prompter,
      cliOptions: {},
    };
  }

  return policyContext;
}

/**
 * Get the policy evaluator.
 *
 * @returns Policy evaluator from current context
 */
export function getPolicyEvaluator(): PolicyEvaluator {
  return getPolicyContext().evaluator;
}

/**
 * Get the policy prompter.
 *
 * @returns Policy prompter from current context
 */
export function getPolicyPrompter(): PolicyPrompter {
  return getPolicyContext().prompter;
}

/**
 * Check if policy enforcement is active.
 *
 * Returns false if --allow-all is set.
 *
 * @returns True if policy should be enforced
 */
export function isPolicyEnforced(): boolean {
  const context = getPolicyContext();
  return !context.cliOptions.allowAll;
}

/**
 * Reset the policy context.
 *
 * Used for testing or when switching runbooks.
 */
export function resetPolicyContext(): void {
  policyContext = null;
}

/**
 * Parse CLI policy options from commander options object.
 *
 * @param opts - Raw options from commander
 * @returns Parsed policy CLI options
 */
export function parsePolicyCliOptions(opts: Record<string, unknown>): PolicyCliOptions {
  return {
    allowRun: parseStringArray(opts.allowRun),
    allowRead: parseStringArray(opts.allowRead),
    allowWrite: parseStringArray(opts.allowWrite),
    allowEnv: parseStringArray(opts.allowEnv),
    allowAll: opts.allowAll === true,
    denyAll: opts.denyAll === true,
    policyPath: typeof opts.policy === 'string' ? opts.policy : undefined,
    yes: opts.yes === true,
    nonInteractive: opts.nonInteractive === true,
  };
}

/**
 * Parse a value that may be a string or string array.
 */
function parseStringArray(value: unknown): string[] | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') {
    // Handle comma-separated values
    return value.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string');
  }
  return undefined;
}
