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

import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { extractRawFrontmatter } from '../helpers/extract-raw-frontmatter.js';

/**
 * Valid identifier pattern for variable names.
 * Must start with letter or underscore, followed by letters, digits, or underscores.
 */
const VALID_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

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
    Date: now.toISOString().slice(0, 10), // YYYY-MM-DD
    DateTime: now.toISOString(), // Full ISO timestamp
    Year: String(now.getFullYear()), // YYYY
    Month: String(now.getMonth() + 1).padStart(2, '0'), // MM (01-12)
    Day: String(now.getDate()).padStart(2, '0'), // DD (01-31)
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
 * 4. Built-in defaults (builtins) - lowest precedence
 *
 * @param builtins - Built-in default variables (lowest precedence)
 * @param discovered - Variables from auto-discovery
 * @param fromFile - Variables from --var-file
 * @param fromFlags - Variables from --var flags
 * @returns Merged variables object
 */
export function mergeVariables(
  builtins: Record<string, string>,
  discovered: Record<string, string>,
  fromFile: Record<string, string>,
  fromFlags: Record<string, string>
): Record<string, string> {
  return {
    ...builtins,
    ...discovered,
    ...fromFile,
    ...fromFlags,
  };
}

/**
 * Load variables from a YAML file.
 *
 * Variable names must be valid identifiers (start with letter/underscore,
 * contain only letters, digits, underscores). Invalid keys are ignored with a warning.
 * All values are converted to strings for consistency with other variable sources.
 *
 * @param filePath - Path to the YAML file
 * @returns Variables object, or empty object if file doesn't exist or is invalid
 */
export async function loadVariablesFromFile(
  filePath: string
): Promise<Record<string, string>> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = yaml.load(content);

    if (typeof parsed !== 'object' || parsed === null) {
      return {};
    }

    // Convert all values to strings, validating keys
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      // Validate key is a valid identifier
      if (!VALID_IDENTIFIER.test(key)) {
        console.warn(`Warning: Ignoring variable with invalid key: ${key}`);
        continue;
      }

      // Convert value to string, warn for complex values
      if (typeof value === 'object' && value !== null) {
        console.warn(`Warning: Variable "${key}" has complex value, coerced to string`);
      }
      result[key] = String(value);
    }
    return result;
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
export function extractVarsFromMarkdown(
  markdown: string
): Record<string, string> {
  const { frontmatter } = extractRawFrontmatter(markdown);

  if (!frontmatter || typeof frontmatter.vars !== 'object' || frontmatter.vars === null) {
    return {};
  }

  const vars = frontmatter.vars as Record<string, unknown>;
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(vars)) {
    // Validate key is a valid identifier
    if (!VALID_IDENTIFIER.test(key)) {
      console.warn(`Warning: Ignoring frontmatter var with invalid key: ${key}`);
      continue;
    }

    // Convert value to string, warn for complex values
    if (typeof value === 'object' && value !== null) {
      console.warn(`Warning: Frontmatter var "${key}" has complex value, coerced to string`);
    }
    result[key] = String(value);
  }

  return result;
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
export async function discoverVariables(
  cwd: string
): Promise<Record<string, string>> {
  let dir = cwd;
  let parent = path.dirname(dir);

  // Continue while we haven't reached filesystem root
  while (parent !== dir) {
    const configPath = path.join(dir, '.rundown', 'config.yaml');

    try {
      await fs.access(configPath);
      return await loadVariablesFromFile(configPath);
    } catch {
      // File doesn't exist, continue searching
    }

    // Check if we've reached git root
    const gitPath = path.join(dir, '.git');
    try {
      await fs.access(gitPath);
      // Found git root, stop searching
      return {};
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
    return await loadVariablesFromFile(configPath);
  } catch {
    return {};
  }
}

/**
 * Collect all variables from CLI options and auto-discovery.
 *
 * Precedence (highest to lowest):
 * 1. --var flags
 * 2. --var-file contents
 * 3. Auto-discovered .rundown/config.yaml
 * 4. Built-in defaults (Date, DateTime, Year, Month, Day, WorkPath)
 *
 * @param options - CLI options containing varFile and var flags
 * @param cwd - Current working directory
 * @returns Merged variables with proper precedence
 */
export async function collectVariables(
  options: { varFile?: string; var?: string[] },
  cwd: string
): Promise<Record<string, string>> {
  // 1. Get built-in defaults (lowest precedence)
  const builtins = getBuiltinVariables();

  // 2. Auto-discover from .rundown/config.yaml
  const discovered = await discoverVariables(cwd);

  // 3. Load from --var-file if provided
  let fromFile: Record<string, string> = {};
  if (options.varFile) {
    const varFilePath = path.isAbsolute(options.varFile)
      ? options.varFile
      : path.join(cwd, options.varFile);
    fromFile = await loadVariablesFromFile(varFilePath);
  }

  // 4. Parse --var flags (highest precedence)
  const fromFlags: Record<string, string> = {};
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

  // 5. Merge with precedence: builtins < discovered < fromFile < fromFlags
  return mergeVariables(builtins, discovered, fromFile, fromFlags);
}
