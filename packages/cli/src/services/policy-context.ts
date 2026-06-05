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
} from '@rundown-org/core';

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
  /** Trust executable JavaScript policy configs (--trust-js-policy) */
  trustJsPolicy?: boolean;
  /** Skip confirmation prompts (--yes) */
  yes?: boolean;
  /** Non-interactive mode - no prompts (--non-interactive) */
  nonInteractive?: boolean;
  /** Enable OS-level sandbox for file access enforcement (--sandbox) */
  sandbox?: boolean;
  /** Fail if sandbox is unavailable (--sandbox-strict) */
  sandboxStrict?: boolean;
  /** Disable sandbox enforcement (--no-sandbox) */
  noSandbox?: boolean;
  /** Helper module paths from --helpers flag (comma-separated string or string[], resolved at startup). */
  helpers?: string[];
}

/**
 * Error thrown when mutually exclusive CLI policy flags are provided together.
 */
export class PolicyCliOptionConflictError extends Error {
  /** CLI flags that cannot be used together. */
  readonly flags: readonly string[];

  /**
   * Create a policy CLI option conflict error.
   *
   * @param flags - Conflicting CLI flags.
   */
  constructor(flags: readonly string[]) {
    super(`Conflicting policy options: ${flags.join(' and ')} cannot be used together.`);
    this.name = 'PolicyCliOptionConflictError';
    this.flags = flags;
  }
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
 * @throws {PolicyCliOptionConflictError} When mutually exclusive policy flags are present
 */
export async function initializePolicyContext(
  options: PolicyCliOptions = {},
  cwd: string = process.cwd(),
): Promise<PolicyContext> {
  assertValidPolicyCliOptions(options);

  // Load policy from file or defaults
  const { policy, filepath, isDefault, warnings } = await loadPolicy({
    cwd,
    configPath: options.policyPath,
    trustJsPolicy: options.trustJsPolicy,
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
 * @throws {PolicyCliOptionConflictError} When mutually exclusive policy flags are present
 */
export function parsePolicyCliOptions(opts: Record<string, unknown>): PolicyCliOptions {
  const parsed = {
    allowRun: parseStringArray(opts.allowRun),
    allowRead: parseStringArray(opts.allowRead),
    allowWrite: parseStringArray(opts.allowWrite),
    allowEnv: parseStringArray(opts.allowEnv),
    allowAll: opts.allowAll === true,
    denyAll: opts.denyAll === true,
    policyPath: typeof opts.policy === 'string' ? opts.policy : undefined,
    trustJsPolicy: opts.trustJsPolicy === true,
    yes: opts.yes === true,
    nonInteractive: opts.nonInteractive === true,
    sandbox: typeof opts.sandbox === 'boolean' ? opts.sandbox : undefined,
    sandboxStrict: opts.sandboxStrict === true,
    noSandbox: opts.noSandbox === true || opts.sandbox === false,
    helpers: parseStringArray(opts.helpers),
  };
  assertValidPolicyCliOptions(parsed);
  return parsed;
}

/**
 * Get the sandbox options from the current policy context.
 *
 * @returns Object with sandbox and sandboxStrict settings
 */
export function getSandboxOptions(): { sandbox: boolean; sandboxStrict: boolean } {
  const context = getPolicyContext();
  const opts = context.cliOptions;

  // --no-sandbox disables sandboxing
  if (opts.noSandbox) {
    return { sandbox: false, sandboxStrict: false };
  }

  // --allow-all implies no sandbox (trust mode)
  if (opts.allowAll) {
    return { sandbox: false, sandboxStrict: false };
  }

  return {
    // Default to true (enable sandbox) unless explicitly disabled
    sandbox: opts.sandbox !== false,
    sandboxStrict: opts.sandboxStrict ?? false,
  };
}

/**
 * Parse a value that may be a string or string array.
 * @param value - Raw value to parse (string, string array, or other)
 * @returns Parsed string array, or undefined if value is falsy or unsupported type
 */
function parseStringArray(value: unknown): string[] | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') {
    // Handle comma-separated values
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string');
  }
  return undefined;
}

/**
 * Validate policy CLI option combinations.
 *
 * @param options - Parsed CLI policy options.
 * @throws {PolicyCliOptionConflictError} When mutually exclusive policy flags are present
 */
function assertValidPolicyCliOptions(options: PolicyCliOptions): void {
  if (options.allowAll && options.denyAll) {
    throw new PolicyCliOptionConflictError(['--allow-all', '--deny-all']);
  }

  if (options.noSandbox && options.sandboxStrict) {
    throw new PolicyCliOptionConflictError(['--no-sandbox', '--sandbox-strict']);
  }
}
