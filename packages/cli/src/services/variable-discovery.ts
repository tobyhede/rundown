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

import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFileSync as nodeExecFileSync } from 'node:child_process';
import * as yaml from 'js-yaml';
import {
  createJsonArrayStream,
  isJsonValue,
  type JsonArray,
  type JsonObject,
  type PolicyEvaluator,
  type PolicyPrompter,
  type TemplateVarValue,
  CONFIG_FILE,
  WORK_DIR,
} from '@rundown-org/core';
import {
  RESERVED_TEMPLATE_NAMES as PARSER_RESERVED_TEMPLATE_NAMES,
  isReservedTemplateName,
} from '@rundown-org/parser';

// Allow injection for testing
let execFileSyncImpl: typeof nodeExecFileSync = nodeExecFileSync;

/**
 * Replace the execFileSync implementation (for testing).
 *
 * @param fn - Replacement function matching the execFileSync signature
 */
export function setExecFileSyncImpl(fn: typeof nodeExecFileSync): void {
  execFileSyncImpl = fn;
}

/**
 * Sanitize a git branch name for use in filesystem paths.
 *
 * Replaces `/` with `-`, strips characters not in `[a-zA-Z0-9._-]`,
 * collapses consecutive hyphens, and trims leading/trailing hyphens.
 *
 * When sanitization is lossy (characters were stripped), an 8-character SHA-256
 * hash of the original branch name is appended to prevent collisions (e.g.
 * `release/1.2` vs `release/12` producing distinct paths). If all characters
 * are stripped (e.g. non-ASCII-only names), the hash alone is returned.
 *
 * @param branch - Raw git branch name
 * @returns Sanitized branch name safe for filesystem paths
 */
export function sanitizeBranchName(branch: string): string {
  const slashNormalized = branch.replace(/\//g, '-');
  const charStripped = slashNormalized.replace(/[^a-zA-Z0-9._-]/g, '');
  const isLossy = charStripped !== slashNormalized;
  const sanitized = charStripped.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');

  if (!sanitized) {
    return isLossy ? createHash('sha256').update(branch).digest('hex').slice(0, 8) : '';
  }
  if (isLossy) {
    const hash = createHash('sha256').update(branch).digest('hex').slice(0, 8);
    return `${sanitized}-${hash}`;
  }
  return sanitized;
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
 * Valid identifier pattern for variable names.
 * Must start with letter or underscore, followed by letters, digits, or underscores.
 */
export const VALID_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Property names that could poison plain objects via prototype pollution. */
const POISONED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Check if a key is a valid, safe variable name.
 *
 * Combines identifier syntax validation with prototype pollution protection.
 *
 * @param key - The variable name to validate
 * @returns True if the key is a syntactically valid identifier and not a poisoned property name
 */
export function isValidVariableName(key: string): boolean {
  return VALID_IDENTIFIER.test(key) && !POISONED_KEYS.has(key);
}

/**
 * Runtime-reserved keys (normalized to lowercase) that cannot be overridden
 * by user-provided variables.
 *
 * These keys are owned by runtime frame/context resolution and should remain
 * deterministic across runbook execution. Re-exported from the parser package
 * so the parser-level guard (`handleInputsDirective`, `handleOutputsDirective`,
 * frontmatter zod refine) and the CLI-level validators stay in sync.
 */
export const RUNTIME_RESERVED_VARIABLES = PARSER_RESERVED_TEMPLATE_NAMES;

/**
 * Check whether a variable name is reserved for runtime context semantics.
 *
 * Matching is case-insensitive (`Step`, `STEP`, and `step` are treated equally).
 * Thin re-export of the parser's `isReservedTemplateName` for backward
 * compatibility — prefer importing `isReservedTemplateName` directly in new code.
 *
 * @param name - Variable name to check
 * @returns True if the name is reserved for runtime context semantics
 */
export function isRuntimeReservedVariable(name: string): boolean {
  return isReservedTemplateName(name);
}

/**
 * Resolved variables from the unified template variable map.
 *
 * All variable values — scalars, JSON arrays, and file-backed streams — are
 * routed into `vars`.
 */
export interface ResolvedVariables {
  /**
   * Readonly map of template variable values used for template substitution.
   *
   * Feeds the Handlebars template rendering pipeline — every entry is
   * substituted into `{{key}}` placeholders at render time. Values are
   * strings, numbers (preserved from `--input-json`), or JSON objects
   * (for dotted field access like `{{config.host}}`).
   * The map is immutable for the lifetime of a single resolution pass.
   */
  readonly vars: Readonly<Record<string, TemplateVarValue>>;
  /**
   * Structured warnings produced during variable resolution.
   *
   * Contains messages about invalid keys, complex values, reserved names,
   * path traversal attempts, and other non-fatal issues encountered during
   * the resolution pipeline.
   */
  readonly warnings: readonly string[];
  /**
   * Variable names provided by external layers (inherited, config, env, CLI).
   *
   * Excludes builtins (layer 0) and frontmatter (layer 2). Used to validate
   * that frontmatter `required` variables were actually provided by the caller.
   */
  readonly providedKeys: ReadonlySet<string>;
}

/**
 * Security context for file-backed variable resolution.
 *
 * When provided, file data sources are checked against the active policy
 * before reading. If a prompter is available and the policy denies access,
 * the user is prompted for explicit permission.
 */
export interface VariableSecurityContext {
  /** Policy evaluator for checking file read permissions. */
  readonly evaluator?: PolicyEvaluator;
  /** Interactive prompter for requesting user permission on denied paths. */
  readonly prompter?: PolicyPrompter;
}

/**
 * Error thrown when a file-backed data source is blocked by security policy.
 *
 * Contains structured metadata (variable name, file path, denial reason)
 * for programmatic handling by the CLI pipeline.
 */
export class FileSourcePolicyError extends Error {
  readonly code = 'POLICY_DENIED';
  readonly variable: string;
  readonly filePath: string;
  readonly reason: string;

  /**
   * Create a FileSourcePolicyError.
   * @param variable - The variable name that referenced the blocked file source
   * @param filePath - The resolved file path that was blocked
   * @param reason - Human-readable denial reason from the policy engine
   */
  constructor(variable: string, filePath: string, reason: string) {
    super(`File source "${variable}" blocked by policy: ${reason}`);
    this.name = 'FileSourcePolicyError';
    this.variable = variable;
    this.filePath = filePath;
    this.reason = reason;
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
 * Compute the branch-scoped `WorkPath` value.
 *
 * @param branch - Raw git branch name, or `null` when not in a git repo
 * @returns `.rundown/work/<sanitized-branch>` inside git, otherwise `.rundown/work`
 */
function computeWorkPath(branch: string | null): string {
  const sanitized = branch ? sanitizeBranchName(branch) : null;
  return sanitized ? `${WORK_DIR}/${sanitized}` : WORK_DIR;
}

/**
 * Canonical names of rundown built-in template variables.
 *
 * Single source of truth for the keys produced by {@link getBuiltinVariables}.
 * Consumers (e.g. shell-env injection in `execution.ts`) should reference these
 * constants rather than hardcoding string literals so a rename here surfaces
 * as a typecheck error at every call site.
 */
export const BUILTIN_VARIABLES = {
  Date: 'Date',
  DateTime: 'DateTime',
  Year: 'Year',
  Month: 'Month',
  Day: 'Day',
  Branch: 'Branch',
  WorkPath: 'WorkPath',
  RunId: 'RunId',
  ContextId: 'ContextId',
} as const;

/**
 * Returns built-in default template variables.
 *
 * These have the lowest precedence and can be overridden by any other source
 * (frontmatter, config file, --input-file, or --input flags).
 *
 * @returns Built-in variables with PascalCase names
 */
export function getBuiltinVariables(): Record<string, string> {
  const now = new Date();
  const branch = detectGitBranch();
  return {
    [BUILTIN_VARIABLES.Date]: now.toISOString().slice(0, 10), // YYYY-MM-DD (UTC)
    [BUILTIN_VARIABLES.DateTime]: now.toISOString(), // Full ISO timestamp (UTC)
    [BUILTIN_VARIABLES.Year]: String(now.getUTCFullYear()), // YYYY (UTC)
    [BUILTIN_VARIABLES.Month]: String(now.getUTCMonth() + 1).padStart(2, '0'), // MM (01-12, UTC)
    [BUILTIN_VARIABLES.Day]: String(now.getUTCDate()).padStart(2, '0'), // DD (01-31, UTC)
    [BUILTIN_VARIABLES.Branch]: branch ?? '', // Raw git branch name (empty when not in git)
    [BUILTIN_VARIABLES.WorkPath]: computeWorkPath(branch), // Branch-isolated artifact directory
    [BUILTIN_VARIABLES.RunId]: randomBytes(4).toString('hex'), // 8-char hex
    [BUILTIN_VARIABLES.ContextId]: randomBytes(4).toString('hex'), // 8-char hex
  };
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
    const varFilePath = path.isAbsolute(vf) ? vf : path.join(cwd, vf);
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
 * Load a JSON file and return the parsed value as a template variable.
 *
 * @param canonical - Absolute filesystem path to the JSON file
 * @returns Parsed JSON value as JsonObject or JsonArray
 * @throws {Error} When the file cannot be read or contains invalid JSON
 */
async function loadJsonFile(canonical: string): Promise<JsonObject | JsonArray> {
  const content = await fs.readFile(canonical, 'utf-8');
  const parsed: unknown = JSON.parse(content);
  if (!isJsonValue(parsed) || parsed === null || typeof parsed !== 'object') {
    throw new Error(`File "${canonical}" contains ${typeof parsed}, expected JSON object or array`);
  }
  return parsed as JsonObject | JsonArray;
}

/**
 * Route a single variable value into vars based on its type.
 *
 * Unified routing rules (all values go into vars only):
 * - String with file: prefix → load file into vars:
 *   - `.json` → eager load as JsonObject or JsonArray
 *   - `.jsonl` → lazy JsonArrayStream reference
 *   - Other extensions → error (text support deferred)
 * - Array → vars as JsonArray (type-preserving)
 * - Non-array object → vars as JsonObject (for dotted template access)
 * - Number → vars (preserved, not stringified)
 * - Other scalar (boolean, null, string) → vars (stringified)
 *
 * @param key - Variable name
 * @param value - Variable value (unknown type)
 * @param vars - Accumulator for template variable values
 * @param cwd - Current working directory for resolving relative paths
 * @param projectRoot - Canonical project root path (pre-resolved)
 * @param security - Optional security context for file source policy enforcement
 * @param warnings - Optional array to collect routing warnings
 */
async function routeVariable(
  key: string,
  value: unknown,
  vars: Record<string, TemplateVarValue>,
  cwd: string,
  projectRoot: string,
  security?: VariableSecurityContext,
  warnings?: string[],
): Promise<void> {
  // String with file: prefix → load into vars based on extension
  if (typeof value === 'string' && value.startsWith('file:')) {
    const rawPath = value.slice(5);
    const resolved = path.resolve(cwd, rawPath);

    // Prevent path traversal outside the project directory.
    // Use realpath to resolve symlinks before validation to prevent escaping.
    let canonical = resolved;
    try {
      canonical = await fs.realpath(resolved);
    } catch {
      // File doesn't exist yet — use resolved path for validation
    }

    const rel = path.relative(projectRoot, canonical);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      warnings?.push(`Ignoring file source "${key}" — path escapes project directory`);
      return;
    }

    await enforceFileSourcePolicy(key, canonical, security);

    if (canonical.endsWith('.jsonl')) {
      // JSONL → lazy stream (file read at iteration time)
      vars[key] = createJsonArrayStream(canonical);
    } else if (canonical.endsWith('.json')) {
      // JSON → eager load as JsonObject or JsonArray
      vars[key] = await loadJsonFile(canonical);
    } else {
      throw new Error(
        `Unsupported file extension for variable "${key}": ${path.extname(canonical) || '(none)'}. ` +
          `Supported: .json, .jsonl`,
      );
    }

    return;
  }

  // Array → vars as JsonArray (type-preserving, not comma-joined)
  if (Array.isArray(value)) {
    if (value.every(isJsonValue)) {
      vars[key] = value as JsonArray;
    } else {
      warnings?.push(
        `Variable "${key}" array contains non-JSON values; converting items to strings`,
      );
      vars[key] = value.map(String) as unknown as JsonArray;
    }
    return;
  }

  // Non-array object → vars only as JsonObject (for dotted template access)
  // Validate recursively: yaml.load() can produce Date, undefined, etc.
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    if (isJsonValue(value)) {
      vars[key] = value as JsonObject;
    } else {
      warnings?.push(`Variable "${key}" contains non-JSON values; converting to string`);
      vars[key] = JSON.stringify(value);
    }
    return;
  }

  // Number → vars only (preserved, not stringified)
  // Guard against YAML .inf/-.inf/.nan which produce non-finite JS numbers
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      warnings?.push(
        `Variable "${key}" has non-finite numeric value (${String(value)}); converting to string`,
      );
      vars[key] = String(value);
    } else {
      vars[key] = value;
    }
    return;
  }

  // Other scalar (string, boolean, null) → vars only (stringified)
  vars[key] = String(value);
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
 * Layer 0: builtins        ← Date, Branch, WorkPath, RunId, ContextId (fresh)
 * Layer 1: inheritedVars   ← parent delegation vars (overrides builtins)
 * Layer 2: frontmatter     ← runbook YAML frontmatter vars:
 * Layer 3: discovered      ← .rundown/config.yaml (auto-discovered)
 * Layer 4: envBridge        ← RD_INPUT_* environment variables
 * Layer 5: cliFlags        ← --input-file, --input, --input-json (highest precedence)
 * ```
 *
 * The inherited layer ensures that parent ContextId survives into child
 * runbooks during delegation, rather than being replaced by a fresh builtin.
 *
 * @param options - Variable sources from CLI flags, input-file, frontmatter vars, and inherited vars
 * @param options.inputFile - Array of paths to YAML files containing variable definitions (repeatable)
 * @param options.input - Array of key=value flag strings from CLI
 * @param options.inputJson - Array of key=json flag strings from CLI for structured values
 * @param options.frontmatterVars - Pre-extracted frontmatter vars (from parser's validated RunbookFrontmatter)
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
    frontmatterVars?: Record<string, string | number | boolean>;
    inheritedVars?: Record<string, TemplateVarValue>;
  },
  cwd: string,
  warnings?: string[],
): Promise<Record<string, unknown>[]> {
  // Layer 0: Built-ins (lowest)
  const builtins: Record<string, unknown> = getBuiltinVariables();

  // Layer 1: Inherited vars from parent delegation (overrides builtins)
  const inherited: Record<string, unknown> = options.inheritedVars ?? {};

  // Layer 2: Frontmatter vars — pre-extracted from parser's validated RunbookFrontmatter
  const frontmatter: Record<string, unknown> = options.frontmatterVars ?? {};

  // Layer 3: Auto-discovered config
  const discovered: Record<string, unknown> = await discoverRawVariables(cwd);

  // Layer 4: Environment bridge (RD_INPUT_* env vars)
  const envBridge = collectEnvBridgeVars(warnings);

  // Layer 5: CLI flags (--input-file, --input, --input-json merged)
  const cliFlags = await collectCliFlags(options, cwd);

  return [builtins, inherited, frontmatter, discovered, envBridge, cliFlags];
}

/**
 * Canonicalize project root path for file source validation.
 *
 * Resolves symlinks when possible, falling back to the resolved path
 * if the directory doesn't exist.
 *
 * @param cwd - Current working directory to resolve
 * @returns Canonical project root path
 */
async function resolveProjectRoot(cwd: string): Promise<string> {
  let projectRoot = path.resolve(cwd);
  try {
    projectRoot = await fs.realpath(projectRoot);
  } catch {
    // cwd doesn't exist? — use resolved path
  }
  return projectRoot;
}

async function enforceFileSourcePolicy(
  key: string,
  canonicalPath: string,
  security?: VariableSecurityContext,
): Promise<void> {
  if (!security?.evaluator) {
    return;
  }

  const decision = security.evaluator.checkPath(canonicalPath, 'read');
  if (decision.allowed) {
    return;
  }

  if (decision.requiresPrompt && security.prompter) {
    const prompt = await security.prompter.requestPermission(
      'read',
      canonicalPath,
      decision.reason,
    );
    if (prompt.granted) {
      return;
    }
    throw new FileSourcePolicyError(key, canonicalPath, 'User denied permission');
  }

  throw new FileSourcePolicyError(key, canonicalPath, decision.reason);
}

/**
 * Resolve variables into the unified template variable map.
 *
 * Processes variable layers in precedence order (lowest to highest):
 * 1. Built-in defaults (Date, DateTime, Year, Month, Day, Branch, WorkPath, RunId, ContextId)
 * 1b. Inherited vars from parent delegation (overrides builtins)
 * 2. Frontmatter vars
 * 3. Auto-discovered .rundown/config.yaml
 * 3b. Environment bridge (RD_INPUT_* env vars)
 * 4. --input-file contents (repeatable, later overrides earlier)
 * 5. --input flags
 * 6. --input-json flags (highest precedence)
 *
 * Each variable value is routed into `vars` based on its type:
 * - String with `file:` prefix → JsonArrayStream (.jsonl) or JsonArray/JsonObject (.json)
 * - Array → JsonArray (type-preserving, not comma-joined)
 * - Non-array object (JsonObject) → preserved for dotted template access
 * - Number → preserved, not stringified
 * - Other scalar (boolean, null, plain string) → stringified
 *
 * @param options - Variable sources from CLI flags, input-file, frontmatter vars, and inherited vars
 * @param options.inputFile - Array of paths to YAML files containing variable definitions (repeatable)
 * @param options.input - Array of key=value flag strings from CLI
 * @param options.inputJson - Array of key=json flag strings from CLI for structured values
 * @param options.frontmatterVars - Pre-extracted frontmatter vars (from parser's validated RunbookFrontmatter)
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
    frontmatterVars?: Record<string, string | number | boolean>;
    inheritedVars?: Record<string, TemplateVarValue>;
  },
  cwd: string,
  security?: VariableSecurityContext,
): Promise<ResolvedVariables> {
  const vars: Record<string, TemplateVarValue> = {};
  const warnings: string[] = [];

  // Canonicalize project root once for validation
  const projectRoot = await resolveProjectRoot(cwd);

  // Collect raw inputs at each precedence level
  const layers = await collectRawLayers(options, cwd, warnings);

  // External provider layer indices — excludes builtins (0) and frontmatter (2).
  // Used to track which keys were actually accepted via routing for `required` var validation.
  // Indices must match collectRawLayers ordering: 1=inherited, 3=config, 4=env, 5=CLI.
  const EXTERNAL_PROVIDER_INDICES = new Set([1, 3, 4, 5]);
  const providedKeys = new Set<string>();

  // Process each layer in precedence order (lowest to highest)
  for (const [layerIndex, layer] of layers.entries()) {
    const entries = Object.entries(layer);

    // Pass 1: preflight reserved-key check (before any routing side effects)
    if (layerIndex > 0) {
      const reservedViolations: string[] = [];
      for (const [key] of entries) {
        if (isValidVariableName(key) && isRuntimeReservedVariable(key)) {
          reservedViolations.push(key);
        }
      }
      if (reservedViolations.length > 0) {
        const keys = reservedViolations.map((k) => `"${k}"`).join(', ');
        throw new Error(
          `Reserved runtime variable${reservedViolations.length > 1 ? 's' : ''} ${keys} cannot be overridden. ` +
            `Reserved names (case-insensitive): ${[...RUNTIME_RESERVED_VARIABLES].join(', ')}`,
        );
      }
    }

    // Pass 2: route variables (only reached when no reserved violations)
    for (const [key, value] of entries) {
      if (!isValidVariableName(key)) {
        warnings.push(`Ignoring variable with invalid key: ${key}`);
        continue;
      }
      await routeVariable(key, value, vars, cwd, projectRoot, security, warnings);
      // Track keys from external provider layers that were actually accepted by routing.
      // routeVariable() may silently reject values (e.g., path traversal in file: sources)
      // without writing to vars — only count keys that made it through.
      if (EXTERNAL_PROVIDER_INDICES.has(layerIndex) && key in vars) {
        providedKeys.add(key);
      }
    }
  }

  return { vars, warnings, providedKeys };
}

/**
 * Route raw extra variables through the standard normalization pipeline.
 *
 * Used by the delegate command to normalize --input, --input-file, and --input-json
 * values into the unified template variable map, matching the same pipeline
 * that the run command uses via {@link resolveVariables}.
 *
 * @param rawVars - Raw variables with potentially complex types (arrays, objects, scalars)
 * @param cwd - Current working directory for resolving file paths
 * @param security - Optional security context for file source policy enforcement
 * @returns Normalized vars map and any warnings
 */
export async function routeExtraVars(
  rawVars: Readonly<Record<string, unknown>>,
  cwd: string,
  security?: VariableSecurityContext,
): Promise<{
  vars: Record<string, TemplateVarValue>;
  warnings: string[];
}> {
  const vars: Record<string, TemplateVarValue> = {};
  const warnings: string[] = [];

  const projectRoot = await resolveProjectRoot(cwd);

  for (const [key, value] of Object.entries(rawVars)) {
    if (!isValidVariableName(key)) {
      warnings.push(`Ignoring variable with invalid key: ${key}`);
      continue;
    }
    if (isRuntimeReservedVariable(key)) {
      warnings.push(
        `Ignoring reserved runtime variable "${key}". ` +
          `Reserved names (case-insensitive): ${[...RUNTIME_RESERVED_VARIABLES].join(', ')}`,
      );
      continue;
    }
    await routeVariable(key, value, vars, cwd, projectRoot, security, warnings);
  }

  return { vars, warnings };
}
