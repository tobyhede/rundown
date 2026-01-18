/**
 * Policy schema and types for Rundown security policy layer.
 *
 * Provides Deno-inspired, explicit allowlist policy for runbook execution.
 * Default-deny with prompt-driven grants and config-based policy management.
 *
 * @module
 */

import { z } from 'zod';

/**
 * Policy mode determines how permissions are handled.
 * - 'prompted': Ask user for permission (default)
 * - 'execute': Allow without prompting
 * - 'deny': Block without prompting
 */
export const PolicyModeSchema = z.enum(['prompted', 'execute', 'deny']);
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
  grantedAt: z.string().datetime().optional(),
  /** Grant scope: 'session' | 'permanent' */
  scope: z.enum(['session', 'permanent']).default('session'),
});
export type PolicyGrant = z.infer<typeof PolicyGrantSchema>;

/**
 * Complete policy configuration.
 */
export const PolicyConfigSchema = z.object({
  /** Schema version for forward compatibility */
  version: z.number().default(1),
  /** Default policy applied to all runbooks */
  default: DefaultPolicySchema.default({}),
  /** Runbook-specific policy overrides */
  overrides: z.array(PolicyOverrideSchema).default([]),
  /** Persisted user grants */
  grants: z.array(PolicyGrantSchema).default([]),
});
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
        'node', 'npm', 'npx', 'pnpm', 'yarn', 'bun',
        // Build tools
        'tsc', 'esbuild', 'vite', 'webpack', 'rollup',
        // Linting and formatting
        'eslint', 'prettier', 'biome',
        // Testing
        'jest', 'vitest', 'mocha', 'playwright', 'cypress',
        // Other languages
        'python', 'python3', 'pip', 'pip3',
        'go', 'cargo', 'rustc',
        'make', 'cmake',
        // Rundown itself
        'rd', 'rundown',
      ],
      deny: [
        // System administration
        'sudo', 'su', 'passwd', 'useradd', 'usermod', 'userdel',
        'chown', 'chmod',
        // Network tools that could exfiltrate data
        'curl', 'wget', 'nc', 'netcat', 'ncat',
        'ssh', 'scp', 'sftp', 'rsync',
        // Dangerous shell operations
        'rm', 'rmdir', 'mv',
        'dd', 'mkfs', 'fdisk', 'parted',
        // Process control
        'kill', 'killall', 'pkill',
        // Container/VM escape vectors
        'docker', 'podman', 'kubectl', 'helm',
      ],
    },
    read: {
      allow: [
        '{repo}/**',
        '{tmp}/**',
      ],
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
      ],
    },
    env: {
      allow: [
        'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG',
        'LC_*', 'TMPDIR', 'TMP', 'TEMP',
        'CI', 'NODE_ENV', 'DEBUG',
        'npm_*', 'RUNDOWN_*',
      ],
      deny: [
        '*_TOKEN', '*_KEY', '*_SECRET', '*_PASSWORD', '*_CREDENTIAL',
        'AWS_*', 'GCP_*', 'AZURE_*', 'GOOGLE_*',
        'KUBECONFIG', 'DOCKER_*',
        'SSH_*', 'GPG_*',
        'GITHUB_TOKEN', 'GITLAB_TOKEN', 'NPM_TOKEN',
      ],
    },
  },
  overrides: [],
  grants: [],
};

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
    errors: result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`),
  };
}
