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
import * as yaml from 'js-yaml';
import { extractRawFrontmatter } from '../helpers/extract-raw-frontmatter.js';
import type { DataSource, FileFormat, PolicyEvaluator, PolicyPrompter } from '@rundown-org/core';

/**
 * Valid identifier pattern for variable names.
 * Must start with letter or underscore, followed by letters, digits, or underscores.
 */
const VALID_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Runtime-reserved keys (normalized to lowercase) that cannot be overridden
 * by user-provided variables.
 *
 * These keys are owned by runtime frame/context resolution and should remain
 * deterministic across runbook execution.
 */
export const RUNTIME_RESERVED_VARIABLES = new Set(['step', 'index', 'context']);

/**
 * Check whether a variable name is reserved for runtime context semantics.
 *
 * Matching is case-insensitive (`Step`, `STEP`, and `step` are treated equally).
 */
export function isRuntimeReservedVariable(name: string): boolean {
  return RUNTIME_RESERVED_VARIABLES.has(name.toLowerCase());
}

/**
 * Resolved variables: string vars for template substitution + data sources for FOR loops.
 *
 * `vars` feeds the template rendering pipeline (unchanged).
 * `sources` is consumed only at FOR loop entry time.
 */
export interface ResolvedVariables {
  /**
   * Readonly map of string values used for template substitution.
   *
   * Feeds the Handlebars template rendering pipeline — every entry is
   * substituted into `{{key}}` placeholders at render time.  The map is
   * immutable for the lifetime of a single resolution pass.
   */
  readonly vars: Readonly<Record<string, string>>;
  /**
   * Readonly map of {@link DataSource} objects consumed only at FOR loop
   * entry time.
   *
   * Each entry provides the iteration data for a `FOR variable IN {{ key }}`
   * clause.  The map is immutable once resolved and is not used by the
   * template rendering pipeline.
   */
  readonly sources: Readonly<Record<string, DataSource>>;
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
 * Normalize a raw variables object to Record<string, string>.
 *
 * Validates keys match identifier pattern, converts values to strings,
 * and warns on invalid keys or complex values.
 *
 * @param vars - Raw variables object with unknown value types
 * @param source - Label for warning messages (e.g., "frontmatter var", "variable")
 * @returns Normalized variables with string values only
 */
function normalizeVariables(
  vars: Record<string, unknown>,
  source = 'variable',
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    if (!VALID_IDENTIFIER.test(key)) {
      console.warn(`Warning: Ignoring ${source} with invalid key: ${key}`);
      continue;
    }
    if (typeof value === 'object' && value !== null) {
      console.warn(`Warning: Ignoring ${source} "${key}" with complex value`);
      continue;
    }
    result[key] = String(value);
  }
  return result;
}

/**
 * Returns built-in default template variables.
 *
 * These have the lowest precedence and can be overridden by any other source
 * (frontmatter, config file, --var-file, or --var flags).
 *
 * @returns Built-in variables with PascalCase names
 */
export function getBuiltinVariables(): Record<string, string> {
  const now = new Date();
  return {
    Date: now.toISOString().slice(0, 10), // YYYY-MM-DD (UTC)
    DateTime: now.toISOString(), // Full ISO timestamp (UTC)
    Year: String(now.getUTCFullYear()), // YYYY (UTC)
    Month: String(now.getUTCMonth() + 1).padStart(2, '0'), // MM (01-12, UTC)
    Day: String(now.getUTCDate()).padStart(2, '0'), // DD (01-31, UTC)
    WorkPath: '.work', // Default artifact directory
  };
}

/**
 * Parse a --var flag value in key=value format.
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

  if (!key || !VALID_IDENTIFIER.test(key)) return null;

  return { key, value };
}

/**
 * Merge variable sources with precedence.
 *
 * Precedence (highest to lowest):
 * 1. --var flags (fromFlags)
 * 2. --var-file contents (fromFile)
 * 3. Auto-discovered .rundown/config.yaml (discovered)
 * 4. Frontmatter vars (frontmatter)
 * 5. Built-in defaults (builtins) - lowest precedence
 *
 * @param builtins - Built-in default variables (lowest precedence)
 * @param frontmatter - Variables from runbook frontmatter
 * @param discovered - Variables from auto-discovery
 * @param fromFile - Variables from --var-file
 * @param fromFlags - Variables from --var flags (highest precedence)
 * @returns Merged variables object
 */
export function mergeVariables(
  builtins: Record<string, string>,
  frontmatter: Record<string, string>,
  discovered: Record<string, string>,
  fromFile: Record<string, string>,
  fromFlags: Record<string, string>,
): Record<string, string> {
  return {
    ...builtins,
    ...frontmatter,
    ...discovered,
    ...fromFile,
    ...fromFlags,
  };
}

/**
 * Load variables from a YAML file.
 *
 * @param filePath - Absolute path to the YAML file
 * @param options - Optional: set normalize=false to preserve raw types (arrays, multiline strings)
 * @returns Variable record (string values when normalized, unknown values when raw)
 */
export async function loadVariablesFromFile(
  filePath: string,
  options: { normalize: false },
): Promise<Record<string, unknown>>;
export async function loadVariablesFromFile(
  filePath: string,
  options?: { normalize?: true },
): Promise<Record<string, string>>;
export async function loadVariablesFromFile(
  filePath: string,
  options?: { normalize?: boolean },
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
    return normalizeVariables(raw);
  } catch {
    return {};
  }
}

/**
 * Extract template variables from markdown frontmatter.
 *
 * Extracts the `vars` field from YAML frontmatter without requiring full
 * schema validation. This allows frontmatter defaults to be applied before
 * template rendering (which must happen before full parsing).
 *
 * Variable names must be valid identifiers (start with letter/underscore,
 * contain only letters, digits, underscores). Invalid keys are ignored with a warning.
 * All values are converted to strings for consistency with other variable sources.
 *
 * @param markdown - Raw markdown content with optional frontmatter
 * @returns Variables from frontmatter vars field, or empty object if none
 */
export function extractVarsFromMarkdown(markdown: string): Record<string, string> {
  const { frontmatter } = extractRawFrontmatter(markdown);

  if (!frontmatter || typeof frontmatter.vars !== 'object' || frontmatter.vars === null) {
    return {};
  }

  return normalizeVariables(frontmatter.vars as Record<string, unknown>, 'frontmatter var');
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
    const configPath = path.join(dir, '.rundown', 'config.yaml');

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
  const configPath = path.join(dir, '.rundown', 'config.yaml');
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
 * Infer file format from extension.
 *
 * @param filePath - The file path to inspect
 * @returns 'jsonl' for .jsonl files, 'text' for all others
 */
function inferFileFormat(filePath: string): FileFormat {
  return filePath.endsWith('.jsonl') ? 'jsonl' : 'text';
}

/**
 * Route a single variable value into vars and/or sources based on its type.
 *
 * Routing rules:
 * - String with file: prefix → file source only (not in vars)
 * - Array → both maps (comma-joined in vars, array DataSource in sources)
 * - Multiline string → both maps (raw in vars, split lines as array DataSource in sources)
 * - Other scalar → vars only
 *
 * @param key - Variable name
 * @param value - Variable value (unknown type)
 * @param vars - Accumulator for string variables
 * @param sources - Accumulator for data sources
 * @param cwd - Current working directory for resolving relative paths
 * @param projectRoot - Canonical project root path (pre-resolved)
 */
async function routeVariable(
  key: string,
  value: unknown,
  vars: Record<string, string>,
  sources: Record<string, DataSource>,
  cwd: string,
  projectRoot: string,
  security?: VariableSecurityContext,
): Promise<void> {
  // String with file: prefix → file source only (not in vars)
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
      console.warn(`Warning: Ignoring file source "${key}" — path escapes project directory`);
      return;
    }

    await enforceFileSourcePolicy(key, canonical, security);

    sources[key] = { kind: 'file', path: canonical, format: inferFileFormat(canonical) };

    delete vars[key];
    return;
  }

  // Array → both maps
  if (Array.isArray(value)) {
    const items = value.map(String);
    vars[key] = items.join(', ');
    sources[key] = { kind: 'array', items };
    return;
  }

  // Multiline string → both maps
  if (typeof value === 'string' && value.includes('\n')) {
    const lines = value.split('\n');
    // Store the value but strip trailing newline if present
    vars[key] = value.endsWith('\n') ? value.slice(0, -1) : value;
    sources[key] = { kind: 'array', items: lines };
    return;
  }

  // Scalar → vars only (clear any stale source from lower-precedence layer)
  if (typeof value === 'object' && value !== null) {
    console.warn(`Warning: Ignoring variable "${key}" with complex value`);
    return;
  }
  vars[key] = String(value);

  delete sources[key];
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
 * Collect raw (pre-normalization) variable layers in precedence order.
 *
 * Returns array from lowest to highest precedence.
 *
 * @param options - Variable sources from CLI flags, var-file, and frontmatter
 * @param cwd - Current working directory for resolving relative paths
 * @returns Array of variable layers in precedence order
 */
async function collectRawLayers(
  options: { varFile?: string; var?: string[]; frontmatterVars?: Record<string, unknown> },
  cwd: string,
): Promise<Record<string, unknown>[]> {
  // 1. Built-ins (lowest)
  const builtins: Record<string, unknown> = getBuiltinVariables();

  // 2. Frontmatter
  const frontmatter: Record<string, unknown> = options.frontmatterVars ?? {};

  // 3. Auto-discovered config
  const discovered: Record<string, unknown> = await discoverRawVariables(cwd);

  // 4. Var-file
  let fromFile: Record<string, unknown> = {};
  if (options.varFile) {
    const varFilePath = path.isAbsolute(options.varFile)
      ? options.varFile
      : path.join(cwd, options.varFile);
    fromFile = await loadVariablesFromFile(varFilePath, { normalize: false });
  }

  // 5. CLI flags (highest)
  const fromFlags: Record<string, unknown> = {};
  if (options.var) {
    for (const flag of options.var) {
      const parsed = parseVarFlag(flag);
      if (parsed) {
        fromFlags[parsed.key] = parsed.value;
      } else {
        console.warn(`Warning: Ignoring invalid --var flag: ${flag}`);
      }
    }
  }

  return [builtins, frontmatter, discovered, fromFile, fromFlags];
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
 * Resolve variables into dual maps: string vars for templates + data sources for FOR loops.
 *
 * Processes variable layers in precedence order (lowest to highest):
 * 1. Built-in defaults (Date, DateTime, Year, Month, Day, WorkPath)
 * 2. Frontmatter vars
 * 3. Auto-discovered .rundown/config.yaml
 * 4. --var-file contents
 * 5. --var flags (highest precedence)
 *
 * Each variable value is routed based on its type:
 * - String with file: prefix → file source only
 * - Array → both vars (comma-joined) and sources (array)
 * - Multiline string → both vars and sources (array of lines)
 * - Scalar → vars only
 *
 * @param options - Variable sources from CLI flags, var-file, and frontmatter
 * @param cwd - Current working directory for resolving relative paths
 * @param security - Optional security context for file source policy enforcement
 * @returns ResolvedVariables with vars and sources maps
 * @throws {FileSourcePolicyError} When a file-backed data source is blocked by security policy
 */
export async function resolveVariables(
  options: {
    varFile?: string;
    var?: string[];
    frontmatterVars?: Record<string, unknown>;
  },
  cwd: string,
  security?: VariableSecurityContext,
): Promise<ResolvedVariables> {
  const vars: Record<string, string> = {};
  const sources: Record<string, DataSource> = {};

  // Canonicalize project root once for validation
  let projectRoot = path.resolve(cwd);
  try {
    projectRoot = await fs.realpath(projectRoot);
  } catch {
    // cwd doesn't exist? (unlikely) - use resolved path
  }

  // Collect raw inputs at each precedence level
  const layers = await collectRawLayers(options, cwd);

  // Process each layer in precedence order (lowest to highest)
  for (const [layerIndex, layer] of layers.entries()) {
    for (const [key, value] of Object.entries(layer)) {
      if (!VALID_IDENTIFIER.test(key)) {
        console.warn(`Warning: Ignoring variable with invalid key: ${key}`);
        continue;
      }
      // Keep runtime-owned identifiers deterministic by rejecting overrides
      // from all non-built-in layers (frontmatter/config/var-file/--var).
      if (layerIndex > 0 && isRuntimeReservedVariable(key)) {
        console.warn(`Warning: Ignoring reserved runtime variable: ${key}`);
        continue;
      }
      await routeVariable(key, value, vars, sources, cwd, projectRoot, security);
    }
  }

  return { vars, sources };
}
