/**
 * Policy schema and types for Rundown security policy layer.
 *
 * Provides Deno-inspired, explicit allowlist policy for runbook execution.
 * Default-deny with prompt-driven grants and config-based policy management.
 *
 * @module
 */

import { z } from 'zod';
import {
  CONFIG_FILE,
  CONTEXTS_DIR,
  LOCKS_DIR,
  RUNS_DIR,
  SESSION_FILE,
  WORK_DIR,
} from '../paths.js';

/**
 * Policy mode determines how permissions are handled.
 * - 'prompted': Ask user for permission (default)
 * - 'execute': Allow without prompting
 * - 'deny': Block without prompting
 */
export const PolicyModeSchema = z.enum(['prompted', 'execute', 'deny']);
/** Inferred type from {@link PolicyModeSchema}: `'prompted' | 'execute' | 'deny'`. */
export type PolicyMode = z.infer<typeof PolicyModeSchema>;

/**
 * Permission rules for a specific capability type.
 */
export const PermissionRulesSchema = z.object({
  /** Patterns to allow (glob patterns) */
  allow: z.array(z.string()).default([]),
  /** Patterns to deny (glob patterns, takes precedence over allow) */
  deny: z.array(z.string()).default([]),
});
/** Inferred type from {@link PermissionRulesSchema}: allow/deny glob pattern lists. */
export type PermissionRules = z.infer<typeof PermissionRulesSchema>;

/**
 * Default policy configuration applied to all runbooks.
 */
export const DefaultPolicySchema = z.object({
  /** Permission mode: 'prompted' | 'execute' | 'deny' */
  mode: PolicyModeSchema.default('prompted'),
  /** Command execution rules */
  run: PermissionRulesSchema.default({ allow: [], deny: [] }),
  /** File read rules (supports {repo}, {tmp} placeholders) */
  read: PermissionRulesSchema.default({ allow: [], deny: [] }),
  /** File write rules (supports {repo}, {tmp} placeholders) */
  write: PermissionRulesSchema.default({ allow: [], deny: [] }),
  /** Environment variable access rules */
  env: PermissionRulesSchema.default({ allow: [], deny: [] }),
});
/** Inferred type from {@link DefaultPolicySchema}: mode and per-capability permission rules. */
export type DefaultPolicy = z.infer<typeof DefaultPolicySchema>;

/**
 * Runbook-specific policy override.
 */
export const PolicyOverrideSchema = z.object({
  /** Runbook file pattern to match (glob) */
  runbook: z.string(),
  /** Override mode */
  mode: PolicyModeSchema.optional(),
  /** Override run rules */
  run: PermissionRulesSchema.optional(),
  /** Override read rules */
  read: PermissionRulesSchema.optional(),
  /** Override write rules */
  write: PermissionRulesSchema.optional(),
  /** Override env rules */
  env: PermissionRulesSchema.optional(),
});
/** Inferred type from {@link PolicyOverrideSchema}: runbook-specific policy overrides. */
export type PolicyOverride = z.infer<typeof PolicyOverrideSchema>;

/**
 * Persisted user grant for a specific permission.
 */
export const PolicyGrantSchema = z.object({
  /** Permission type: 'run' | 'read' | 'write' | 'env' */
  type: z.enum(['run', 'read', 'write', 'env']),
  /** The pattern that was granted */
  pattern: z.string(),
  /** Optional runbook this grant applies to (glob) */
  runbook: z.string().optional(),
  /** When the grant was created */
  grantedAt: z.iso.datetime().optional(),
  /** Grant scope: 'session' | 'permanent' */
  scope: z.enum(['session', 'permanent']).default('session'),
});
/** Inferred type from {@link PolicyGrantSchema}: a persisted user permission grant. */
export type PolicyGrant = z.infer<typeof PolicyGrantSchema>;

/**
 * Complete policy configuration.
 */
export const PolicyConfigSchema = z.object({
  /** Schema version for forward compatibility */
  version: z.number().default(1),
  /** Default policy applied to all runbooks */
  default: DefaultPolicySchema.default({
    mode: 'prompted',
    run: { allow: [], deny: [] },
    read: { allow: [], deny: [] },
    write: { allow: [], deny: [] },
    env: { allow: [], deny: [] },
  }),
  /** Runbook-specific policy overrides */
  overrides: z.array(PolicyOverrideSchema).default([]),
  /** Persisted user grants */
  grants: z.array(PolicyGrantSchema).default([]),
  /** Helper module paths to load (relative to project root) */
  helpers: z.array(z.string()).optional(),
});
/** Inferred type from {@link PolicyConfigSchema}: complete policy with defaults, overrides, and grants. */
export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;

/**
 * Built-in default policy with safe defaults.
 *
 * This policy:
 * - Uses 'prompted' mode by default (ask user before executing)
 * - Allows common safe development commands
 * - Denies dangerous system commands
 * - Restricts file access to repo and temp directories
 * - Filters sensitive environment variables
 */
export const DEFAULT_POLICY: PolicyConfig = {
  version: 1,
  default: {
    mode: 'prompted',
    run: {
      allow: [
        // Version control
        'git',
        // Node.js ecosystem
        'node',
        'npm',
        'npx',
        'pnpm',
        'yarn',
        'bun',
        // Build tools
        'tsc',
        'esbuild',
        'vite',
        'webpack',
        'rollup',
        // Linting and formatting
        'eslint',
        'prettier',
        'biome',
        // Testing
        'jest',
        'vitest',
        'mocha',
        'playwright',
        'cypress',
        // Other languages
        'python',
        'python3',
        'pip',
        'pip3',
        'go',
        'cargo',
        'rustc',
        'make',
        'cmake',
        // Rundown itself
        'rd',
        'rundown',
        'rdpath',
        'rdx',
      ],
      deny: [
        // System administration
        'sudo',
        'su',
        'passwd',
        'useradd',
        'usermod',
        'userdel',
        'chown',
        'chmod',
        // Network tools that could exfiltrate data
        'curl',
        'wget',
        'nc',
        'netcat',
        'ncat',
        'ssh',
        'scp',
        'sftp',
        'rsync',
        // Dangerous shell operations
        'rm',
        'rmdir',
        'mv',
        'dd',
        'mkfs',
        'fdisk',
        'parted',
        // Process control
        'kill',
        'killall',
        'pkill',
        // Container/VM escape vectors
        'docker',
        'podman',
        'kubectl',
        'helm',
      ],
    },
    read: {
      allow: ['{repo}/**', '{tmp}/**'],
      deny: [
        '**/.env',
        '**/.env.*',
        '**/credentials.json',
        '**/*secret*',
        '**/*password*',
        '**/id_rsa',
        '**/id_ed25519',
        '**/*.pem',
        '**/*.key',
      ],
    },
    write: {
      allow: [
        '{repo}/.claude/**',
        `{repo}/${RUNS_DIR}/**`,
        `{repo}/${LOCKS_DIR}/**`,
        `{repo}/${CONTEXTS_DIR}/**`,
        // Single-file entries: update this list when new top-level .rundown/*.json artifacts are introduced
        `{repo}/${SESSION_FILE}`,
        `{repo}/${WORK_DIR}/**`,
        '{repo}/node_modules/**',
        '{repo}/dist/**',
        '{repo}/build/**',
        '{repo}/.next/**',
        '{tmp}/**',
      ],
      deny: [
        '**/.env',
        '**/.env.*',
        '**/credentials.json',
        '**/*secret*',
        '**/*password*',
        `{repo}/${CONFIG_FILE}`, // user-managed; auto-loaded by findConfigFile()
      ],
    },
    env: {
      allow: [
        'PATH',
        'HOME',
        'USER',
        'SHELL',
        'TERM',
        'LANG',
        'LC_*',
        'TMPDIR',
        'TMP',
        'TEMP',
        'CI',
        'NODE_ENV',
        'DEBUG',
        'npm_*',
        'RUNDOWN_*',
      ],
      deny: [
        '*_TOKEN',
        '*_KEY',
        '*_SECRET',
        '*_PASSWORD',
        '*_CREDENTIAL',
        'AWS_*',
        'GCP_*',
        'AZURE_*',
        'GOOGLE_*',
        'KUBECONFIG',
        'DOCKER_*',
        'SSH_*',
        'GPG_*',
        'GITHUB_TOKEN',
        'GITLAB_TOKEN',
        'NPM_TOKEN',
      ],
    },
  },
  overrides: [],
  grants: [],
};

/**
 * Derive a Landlock-compatible copy of a policy by clearing the file-access
 * deny lists.
 *
 * Landlock is an allow-list-only sandbox: it grants access to paths and denies
 * everything else, so it cannot express "allow this tree *except* these files".
 * Subtractive `read`/`write` deny rules are therefore unrepresentable, and the
 * Linux backend fails closed when it sees them. This helper strips only those
 * two deny lists, leaving the `run`/`env` denies intact — those are enforced by
 * the policy evaluator (not the sandbox), so they remain effective under
 * Landlock. All `allow` lists, `overrides`, and `grants` are preserved verbatim.
 *
 * The nested rule objects are deep-copied so the derived policy never shares
 * mutable references with its source.
 *
 * @param policy - The source policy to derive from
 * @returns A copy with empty `default.read.deny` and `default.write.deny`
 */
function toAllowListOnly(policy: PolicyConfig): PolicyConfig {
  return {
    ...policy,
    default: {
      ...policy.default,
      run: { allow: [...policy.default.run.allow], deny: [...policy.default.run.deny] },
      read: { allow: [...policy.default.read.allow], deny: [] },
      write: { allow: [...policy.default.write.allow], deny: [] },
      env: { allow: [...policy.default.env.allow], deny: [...policy.default.env.deny] },
    },
    overrides: [...policy.overrides],
    grants: [...policy.grants],
  };
}

/**
 * Linux-specific built-in default policy: {@link DEFAULT_POLICY} with the
 * file-access (`read`/`write`) deny lists removed.
 *
 * Linux Landlock cannot enforce subtractive file denies (see
 * {@link toAllowListOnly}), so the canonical default would fail closed and block
 * every command once the sandbox engages. This allow-list-only variant lets
 * Landlock confine commands to the granted `{repo}/**` + `{tmp}/**` trees
 * instead. Trade-off: a permitted command can read/write secret-named files that
 * live *inside* those trees. The `run`/`env` deny lists are retained (the policy
 * evaluator enforces them regardless of platform), so command-exfiltration tools
 * and sensitive environment variables remain blocked.
 */
export const DEFAULT_POLICY_LINUX: PolicyConfig = toAllowListOnly(DEFAULT_POLICY);

/**
 * Resolve the built-in default policy appropriate for a platform.
 *
 * Linux returns the allow-list-only {@link DEFAULT_POLICY_LINUX} so the Landlock
 * sandbox can engage out of the box. macOS (Seatbelt enforces file denies
 * natively) and every other platform (no sandbox, so file denies are moot)
 * return the canonical {@link DEFAULT_POLICY} with its secret-file deny lists
 * intact.
 *
 * This is the single source of truth for materializing the built-in default;
 * user-authored policies are unaffected and their file denies still fail closed
 * under Landlock.
 *
 * @param platform - Platform to resolve for; defaults to the current process platform
 * @returns The platform-appropriate built-in default policy
 */
export function getDefaultPolicy(platform: NodeJS.Platform = process.platform): PolicyConfig {
  return platform === 'linux' ? DEFAULT_POLICY_LINUX : DEFAULT_POLICY;
}

/**
 * Validate and parse a policy configuration object.
 *
 * @param config - Raw configuration object to validate
 * @returns Parsed and validated PolicyConfig
 * @throws {z.ZodError} When validation fails
 */
export function parsePolicy(config: unknown): PolicyConfig {
  return PolicyConfigSchema.parse(config);
}

/**
 * Safely parse a policy configuration, returning errors instead of throwing.
 *
 * @param config - Raw configuration object to validate
 * @returns Parsed PolicyConfig or null with error messages
 */
export function safeParsePolicyConfig(config: unknown): {
  success: boolean;
  data?: PolicyConfig;
  errors?: string[];
} {
  const result = PolicyConfigSchema.safeParse(config);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    errors: result.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`),
  };
}
