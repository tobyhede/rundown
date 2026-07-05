/**
 * Policy configuration loader.
 *
 * Discovers and loads policy configuration from various sources
 * using lilconfig with YAML support.
 *
 * @module
 */

import { lilconfig, lilconfigSync, type LilconfigResult } from 'lilconfig';
import * as yaml from 'js-yaml';
import { loadYaml } from '../yaml.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import {
  type PolicyConfig,
  parsePolicy,
  safeParsePolicyConfig,
  getDefaultPolicy,
} from './schema.js';
import { getErrorMessage } from '../errors.js';

const requireFromModule = createRequire(import.meta.url);

/**
 * YAML loader for lilconfig.
 *
 * @param _filepath - Path to the YAML file (unused)
 * @param content - File content
 * @returns Parsed YAML object
 */
function yamlLoader(_filepath: string, content: string): unknown {
  return loadYaml(content);
}

/**
 * Search places for policy configuration files.
 *
 * Searched in order from highest to lowest priority:
 * 1. `.rundownrc` (JSON or YAML)
 * 2. `.rundownrc.json`
 * 3. `.rundownrc.yaml`
 * 4. `.rundownrc.yml`
 * 5. `package.json` (rundown field)
 */
const SEARCH_PLACES = [
  '.rundownrc',
  '.rundownrc.json',
  '.rundownrc.yaml',
  '.rundownrc.yml',
  'package.json',
];

/**
 * Error thrown when an executable policy config (JS/CJS/MJS) is discovered
 * without explicit trust authorization.
 *
 * JavaScript policy files are not auto-discovered to prevent arbitrary code
 * execution. Users must explicitly pass `--policy` with `--trust-js-policy`.
 */
export class PolicyConfigTrustRequiredError extends Error {
  readonly filepath: string;

  /**
   * Create a trust-required error for an executable policy config.
   *
   * @param filepath - Path to the executable policy config that requires trust
   */
  constructor(filepath: string) {
    super(
      `Executable policy config requires trust: ${filepath}. ` +
        'JavaScript policy files are not auto-discovered and may execute code. ' +
        'Use YAML/JSON/package.json or rerun with --trust-js-policy.',
    );
    this.name = 'PolicyConfigTrustRequiredError';
    this.filepath = filepath;
  }
}

/**
 * Result from loading a policy configuration.
 */
export interface PolicyLoadResult {
  /** The loaded policy configuration */
  policy: PolicyConfig;
  /** Path to the config file (undefined if using defaults) */
  filepath?: string;
  /** Whether defaults were used (no config found) */
  isDefault: boolean;
  /** Any warnings during loading */
  warnings?: string[];
}

/**
 * Options for loading policy configuration.
 */
export interface PolicyLoadOptions {
  /** Starting directory for config search (defaults to cwd) */
  cwd?: string;
  /** Explicit config file path (skips search) */
  configPath?: string;
  /** Stop searching at this directory */
  stopDir?: string;
  /** Whether to use built-in defaults if no config found */
  useDefaults?: boolean;
  /** Whether to allow loading executable JavaScript policy configs */
  trustJsPolicy?: boolean;
}

/**
 * Load policy configuration.
 *
 * Searches for configuration files in the following order:
 * 1. If `configPath` is provided, loads from that path directly
 * 2. Otherwise, searches from `cwd` upward for config files
 * 3. Falls back to built-in defaults if nothing found
 *
 * @param options - Loading options
 * @returns Policy load result with config and metadata
 *
 * @example
 * ```typescript
 * // Load with defaults
 * const result = await loadPolicy();
 *
 * // Load from specific directory
 * const result = await loadPolicy({ cwd: '/path/to/project' });
 *
 * // Load specific file
 * const result = await loadPolicy({ configPath: './custom-policy.yaml' });
 * ```
 */
export async function loadPolicy(options: PolicyLoadOptions = {}): Promise<PolicyLoadResult> {
  const {
    cwd = process.cwd(),
    configPath,
    stopDir,
    useDefaults = true,
    trustJsPolicy = false,
  } = options;

  // If explicit config path provided, load it directly
  if (configPath) {
    return loadPolicyFromFile(configPath, { trustJsPolicy });
  }

  // Create lilconfig instance with YAML support
  const explorer = lilconfig('rundown', {
    searchPlaces: SEARCH_PLACES,
    loaders: {
      '.yaml': yamlLoader,
      '.yml': yamlLoader,
      noExt: yamlLoader, // .rundownrc without extension
    },
    stopDir,
  });

  let result: LilconfigResult;
  try {
    result = await explorer.search(cwd);
  } catch (error) {
    throw new Error(`Error loading policy config: ${getErrorMessage(error)}`);
  }

  if (result?.config !== undefined) {
    // Extract policy field if from package.json

    const config: unknown = result.filepath.endsWith('package.json')
      ? ((result.config as { rundown?: unknown }).rundown ?? result.config)
      : result.config;

    // Validate the configuration
    const parseResult = safeParsePolicyConfig(config);

    if (parseResult.success && parseResult.data) {
      return {
        policy: parseResult.data,
        filepath: result.filepath,
        isDefault: false,
      };
    }

    throw new Error(
      `Invalid policy configuration at ${result.filepath}: ${
        parseResult.errors?.join(', ') ?? 'unknown error'
      }`,
    );
  }

  // No config found - use defaults if allowed
  if (useDefaults) {
    return {
      policy: getDefaultPolicy(),
      isDefault: true,
    };
  }

  throw new Error('No policy configuration found');
}

/**
 * Load policy configuration from a specific file.
 *
 * @param filepath - Path to the configuration file
 * @param options - Load options
 * @param options.trustJsPolicy - Whether to allow loading executable JS config files (default: false)
 * @returns Policy load result
 * @throws {PolicyConfigTrustRequiredError} When a JS config is loaded without `trustJsPolicy`
 */
export async function loadPolicyFromFile(
  filepath: string,
  options: { trustJsPolicy?: boolean } = {},
): Promise<PolicyLoadResult> {
  const absolutePath = path.resolve(filepath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Policy config file not found: ${absolutePath}`);
  }

  const content = await fs.promises.readFile(absolutePath, 'utf-8');
  const ext = path.extname(filepath).toLowerCase();

  let config: unknown;

  if (ext === '.json' || filepath.endsWith('package.json')) {
    config = JSON.parse(content);
    // Handle package.json case
    if (filepath.endsWith('package.json')) {
      config = (config as { rundown?: unknown }).rundown;
      if (!config) {
        throw new Error('No "rundown" field found in package.json');
      }
    }
  } else if (ext === '.yaml' || ext === '.yml' || ext === '') {
    config = loadYaml(content);
  } else if (ext === '.js' || ext === '.cjs' || ext === '.mjs') {
    if (!options.trustJsPolicy) {
      throw new PolicyConfigTrustRequiredError(absolutePath);
    }
    // Dynamic import for JS configs
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const module = await import(absolutePath);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    config = module.default ?? module;
  } else {
    throw new Error(`Unsupported config file extension: ${ext}`);
  }

  const policy = parsePolicy(config);

  return {
    policy,
    filepath: absolutePath,
    isDefault: false,
  };
}

/**
 * Synchronously load policy configuration.
 *
 * Uses synchronous file operations - prefer async `loadPolicy` when possible.
 *
 * @param options - Loading options
 * @returns Policy load result
 * @throws {PolicyConfigTrustRequiredError} When a JS config is loaded without `trustJsPolicy`
 * @throws {Error} When config file has an unsupported extension or cannot be parsed
 * @throws {Error} When configuration is invalid and `useDefaults` is false
 */
export function loadPolicySync(options: PolicyLoadOptions = {}): PolicyLoadResult {
  const {
    cwd = process.cwd(),
    configPath,
    stopDir,
    useDefaults = true,
    trustJsPolicy = false,
  } = options;

  // If explicit config path provided, load it directly
  if (configPath) {
    return loadPolicyFromFileSync(configPath, { trustJsPolicy });
  }

  // Create lilconfig instance for sync search
  const explorer = lilconfigSync('rundown', {
    searchPlaces: SEARCH_PLACES,
    loaders: {
      '.yaml': yamlLoader,
      '.yml': yamlLoader,
      noExt: yamlLoader,
      '.mjs': () => {
        throw new Error(
          'ES module config files (.mjs) require async loading. Use loadPolicy() instead of loadPolicySync().',
        );
      },
    },
    stopDir,
  });

  let result: ReturnType<typeof explorer.search>;
  try {
    result = explorer.search(cwd);
  } catch (error) {
    throw new Error(`Error loading policy config: ${getErrorMessage(error)}`);
  }

  if (result?.config !== undefined) {
    const config: unknown = result.filepath.endsWith('package.json')
      ? ((result.config as { rundown?: unknown }).rundown ?? result.config)
      : result.config;

    const parseResult = safeParsePolicyConfig(config);

    if (parseResult.success && parseResult.data) {
      return {
        policy: parseResult.data,
        filepath: result.filepath,
        isDefault: false,
      };
    }

    throw new Error(
      `Invalid policy configuration at ${result.filepath}: ${
        parseResult.errors?.join(', ') ?? 'unknown error'
      }`,
    );
  }

  if (useDefaults) {
    return {
      policy: getDefaultPolicy(),
      isDefault: true,
    };
  }

  throw new Error('No policy configuration found');
}

/**
 * Synchronously load policy from a specific file.
 *
 * @param filepath - Path to the configuration file
 * @param options - Load options
 * @param options.trustJsPolicy - Whether to allow loading executable JS config files (default: false)
 * @returns Policy load result
 * @throws {PolicyConfigTrustRequiredError} When a JS config is loaded without `trustJsPolicy`
 */
export function loadPolicyFromFileSync(
  filepath: string,
  options: { trustJsPolicy?: boolean } = {},
): PolicyLoadResult {
  const absolutePath = path.resolve(filepath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Policy config file not found: ${absolutePath}`);
  }

  const content = fs.readFileSync(absolutePath, 'utf-8');
  const ext = path.extname(filepath).toLowerCase();

  let config: unknown;

  if (ext === '.json' || filepath.endsWith('package.json')) {
    config = JSON.parse(content);
    if (filepath.endsWith('package.json')) {
      config = (config as { rundown?: unknown }).rundown;
      if (!config) {
        throw new Error('No "rundown" field found in package.json');
      }
    }
  } else if (ext === '.yaml' || ext === '.yml' || ext === '') {
    config = loadYaml(content);
  } else if (ext === '.js' || ext === '.cjs') {
    if (!options.trustJsPolicy) {
      throw new PolicyConfigTrustRequiredError(absolutePath);
    }
    // Note: .mjs requires async import

    const module = requireFromModule(absolutePath) as { __esModule?: boolean; default?: unknown };
    config = module.__esModule && 'default' in module ? module.default : module;
  } else if (ext === '.mjs') {
    if (!options.trustJsPolicy) {
      throw new PolicyConfigTrustRequiredError(absolutePath);
    }
    throw new Error(
      'ES module config files (.mjs) require async loading. Use loadPolicy() instead of loadPolicySync().',
    );
  } else {
    throw new Error(`Unsupported config file extension: ${ext}`);
  }

  const policy = parsePolicy(config);

  return {
    policy,
    filepath: absolutePath,
    isDefault: false,
  };
}

/**
 * Merge multiple policy configurations.
 *
 * Later policies take precedence for conflicting settings.
 * Arrays (allow/deny lists) are concatenated.
 *
 * @param policies - Array of policies to merge
 * @returns Merged policy configuration
 */
export function mergePolicies(...policies: PolicyConfig[]): PolicyConfig {
  if (policies.length === 0) {
    return getDefaultPolicy();
  }

  if (policies.length === 1) {
    return policies[0];
  }

  return policies.reduce((merged, policy) => {
    return {
      version: policy.version,
      default: {
        mode: policy.default.mode,
        network: policy.default.network,
        run: {
          allow: [...merged.default.run.allow, ...policy.default.run.allow],
          deny: [...merged.default.run.deny, ...policy.default.run.deny],
        },
        read: {
          allow: [...merged.default.read.allow, ...policy.default.read.allow],
          deny: [...merged.default.read.deny, ...policy.default.read.deny],
        },
        write: {
          allow: [...merged.default.write.allow, ...policy.default.write.allow],
          deny: [...merged.default.write.deny, ...policy.default.write.deny],
        },
        env: {
          allow: [...merged.default.env.allow, ...policy.default.env.allow],
          deny: [...merged.default.env.deny, ...policy.default.env.deny],
        },
      },
      overrides: [...merged.overrides, ...policy.overrides],
      grants: [...merged.grants, ...policy.grants],
    };
  });
}

/**
 * Write a policy configuration to a file.
 *
 * @param policy - Policy configuration to write
 * @param filepath - Output file path
 */
export async function writePolicyConfig(policy: PolicyConfig, filepath: string): Promise<void> {
  const ext = path.extname(filepath).toLowerCase();
  let content: string;

  if (ext === '.json') {
    content = JSON.stringify(policy, null, 2);
  } else if (ext === '.yaml' || ext === '.yml') {
    content = yaml.dump(policy, { indent: 2 });
  } else {
    // Default to YAML
    content = yaml.dump(policy, { indent: 2 });
  }

  await fs.promises.writeFile(filepath, content, 'utf-8');
}
