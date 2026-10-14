/**
 * Variable configuration discovery service.
 *
 * Discovers and loads template variables from .rundown/config.yaml
 * with support for CLI flag overrides.
 *
 * Note: Only the project root's config is read. Callers pass the root
 * (`getProjectRoot`, which uses core's `resolveProjectRoot` and stops at a git
 * root), so variables are never loaded from an unrelated parent directory.
 *
 * @module
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFileSync as nodeExecFileSync } from 'node:child_process';
import {
  canonicalPath,
  createBuiltinVariables,
  isRuntimeReservedVariable,
  isValidVariableName,
  loadYaml,
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
  ArtifactChannelError,
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

/**
 * Resolve a user-typed `--input-file` path and check it stays in the project.
 *
 * The path is the user's, so it is resolved against the directory they typed
 * it in; containment (symlinks resolved) is checked against the project root.
 *
 * @param rawPath - The path as typed on the command line
 * @param projectRoot - The project root the file must stay inside
 * @param invocationDir - The directory the path is relative to
 * @returns The canonical path of the input file
 * @throws {Error} If the path is absolute or escapes the project root
 */
/**
 * One `--input` entry, tagged with where its value came from.
 *
 * `typed` is `--input KEY=value`: the user typed the value, so a relative
 * `file:` path in it is relative to the directory they typed it in.
 * `environment` is a bare `--input KEY`, whose value was read from the
 * environment variable `KEY`; like an `RD_INPUT_*` value, a relative `file:`
 * path in it resolves against the project root.
 */
export type InputFlagEntry =
  | { readonly origin: 'typed'; readonly key: string; readonly value: string }
  | { readonly origin: 'environment'; readonly key: string; readonly value: string };

async function resolveContainedInputFilePath(
  rawPath: string,
  projectRoot: string,
  invocationDir: string,
): Promise<string> {
  if (path.isAbsolute(rawPath)) {
    throw new Error(
      `--input-file path must be relative to the directory the command was run from: ${rawPath}`,
    );
  }

  const canonicalRoot = canonicalPath(projectRoot);
  const resolved = path.resolve(canonicalPath(invocationDir), rawPath);
  let canonical = resolved;
  try {
    canonical = await fs.realpath(resolved);
  } catch {
    try {
      const canonicalDir = await fs.realpath(path.dirname(resolved));
      canonical = path.join(canonicalDir, path.basename(resolved));
    } catch {
      // Neither the file nor its directory exists: the lexical path is checked.
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
 * Anchor a user-typed `file:` value to the directory it was typed in.
 *
 * Core resolves a relative `file:` path against the project root, which is
 * right for `.rundown/config.yaml`; a path typed on the command line is the
 * user's and is relative to where they typed it. Containment against the
 * project root is still checked by core.
 *
 * @param value - The raw command-line value
 * @param invocationDir - The directory the command was run from
 * @returns The value, with a relative `file:` path made absolute
 */
function anchorFileSource(value: unknown, invocationDir: string): unknown {
  if (typeof value !== 'string' || !value.startsWith('file:')) return value;
  const rawPath = value.slice('file:'.length);
  if (path.isAbsolute(rawPath)) return value;
  return `file:${path.resolve(invocationDir, rawPath)}`;
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
 * @param options.input - `--input` entries, each tagged typed or environment-inherited
 * @param options.inputJson - Array of key=json flag strings from CLI for structured values
 * @param projectRoot - Project root that `--input-file` paths must stay inside
 * @param invocationDir - Directory the command was run from; `--input-file`
 *   paths and typed `file:` values in `--input` / `--input-json` are relative
 *   to it; a value inherited with a bare `--input KEY` is not. Defaults to the
 *   project root.
 * @returns Merged variable record with raw types preserved
 * @throws {Error} If an `--input-file` path is absolute, escapes the project root, or is unreadable
 */
export async function collectCliFlags(
  options: { inputFile?: string[]; input?: readonly InputFlagEntry[]; inputJson?: string[] },
  projectRoot: string,
  invocationDir: string = projectRoot,
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};

  // input-file(s) — repeatable, later overrides earlier
  for (const vf of options.inputFile ?? []) {
    const varFilePath = await resolveContainedInputFilePath(vf, projectRoot, invocationDir);
    const fileVars = await loadVariablesFromFile(varFilePath, {
      normalize: false,
      optional: false,
    });
    Object.assign(result, fileVars);
  }

  // --input flags: only a typed value is anchored to the invocation directory
  for (const entry of options.input ?? []) {
    if (!isValidVariableName(entry.key)) {
      throw new Error(
        `Unexpected invalid --input key: ${entry.key} (parseInputOption should have rejected this)`,
      );
    }
    result[entry.key] =
      entry.origin === 'typed' ? anchorFileSource(entry.value, invocationDir) : entry.value;
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
      result[key] = anchorFileSource(JSON.parse(jsonValue), invocationDir);
    }
  }

  return result;
}

/**
 * Collect raw artifact-channel values from `--artifacts` / `--artifacts-json`.
 *
 * Builds a raw record keyed by artifact name; `rd://` URIs are preserved
 * verbatim — core validates and rehydrates them at the artifact-channel layer.
 * The re-validation here (`parseVarFlag` / `isValidVariableName`) is a defensive
 * invariant guard; the argParser already enforced the shape.
 *
 * @param options - Artifact flag arrays
 * @param options.artifacts - `key=rd://...` entries
 * @param options.artifactsJson - `key=<json array of rd:// uris>` entries
 * @returns Raw artifact record (rd:// URIs preserved; core validates and rehydrates)
 * @throws {Error} If an entry is malformed (defensive — the argParser should have rejected it)
 */
function collectArtifactFlags(options: {
  artifacts?: string[];
  artifactsJson?: string[];
}): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const flag of options.artifacts ?? []) {
    const parsed = parseVarFlag(flag);
    if (!parsed) {
      throw new Error(
        `Unexpected invalid --artifacts entry: ${flag} (parser should have rejected this)`,
      );
    }
    result[parsed.key] = parsed.value;
  }
  for (const flag of options.artifactsJson ?? []) {
    const eqIndex = flag.indexOf('=');
    // A missing `=` would make `flag.slice(0, -1)` silently drop the last
    // character and treat the whole flag as the JSON value, so reject it
    // explicitly rather than slicing garbage (defensive — the argParser
    // enforces the `key=json` shape first).
    if (eqIndex === -1) {
      throw new Error(
        `Unexpected invalid --artifacts-json entry: ${flag} (parser should have rejected this)`,
      );
    }
    const key = flag.slice(0, eqIndex);
    if (!isValidVariableName(key)) {
      throw new Error(
        `Unexpected invalid --artifacts-json key: ${key} (parser should have rejected this)`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(flag.slice(eqIndex + 1));
    } catch {
      throw new Error(
        `Unexpected invalid --artifacts-json value for "${key}" (parser should have rejected this)`,
      );
    }
    result[key] = parsed;
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
    const parsed = loadYaml(content);

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
 * Find the project's `.rundown/config.yaml`.
 *
 * Reads only the config of the project root it is given; it does not walk.
 * Callers resolve the root once (`getProjectRoot`, which uses core's
 * `resolveProjectRoot`), so a nested `.rundown/` without a config shadows an
 * outer project's config and nothing above a git root is loaded.
 *
 * @param projectRoot - The project root
 * @returns Absolute path to the config file, or null if the project has none
 */
export async function findConfigFile(projectRoot: string): Promise<string | null> {
  const configPath = path.join(projectRoot, CONFIG_FILE);
  try {
    await fs.access(configPath);
    return configPath;
  } catch {
    return null;
  }
}

/**
 * Discover variables from the project root's `.rundown/config.yaml`.
 *
 * @param projectRoot - The project root whose config is read
 * @returns Discovered variables, or empty object if the project has no config
 */
export async function discoverVariables(projectRoot: string): Promise<Record<string, string>> {
  const configPath = await findConfigFile(projectRoot);
  if (configPath) {
    return await loadVariablesFromFile(configPath);
  }
  return {};
}

/**
 * Discover raw (pre-normalization) variables from the project root's
 * `.rundown/config.yaml`.
 *
 * @param projectRoot - The project root whose config is read
 * @returns Discovered variables with raw types preserved, or empty object if the project has no config
 */
async function discoverRawVariables(projectRoot: string): Promise<Record<string, unknown>> {
  const configPath = await findConfigFile(projectRoot);
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
 * @param options.input - `--input` entries, each tagged typed or environment-inherited
 * @param options.inputJson - Array of key=json flag strings from CLI for structured values
 * @param options.inheritedVars - Variables inherited from parent delegation
 * @param options.artifacts - Array of `key=rd://...` artifact-channel flag strings
 * @param options.artifactsJson - Array of `key=<json array of rd:// uris>` artifact-channel flag strings
 * @param projectRoot - Project root: its config is read, and paths must stay inside it
 * @param invocationDir - Directory command-line paths are relative to
 * @param warnings - Optional array to collect discovery warnings
 * @returns Array of variable layers in precedence order
 */
async function collectRawLayers(
  options: {
    inputFile?: string[];
    input?: readonly InputFlagEntry[];
    inputJson?: string[];
    inheritedVars?: Record<string, VariableValue>;
    artifacts?: string[];
    artifactsJson?: string[];
  },
  projectRoot: string,
  invocationDir: string,
  warnings?: string[],
): Promise<VariableLayer[]> {
  return [
    { kind: 'builtins', channel: 'variable', values: getBuiltinVariables() },
    { kind: 'config', channel: 'variable', values: await discoverRawVariables(projectRoot) },
    { kind: 'inherited', channel: 'variable', values: options.inheritedVars ?? {} },
    { kind: 'env', channel: 'variable', values: collectEnvBridgeVars(warnings) },
    {
      kind: 'cli',
      channel: 'variable',
      values: await collectCliFlags(options, projectRoot, invocationDir),
    },
    { kind: 'artifact-cli', channel: 'artifact', values: collectArtifactFlags(options) },
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
 * @param options.input - `--input` entries, each tagged typed or environment-inherited
 * @param options.inputJson - Array of key=json flag strings from CLI for structured values
 * @param options.inheritedVars - Variables inherited from parent delegation (overrides builtins)
 * @param options.artifacts - Array of `key=rd://...` artifact-channel flag strings
 * @param options.artifactsJson - Array of `key=<json array of rd:// uris>` artifact-channel flag strings
 * @param cwd - Project root: its `.rundown/config.yaml` is read, its `file:`
 *   values resolve against it, and every file source must stay inside it
 * @param security - Optional security context for file source policy enforcement
 * @param invocationDir - Directory the command was run from. `--input-file`
 *   paths and typed `file:` values in `--input` / `--input-json` are relative
 *   to it; a value inherited with a bare `--input KEY` is not. Defaults to `cwd`.
 * @returns ResolvedVariables with unified vars map and any warnings
 * @throws {FileSourcePolicyError} When a file-backed data source is blocked by security policy
 * @throws {Error} When a reserved runtime variable name is overridden by a non-builtin layer
 */
export async function resolveVariables(
  options: {
    inputFile?: string[];
    input?: readonly InputFlagEntry[];
    inputJson?: string[];
    inheritedVars?: Record<string, VariableValue>;
    artifacts?: string[];
    artifactsJson?: string[];
  },
  cwd: string,
  security?: VariableSecurityContext,
  invocationDir: string = cwd,
): Promise<ResolvedVariables> {
  const warnings: string[] = [];
  const layers = await collectRawLayers(options, cwd, invocationDir, warnings);
  const resolved = await resolveVariableLayers(layers, { cwd, security });
  return {
    vars: resolved.vars,
    warnings: [...warnings, ...resolved.warnings],
    providedKeys: resolved.providedKeys,
  };
}
