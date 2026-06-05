/**
 * Variable configuration discovery service.
 *
 * Discovers and loads template variables from .rundown/config.yaml
 * with support for CLI flag overrides.
 *
 * Note: Config discovery stops at git root or filesystem root to prevent
 * accidentally loading variables from unrelated parent directories.
 *
 * @module
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFileSync as nodeExecFileSync } from 'node:child_process';
import * as yaml from 'js-yaml';
import {
  createBuiltinVariables,
  isRuntimeReservedVariable,
  isValidVariableName,
  resolveVariableLayers,
  type ResolvedVariables,
  type VariableValue,
  type VariableLayer,
  type VariableSecurityContext,
  CONFIG_FILE,
  WORK_DIR,
} from '@rundown-org/core';
import { assertContainedPath } from '../helpers/path-containment.js';

export {
  BUILTIN_VARIABLES,
  FileSourcePolicyError,
  RUNTIME_RESERVED_VARIABLES,
  VALID_IDENTIFIER,
  isRuntimeReservedVariable,
  isValidVariableName,
  routeExtraVars,
  type ResolvedVariables,
  type VariableSecurityContext,
} from '@rundown-org/core';

type GitBranchExecOptions = {
  encoding: 'utf-8';
  stdio: ['pipe', 'pipe', 'pipe'];
};

type GitBranchExecFileSync = (
  command: string,
  args: readonly string[],
  options: GitBranchExecOptions,
) => string;

// Allow injection for testing
let execFileSyncImpl: GitBranchExecFileSync = nodeExecFileSync;

/**
 * Replace the execFileSync implementation (for testing).
 *
 * @param fn - Replacement function matching the git branch discovery call shape
 */
export function setExecFileSyncImpl(fn: GitBranchExecFileSync): void {
  execFileSyncImpl = fn;
}

/**
 * Detect the current git branch name.
 *
 * Runs `git rev-parse --abbrev-ref HEAD` and returns the branch name,
 * or `null` if not in a git repo, on a detached HEAD, or git is unavailable.
 *
 * @returns Branch name or null
 */
function detectGitBranch(): string | null {
  try {
    const result = execFileSyncImpl('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const branch = result.trim();
    if (!branch || branch === 'HEAD') return null;
    return branch;
  } catch {
    return null;
  }
}

/**
 * Normalize raw variable values to string-only records.
 *
 * @deprecated Used only by the default `loadVariablesFromFile` overload for legacy
 * frontmatter normalization. Do NOT use for `--input-file`, config, or any path where
 * structured values (arrays, objects) should be preserved. Use `routeVariable` instead.
 *
 * @param vars - Raw variables object with unknown value types
 * @param source - Label for warning messages (e.g., "frontmatter var", "variable")
 * @param warnings - Optional array to collect normalization warnings
 * @returns Normalized variables with string values only
 */
function normalizeToStringVariables(
  vars: Record<string, unknown>,
  source = 'variable',
  warnings?: string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    if (!isValidVariableName(key)) {
      warnings?.push(`Ignoring ${source} with invalid key: ${key}`);
      continue;
    }
    if (typeof value === 'object' && value !== null) {
      warnings?.push(`Ignoring ${source} "${key}" with complex value`);
      continue;
    }
    result[key] = String(value);
  }
  return result;
}

/**
 * Default base directory for the `WorkPath` built-in variable.
 *
 * Re-exports {@link WORK_DIR} from `@rundown-org/core` to keep a single
 * source of truth and prevent drift between packages.
 *
 * @deprecated Import {@link WORK_DIR} from `@rundown-org/core` directly.
 */
export const DEFAULT_WORK_PATH = WORK_DIR;

/**
 * Returns built-in default template variables.
 *
 * These discovery defaults have the lowest precedence. `RunbookRef` is
 * injected later by preparation and `RunId` is injected later by runnable
 * preparation so neither identity can be spoofed by user input.
 *
 * @returns Built-in variables with PascalCase names
 */
export function getBuiltinVariables(): Record<string, string> {
  return createBuiltinVariables({ branch: detectGitBranch() });
}

/**
 * Parse a --input flag value in key=value format.
 *
 * Variable names must be valid identifiers (start with letter/underscore,
 * contain only letters, digits, underscores).
 *
 * @param flag - The flag value (e.g., "test_command=npm test")
 * @returns Parsed key-value pair, or null if invalid format or invalid identifier
 */
export function parseVarFlag(flag: string): { key: string; value: string } | null {
  const eqIndex = flag.indexOf('=');
  if (eqIndex === -1) return null;

  const key = flag.slice(0, eqIndex);
  const value = flag.slice(eqIndex + 1);

  if (!key || !isValidVariableName(key)) return null;

  return { key, value };
}

async function realpathOrResolved(filePath: string): Promise<string> {
  try {
    return await fs.realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

async function resolveContainedInputFilePath(rawPath: string, cwd: string): Promise<string> {
  if (path.isAbsolute(rawPath)) {
    throw new Error(`--input-file path must be relative to the project directory: ${rawPath}`);
  }
  const normalized = path.normalize(rawPath);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`--input-file path escapes project directory: ${rawPath}`);
  }
  const segments = normalized.split(path.sep);
  if (segments.some((segment) => segment === '..')) {
    throw new Error(`--input-file path escapes project directory: ${rawPath}`);
  }

  const canonicalRoot = await realpathOrResolved(cwd);
  const resolved = path.resolve(cwd, rawPath);
  let canonical = resolved;
  try {
    canonical = await fs.realpath(resolved);
  } catch {
    const resolvedDir = path.dirname(resolved);
    try {
      const canonicalDir = await fs.realpath(resolvedDir);
      canonical = path.join(canonicalDir, path.basename(resolved));
    } catch {
      canonical = path.join(canonicalRoot, normalized);
    }
  }

  assertContainedPath(
    canonicalRoot,
    canonical,
    `--input-file path escapes project directory: ${rawPath}`,
  );

  return canonical;
}

/**
 * Collect CLI flag variables (--input-file, --input, --input-json) into a single dict.
 *
 * Merges in internal precedence order: input-file < input < input-json.
 * Used by both {@link collectRawLayers} and the delegate command to avoid
 * duplicating flag-collection logic.
 *
 * @param options - CLI flag arrays
 * @param options.inputFile - Array of paths to YAML files containing variable definitions (repeatable)
 * @param options.input - Array of key=value flag strings from CLI
 * @param options.inputJson - Array of key=json flag strings from CLI for structured values
 * @param cwd - Current working directory for resolving relative input-file paths
 * @returns Merged variable record with raw types preserved
 */
export async function collectCliFlags(
  options: { inputFile?: string[]; input?: string[]; inputJson?: string[] },
  cwd: string,
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};

  // input-file(s) — repeatable, later overrides earlier
  for (const vf of options.inputFile ?? []) {
    const varFilePath = await resolveContainedInputFilePath(vf, cwd);
    const fileVars = await loadVariablesFromFile(varFilePath, {
      normalize: false,
      optional: false,
    });
    Object.assign(result, fileVars);
  }

  // --input flags
  if (options.input) {
    for (const flag of options.input) {
      const parsed = parseVarFlag(flag);
      if (!parsed) {
        throw new Error(
          `Unexpected invalid --input entry: ${flag} (parseInputOption should have rejected this)`,
        );
      }
      result[parsed.key] = parsed.value;
    }
  }

  // --input-json values (processed after --input, so wins for same key)
  if (options.inputJson) {
    for (const flag of options.inputJson) {
      const eqIndex = flag.indexOf('=');
      const key = flag.slice(0, eqIndex);
      if (!isValidVariableName(key)) {
        throw new Error(
          `Unexpected invalid --input-json key: ${key} (parseInputJsonOption should have rejected this)`,
        );
      }
      const jsonValue = flag.slice(eqIndex + 1);
      result[key] = JSON.parse(jsonValue);
    }
  }

  return result;
}

/**
 * Load variables from a YAML file.
 *
 * @param filePath - Absolute path to the YAML file
 * @param options - Optional: set normalize=false to preserve raw types, optional=false to throw on errors
 * @param options.normalize - When false, preserves raw YAML types; when true/omitted, converts to strings
 * @param options.optional - When true (default), silently returns `{}` on errors; when false, throws
 * @returns Variable record (string values when normalized, unknown values when raw)
 * @throws {Error} When optional is false and the file cannot be read or parsed
 */
export async function loadVariablesFromFile(
  filePath: string,
  options: { normalize: false; optional?: boolean },
): Promise<Record<string, unknown>>;
export async function loadVariablesFromFile(
  filePath: string,
  options?: { normalize?: true; optional?: boolean },
): Promise<Record<string, string>>;
export async function loadVariablesFromFile(
  filePath: string,
  options?: { normalize?: boolean; optional?: boolean },
): Promise<Record<string, unknown>> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = yaml.load(content);

    if (typeof parsed !== 'object' || parsed === null) {
      return {};
    }

    const raw = parsed as Record<string, unknown>;
    if (options?.normalize === false) {
      return raw;
    }
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- legacy frontmatter path
    return normalizeToStringVariables(raw);
  } catch (error) {
    if (options?.optional === false) {
      throw error;
    }
    return {};
  }
}

/**
 * Find the .rundown/config.yaml file by walking upward from cwd.
 *
 * Searches upward from the given directory for a .rundown directory
 * containing config.yaml. Stops at git root or filesystem root to
 * prevent loading from unrelated parent directories.
 *
 * @param cwd - Starting directory for search
 * @returns Absolute path to the config file, or null if not found
 */
export async function findConfigFile(cwd: string): Promise<string | null> {
  let dir = cwd;
  let parent = path.dirname(dir);

  // Continue while we haven't reached filesystem root
  while (parent !== dir) {
    const configPath = path.join(dir, CONFIG_FILE);

    try {
      await fs.access(configPath);
      return configPath;
    } catch {
      // File doesn't exist, continue searching
    }

    // Check if we've reached git root
    const gitPath = path.join(dir, '.git');
    try {
      await fs.access(gitPath);
      // Found git root, stop searching
      return null;
    } catch {
      // Not git root, continue
    }

    dir = parent;
    parent = path.dirname(dir);
  }

  // Check the filesystem root as well
  const configPath = path.join(dir, CONFIG_FILE);
  try {
    await fs.access(configPath);
    return configPath;
  } catch {
    return null;
  }
}

/**
 * Discover variables from .rundown/config.yaml in the project.
 *
 * Searches upward from cwd for a .rundown directory containing config.yaml.
 * Stops at git root or filesystem root to prevent loading from unrelated directories.
 *
 * @param cwd - Starting directory for search
 * @returns Discovered variables, or empty object if not found
 */
export async function discoverVariables(cwd: string): Promise<Record<string, string>> {
  const configPath = await findConfigFile(cwd);
  if (configPath) {
    return await loadVariablesFromFile(configPath);
  }
  return {};
}

/**
 * Discover raw (pre-normalization) variables from .rundown/config.yaml.
 *
 * Searches upward from cwd for a .rundown directory containing config.yaml.
 * Stops at git root or filesystem root to prevent loading from unrelated directories.
 *
 * @param cwd - Starting directory for search
 * @returns Discovered variables with raw types preserved, or empty object if not found
 */
async function discoverRawVariables(cwd: string): Promise<Record<string, unknown>> {
  const configPath = await findConfigFile(cwd);
  if (configPath) {
    return await loadVariablesFromFile(configPath, { normalize: false });
  }
  return {};
}

/**
 * Environment variable prefix for the variable bridge.
 * Variables matching `RD_INPUT_<name>` are mapped to template variable `<name>`.
 */
const ENV_INPUT_PREFIX = 'RD_INPUT_';

/**
 * Collect variables from environment using the RD_INPUT_* prefix convention.
 *
 * Environment variables matching RD_INPUT_<name> are mapped to variable <name>.
 * Variable names are validated against the identifier pattern.
 *
 * @param warnings - Optional array to collect discovery warnings
 * @returns Collected environment bridge variables
 */
function collectEnvBridgeVars(warnings?: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [envKey, value] of Object.entries(process.env)) {
    if (envKey.startsWith(ENV_INPUT_PREFIX) && value !== undefined) {
      const varName = envKey.slice(ENV_INPUT_PREFIX.length);
      if (!isValidVariableName(varName)) {
        warnings?.push(`Ignoring env ${envKey}: "${varName}" is not a valid identifier`);
        continue;
      }
      if (isRuntimeReservedVariable(varName)) {
        warnings?.push(`Ignoring env ${envKey}: "${varName}" is a reserved runtime variable`);
        continue;
      }
      result[varName] = value;
    }
  }
  return result;
}

/**
 * Collect raw (pre-normalization) variable layers in precedence order.
 *
 * Returns array from lowest to highest precedence. Later layers override
 * earlier ones for the same key during processing in `resolveVariables`.
 *
 * ```
 * Layer 0: builtins        ← Date, Branch, WorkPath, ContextId (fresh)
 * Layer 1: discovered      ← .rundown/config.yaml (auto-discovered)
 * Layer 2: inheritedVars   ← parent delegation vars (overrides builtins/config)
 * Layer 3: envBridge       ← RD_INPUT_* environment variables
 * Layer 4: cliFlags        ← --input-file, --input, --input-json (highest precedence)
 * ```
 *
 * The inherited layer ensures that parent ContextId survives into child
 * runbooks during delegation, rather than being replaced by a fresh builtin
 * or shadowed by project-local config. Resolver/runtime identity (`RunbookRef`
 * and `RunId`) is merged after this discovery stack in the preparation
 * pipeline.
 *
 * @param options - Variable sources from CLI flags, input-file, and inherited vars
 * @param options.inputFile - Array of paths to YAML files containing variable definitions (repeatable)
 * @param options.input - Array of key=value flag strings from CLI
 * @param options.inputJson - Array of key=json flag strings from CLI for structured values
 * @param options.inheritedVars - Variables inherited from parent delegation
 * @param cwd - Current working directory for resolving relative paths
 * @param warnings - Optional array to collect discovery warnings
 * @returns Array of variable layers in precedence order
 */
async function collectRawLayers(
  options: {
    inputFile?: string[];
    input?: string[];
    inputJson?: string[];
    inheritedVars?: Record<string, VariableValue>;
  },
  cwd: string,
  warnings?: string[],
): Promise<VariableLayer[]> {
  return [
    { kind: 'builtins', values: getBuiltinVariables() },
    { kind: 'config', values: await discoverRawVariables(cwd) },
    { kind: 'inherited', values: options.inheritedVars ?? {} },
    { kind: 'env', values: collectEnvBridgeVars(warnings) },
    { kind: 'cli', values: await collectCliFlags(options, cwd) },
  ];
}

/**
 * Resolve variables into the unified template variable map.
 *
 * Processes variable layers in precedence order (lowest to highest):
 * 1. Built-in defaults (Date, DateTime, Year, Month, Day, Branch, WorkPath, ContextId)
 * 2. Auto-discovered .rundown/config.yaml
 * 2b. Inherited vars from parent delegation
 * 2c. Environment bridge (RD_INPUT_* env vars)
 * 3. --input-file contents (repeatable, later overrides earlier)
 * 4. --input flags
 * 5. --input-json flags (highest precedence)
 *
 * Each variable value is routed into `vars` based on its type:
 * - String with `file:` prefix → JsonArrayStream (.jsonl) or JsonArray/JsonObject (.json)
 * - Array → JsonArray (type-preserving, not comma-joined)
 * - Non-array object (JsonObject) → preserved for dotted template access
 * - Number → preserved, not stringified
 * - Other scalar (boolean, null, plain string) → stringified
 *
 * `RunbookRef` and `RunId` are not returned by this function; callers that
 * prepare or launch runbooks inject those identity values after user input.
 *
 * @param options - Variable sources from CLI flags, input-file, and inherited vars
 * @param options.inputFile - Array of paths to YAML files containing variable definitions (repeatable)
 * @param options.input - Array of key=value flag strings from CLI
 * @param options.inputJson - Array of key=json flag strings from CLI for structured values
 * @param options.inheritedVars - Variables inherited from parent delegation (overrides builtins)
 * @param cwd - Current working directory for resolving relative paths
 * @param security - Optional security context for file source policy enforcement
 * @returns ResolvedVariables with unified vars map and any warnings
 * @throws {FileSourcePolicyError} When a file-backed data source is blocked by security policy
 * @throws {Error} When a reserved runtime variable name is overridden by a non-builtin layer
 */
export async function resolveVariables(
  options: {
    inputFile?: string[];
    input?: string[];
    inputJson?: string[];
    inheritedVars?: Record<string, VariableValue>;
  },
  cwd: string,
  security?: VariableSecurityContext,
): Promise<ResolvedVariables> {
  const warnings: string[] = [];
  const layers = await collectRawLayers(options, cwd, warnings);
  const resolved = await resolveVariableLayers(layers, { cwd, security });
  return {
    vars: resolved.vars,
    warnings: [...warnings, ...resolved.warnings],
    providedKeys: resolved.providedKeys,
  };
}
