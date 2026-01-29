// packages/claude-code-plugin/src/shared/config.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { type RundownPluginConfig, type GateConfig } from './types.js';
import { fileExists } from './utils.js';
import { logger } from './logger.js';

const KNOWN_HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
  'SubagentEnd',
  'UserPromptSubmit',
  'SlashCommandStart',
  'SlashCommandEnd',
  'SkillStart',
  'SkillEnd',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'Notification',
  'PreCompact',
  'PermissionRequest'
];

const KNOWN_ACTIONS = ['CONTINUE', 'BLOCK', 'STOP'];

/**
 * Validate file patterns in gate configuration.
 * Validates types only - does not validate glob syntax (matches Jest/ESLint behavior).
 * Called during config loading for fail-fast type checking.
 *
 * @param gateConfig - Gate configuration to validate
 * @throws Error if any pattern is not a string
 */
export function validateFilePatterns(gateConfig: GateConfig): void {
  if (!gateConfig.file_patterns) {
    return; // No patterns to validate
  }

  if (!Array.isArray(gateConfig.file_patterns)) {
    throw new Error('Invalid file patterns: expected string[]');
  }

  if (gateConfig.file_patterns.length === 0) {
    return; // Empty array is valid
  }

  for (const pattern of gateConfig.file_patterns) {
    if (typeof pattern !== 'string') {
      throw new Error(`Invalid file pattern: expected string, got ${typeof pattern}`);
    }
    // No syntax validation - matches ecosystem patterns (Jest, ESLint, Webpack)
  }
}

function validateGateConfig(gateName: string, gateConfig: GateConfig): void {
  const hasPlugin = gateConfig.plugin !== undefined;
  const hasGate = gateConfig.gate !== undefined;
  const hasCommand = gateConfig.command !== undefined;

  // plugin requires gate
  if (hasPlugin && !hasGate) {
    throw new Error(`Gate '${gateName}' has 'plugin' but missing 'gate' field`);
  }

  // gate requires plugin
  if (hasGate && !hasPlugin) {
    throw new Error(`Gate '${gateName}' has 'gate' but missing 'plugin' field`);
  }

  // command is mutually exclusive with plugin/gate
  if (hasCommand && (hasPlugin || hasGate)) {
    throw new Error(`Gate '${gateName}' cannot have both 'command' and 'plugin/gate'`);
  }
}

/**
 * Validate config invariants to catch configuration errors early.
 * Throws descriptive errors when invariants are violated.
 *
 * @param config - The RundownPluginConfig to validate
 * @throws Error if hook event names are unknown
 * @throws Error if gates referenced in hooks don't exist
 * @throws Error if gate actions are invalid
 * @throws Error if gate file patterns are invalid
 */
export function validateConfig(config: RundownPluginConfig): void {
  // Invariant: Hook event names must be known types
  for (const hookName of Object.keys(config.hooks)) {
    if (!KNOWN_HOOK_EVENTS.includes(hookName)) {
      throw new Error(
        `Unknown hook event: ${hookName}. Must be one of: ${KNOWN_HOOK_EVENTS.join(', ')}`
      );
    }
  }

  // Invariant: Gates referenced in hooks must exist in gates config
  for (const [hookName, hookConfig] of Object.entries(config.hooks)) {
    if (hookConfig.gates) {
      for (const gateName of hookConfig.gates) {
        if (!(gateName in config.gates)) {
          throw new Error(`Hook '${hookName}' references undefined gate '${gateName}'`);
        }
      }
    }
  }

  // Invariant: Gate actions must be CONTINUE/BLOCK/STOP or reference existing gates
  for (const [gateName, gateConfig] of Object.entries(config.gates)) {
    // Validate gate structure first
    validateGateConfig(gateName, gateConfig);

    // Validate file patterns if specified
    try {
      validateFilePatterns(gateConfig);
    } catch (error) {
      throw new Error(
        `Gate "${gateName}" has invalid configuration: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    for (const action of [gateConfig.on_pass, gateConfig.on_fail]) {
      if (action && !KNOWN_ACTIONS.includes(action) && !(action in config.gates)) {
        throw new Error(
          `Gate '${gateName}' action '${action}' is not CONTINUE/BLOCK/STOP or valid gate name`
        );
      }
    }

  }
}

/**
 * Resolve plugin path using sibling convention.
 * Assumes plugins are installed as siblings under the same parent directory.
 *
 * SECURITY: Plugin names are validated to prevent path traversal attacks.
 * This does NOT mean untrusted plugins are safe - plugins are trusted by virtue
 * of being explicitly installed by the user. This validation only prevents
 * accidental or malicious config entries from accessing arbitrary paths.
 *
 * @param pluginName - Name of the plugin to resolve
 * @returns Absolute path to the plugin root
 * @throws Error if CLAUDE_PLUGIN_ROOT is not set or plugin name is invalid
 */
export function resolvePluginPath(pluginName: string): string {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (!pluginRoot) {
    throw new Error('Cannot resolve plugin path: CLAUDE_PLUGIN_ROOT not set');
  }

  // Security: Reject empty plugin names
  if (!pluginName) {
    throw new Error(`Invalid plugin name: '${pluginName}' (must be non-empty)`);
  }

  // Security: Reject plugin names with path separators or parent references
  // Prevents path traversal attacks like "../../../etc", "foo/bar", ".", or ".."
  if (pluginName.includes('/') || pluginName.includes('\\') || pluginName === '.' || pluginName === '..' || pluginName.includes('..')) {
    throw new Error(`Invalid plugin name: '${pluginName}' (must not contain path separators)`);
  }

  // Sibling convention: plugins are in same parent directory
  // e.g., ~/.claude/plugins/rundown -> ~/.claude/plugins/cipherpowers
  return path.resolve(pluginRoot, '..', pluginName);
}

/**
 * Get the plugin root directory from CLAUDE_PLUGIN_ROOT env var.
 * Claude Code sets this automatically during hook execution.
 */
function getPluginRoot(): string | null {
  return process.env.CLAUDE_PLUGIN_ROOT ?? null;
}

/**
 * Load a single config file from disk.
 *
 * @param configPath - Absolute path to the configuration file
 * @returns The parsed RundownPluginConfig, or null if file doesn't exist
 * @throws Error if file exists but contains invalid JSON
 */
export async function loadConfigFile(configPath: string): Promise<RundownPluginConfig | null> {
  if (await fileExists(configPath)) {
    const content = await fs.readFile(configPath, 'utf-8');
    return JSON.parse(content) as RundownPluginConfig;
  }
  return null;
}

/**
 * Merge two configs. Project config takes precedence over plugin config.
 * - hooks: project hooks override plugin hooks for same event
 * - gates: project gates override plugin gates for same name
 */
function mergeConfigs(pluginConfig: RundownPluginConfig, projectConfig: RundownPluginConfig): RundownPluginConfig {
  return {
    hooks: {
      ...pluginConfig.hooks,
      ...projectConfig.hooks
    },
    gates: {
      ...pluginConfig.gates,
      ...projectConfig.gates
    }
  };
}

/**
 * Load and merge project and plugin configs.
 *
 * Priority:
 * 1. Project: .claude/rundown-plugin.json (highest)
 * 2. Project: rundown-plugin.json
 * 3. Plugin: ${CLAUDE_PLUGIN_ROOT}/rundown-plugin.json (fallback/defaults)
 *
 * Configs are MERGED - project overrides plugin for same keys.
 *
 * @param cwd - Current working directory to search for config files
 * @returns The merged RundownPluginConfig, or null if no config found
 * @throws Error if config is found but fails validation
 */
export async function loadConfig(cwd: string): Promise<RundownPluginConfig | null> {
  const pluginRoot = getPluginRoot();

  // Load plugin config first (defaults)
  let mergedConfig: RundownPluginConfig | null = null;

  if (pluginRoot) {
    const pluginConfigPath = path.join(pluginRoot, 'rundown-plugin.json');
    const pluginConfig = await loadConfigFile(pluginConfigPath);
    if (pluginConfig) {
      await logger.debug('Loaded plugin rundown-plugin.json', { path: pluginConfigPath });
      mergedConfig = pluginConfig;
    }
  }

  // Load project config (overrides)
  const projectPaths = [path.join(cwd, '.claude', 'rundown-plugin.json'), path.join(cwd, 'rundown-plugin.json')];

  for (const configPath of projectPaths) {
    const projectConfig = await loadConfigFile(configPath);
    if (projectConfig) {
      await logger.debug('Loaded project rundown-plugin.json', { path: configPath });
      if (mergedConfig) {
        mergedConfig = mergeConfigs(mergedConfig, projectConfig);
        await logger.debug('Merged project config with plugin config');
      } else {
        mergedConfig = projectConfig;
      }
      break; // Only load first project config found
    }
  }

  // Validate merged config
  if (mergedConfig) {
    validateConfig(mergedConfig);
  }

  return mergedConfig;
}
