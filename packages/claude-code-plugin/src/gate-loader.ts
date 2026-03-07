// gate-loader.ts
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import {
  type HookInput,
  type GateResult,
  type GateConfig,
  resolvePluginPath,
  loadConfigFile,
} from './shared/index.js';
import * as builtinGates from './gates/index.js';

const execAsync = promisify(exec);

/**
 * Result of executing a shell command within a gate.
 */
export interface ShellResult {
  exitCode: number;
  output: string;
}

/**
 * Type guard for execution errors from child_process
 * Represents error objects that can be thrown by exec/execSync
 */
interface ExecError extends Error {
  killed?: boolean;
  signal?: string;
  code?: number;
  stdout?: string;
  stderr?: string;
}

/**
 * Type guard to safely access error properties.
 * Returns the error cast to ExecError, handling both CommonJS and ESM error objects.
 * @param error - The caught error value to normalize
 * @returns Normalized ExecError with safe property access
 */
function asExecError(error: unknown): ExecError {
  // Check if error is an object with Error-like properties
  // (handles both instanceof Error and plain objects from ESM)
  if (error !== null && typeof error === 'object') {
    const err = error as Record<string, unknown>;
    return {
      name: typeof err.name === 'string' ? err.name : 'Error',
      message: typeof err.message === 'string' ? err.message : 'Unknown error',
      killed: typeof err.killed === 'boolean' ? err.killed : false,
      signal: typeof err.signal === 'string' ? err.signal : undefined,
      code: typeof err.code === 'number' ? err.code : undefined,
      stdout: typeof err.stdout === 'string' ? err.stdout : '',
      stderr: typeof err.stderr === 'string' ? err.stderr : '',
    };
  }
  return {
    name: 'Error',
    message: typeof error === 'string' ? error : 'Unknown error',
    killed: false,
    signal: undefined,
    code: 1,
    stdout: '',
    stderr: '',
  };
}

/**
 * Execute shell command from gate configuration with timeout.
 *
 * SECURITY MODEL: rundown-plugin.json is trusted configuration (project-controlled, not user input).
 * Commands are executed without sanitization because:
 * 1. rundown-plugin.json is committed to repository or managed by project admins
 * 2. Users cannot inject commands without write access to rundown-plugin.json
 * 3. If rundown-plugin.json is compromised, the project is already compromised
 *
 * This is equivalent to package.json scripts or Makefile targets - trusted project configuration.
 *
 * ERROR HANDLING: Commands timeout after 30 seconds to prevent hung gates.
 * @param command - Shell command string to execute
 * @param cwd - Working directory for command execution
 * @param timeoutMs - Maximum execution time in milliseconds (default 30000)
 * @returns Shell result with exit code and combined stdout/stderr output
 */
export async function executeShellCommand(
  command: string,
  cwd: string,
  timeoutMs = 30000,
): Promise<ShellResult> {
  try {
    const { stdout, stderr } = await execAsync(command, { cwd, timeout: timeoutMs });
    return {
      exitCode: 0,
      output: stdout + stderr,
    };
  } catch (error: unknown) {
    // Type guard - safely access error properties
    const err = asExecError(error);

    // Check for timeout: killed=true and signal='SIGTERM'
    if (err.killed && err.signal === 'SIGTERM') {
      return {
        exitCode: 124, // Standard timeout exit code
        output: `Command timed out after ${String(timeoutMs)}ms`,
      };
    }

    return {
      exitCode: err.code ?? 1,
      output: (err.stdout ?? '') + (err.stderr ?? ''),
    };
  }
}

/**
 * Load and execute a built-in TypeScript gate
 *
 * Built-in gates are TypeScript modules in src/gates/ that export an execute function.
 * Gate names use kebab-case and are mapped to camelCase module names:
 * - "plugin-path" → pluginPath
 * - "custom-gate" → customGate
 * @param gateName - Kebab-case gate name to look up in built-in modules
 * @param input - Hook input to pass to the gate's execute function
 * @returns Gate result from the built-in gate module
 */
export async function executeBuiltinGate(gateName: string, input: HookInput): Promise<GateResult> {
  try {
    // Convert kebab-case to camelCase for module lookup
    // "plugin-path" -> "pluginPath"
    const moduleName = gateName.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

    // Look up the gate module from static imports
    const gateModule = (
      builtinGates as Record<
        string,
        { execute?: (input: HookInput) => GateResult | Promise<GateResult> }
      >
    )[moduleName];

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard for dynamic module lookup
    if (!gateModule) {
      throw new Error(`Gate module '${moduleName}' not found or missing execute function`);
    }
    if (typeof gateModule.execute !== 'function') {
      throw new Error(`Gate module '${moduleName}' not found or missing execute function`);
    }

    return await gateModule.execute(input);
  } catch (error) {
    throw new Error(`Failed to load built-in gate ${gateName}: ${String(error)}`);
  }
}

// Track plugin gate call stack to detect circular references
const MAX_PLUGIN_DEPTH = 10;

/**
 * Execute a gate by its configuration, supporting shell commands, built-in gates, and plugin references.
 * @param gateName - Name of the gate being executed
 * @param gateConfig - Gate configuration specifying command, plugin reference, or built-in type
 * @param input - Hook input to pass to the gate
 * @param pluginStack - Stack of plugin gate references for circular dependency detection
 * @returns Object with passed flag and gate result
 */
export async function executeGate(
  gateName: string,
  gateConfig: GateConfig,
  input: HookInput,
  pluginStack: string[] = [],
): Promise<{ passed: boolean; result: GateResult }> {
  // Handle plugin gate reference
  if (gateConfig.plugin && gateConfig.gate) {
    // Circular reference detection
    const gateRef = `${gateConfig.plugin}:${gateConfig.gate}`;
    if (pluginStack.includes(gateRef)) {
      throw new Error(
        `Circular gate reference detected: ${pluginStack.join(' -> ')} -> ${gateRef}`,
      );
    }

    // Depth limit to prevent infinite recursion
    if (pluginStack.length >= MAX_PLUGIN_DEPTH) {
      throw new Error(
        `Maximum plugin gate depth (${String(MAX_PLUGIN_DEPTH)}) exceeded: ${pluginStack.join(' -> ')} -> ${gateRef}`,
      );
    }

    const { gateConfig: pluginGateConfig, pluginRoot } = await loadPluginGate(
      gateConfig.plugin,
      gateConfig.gate,
    );

    // Recursively execute the plugin's gate with updated stack
    const newStack = [...pluginStack, gateRef];

    // Execute the plugin's gate command in the plugin's directory
    if (pluginGateConfig.command) {
      const shellResult = await executeShellCommand(pluginGateConfig.command, pluginRoot);
      const passed = shellResult.exitCode === 0;

      return {
        passed,
        result: {
          additionalContext: shellResult.output,
        },
      };
    } else if (pluginGateConfig.plugin && pluginGateConfig.gate) {
      // Plugin gate references another plugin gate - recurse
      return executeGate(gateRef, pluginGateConfig, input, newStack);
    } else {
      throw new Error(`Plugin gate '${gateConfig.plugin}:${gateConfig.gate}' has no command`);
    }
  }

  if (gateConfig.command) {
    // Shell command gate (existing behavior)
    const shellResult = await executeShellCommand(gateConfig.command, input.cwd);
    const passed = shellResult.exitCode === 0;

    return {
      passed,
      result: {
        additionalContext: shellResult.output,
      },
    };
  } else {
    // Built-in TypeScript gate
    const result = await executeBuiltinGate(gateName, input);
    const passed = !result.decision && result.continue !== false;

    return {
      passed,
      result,
    };
  }
}

/**
 * Result of loading a gate definition from an external plugin.
 */
export interface PluginGateResult {
  gateConfig: GateConfig;
  pluginRoot: string;
}

/**
 * Load a gate definition from another plugin.
 *
 * SECURITY: Plugins are trusted by virtue of being explicitly installed by the user.
 * This function loads plugin configuration and does NOT validate command safety.
 * The trust boundary is at plugin installation, not at gate reference.
 *
 * However, we do validate that the loaded config has the expected structure to
 * prevent runtime errors from malformed plugin configurations.
 *
 * @param pluginName - Name of the plugin (e.g., 'cipherpowers')
 * @param gateName - Name of the gate within the plugin
 * @returns The gate config and the plugin root path for execution context
 */
export async function loadPluginGate(
  pluginName: string,
  gateName: string,
): Promise<PluginGateResult> {
  const pluginRoot = resolvePluginPath(pluginName);
  const gatesPath = path.join(pluginRoot, 'rundown-plugin.json');

  const pluginConfig = await loadConfigFile(gatesPath);
  if (!pluginConfig) {
    throw new Error(`Cannot find rundown-plugin.json for plugin '${pluginName}' at ${gatesPath}`);
  }

  // Validate plugin config has gates object
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard validating external config structure
  if (!pluginConfig.gates || typeof pluginConfig.gates !== 'object') {
    throw new Error(
      `Invalid rundown-plugin.json structure in plugin '${pluginName}': missing or invalid 'gates' object`,
    );
  }

  const gateConfig = pluginConfig.gates[gateName];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard for missing gate in loaded plugin config
  if (!gateConfig) {
    throw new Error(`Gate '${gateName}' not found in plugin '${pluginName}'`);
  }

  return { gateConfig, pluginRoot };
}
