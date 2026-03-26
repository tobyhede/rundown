/**
 * Generic schema resolution and validation for the rdx CLI.
 *
 * Schema modules are discovered by convention: a schema name like "plan"
 * resolves to a sibling module `./plan-schema.js` that exports a
 * `validate(data: unknown): unknown` function.
 *
 * @module rdx-validate
 */

import { getErrorMessage, isZodError } from './shared/errors.js';

/** URI prefix for Rundown schema identifiers. */
const SCHEMA_URI_PREFIX = 'https://rundown.org/schemas/';

/** Suffix for schema URI filenames. */
const SCHEMA_URI_SUFFIX = '.schema.json';

/**
 * Extract a schema name from a `$schema` value.
 *
 * Accepts both full URIs (`https://rundown.org/schemas/plan.schema.json` → `"plan"`)
 * and bare names (`"plan"` → `"plan"`) for backward compatibility with the `--schema` flag.
 *
 * @param raw - The raw `$schema` string value
 * @returns The extracted schema name, or undefined if the value is unrecognized
 */
export function parseSchemaName(raw: string): string | undefined {
  if (raw.startsWith(SCHEMA_URI_PREFIX) && raw.endsWith(SCHEMA_URI_SUFFIX)) {
    const name = raw.slice(SCHEMA_URI_PREFIX.length, -SCHEMA_URI_SUFFIX.length);
    return /^[a-z][a-z0-9-]*$/.test(name) ? name : undefined;
  }
  // Bare name fallback (e.g. --schema plan)
  return /^[a-z][a-z0-9-]*$/.test(raw) ? raw : undefined;
}

/**
 * Extract and strip the `$schema` field from parsed JSON data.
 *
 * @param data - Parsed JSON data (may or may not contain `$schema`)
 * @returns Object with `cleanData` (data without `$schema`) and `schemaName` (extracted name or undefined)
 */
export function stripSchema(data: unknown): {
  cleanData: unknown;
  schemaName: string | undefined;
} {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { cleanData: data, schemaName: undefined };
  }

  const obj = data as Record<string, unknown>;
  if (typeof obj.$schema !== 'string') {
    return { cleanData: data, schemaName: undefined };
  }

  const { $schema: rawSchema, ...cleanData } = obj;
  return { cleanData, schemaName: parseSchemaName(rawSchema) };
}

/**
 * Resolve the effective schema name from explicit flag and data field.
 *
 * @param explicit - Value from `--schema` CLI flag (highest priority)
 * @param fromData - Value extracted from `$schema` field in data
 * @returns Resolved schema name, or undefined if no schema specified
 */
export function resolveSchemaName(
  explicit: string | undefined,
  fromData: string | undefined,
): string | undefined {
  return explicit ?? fromData;
}

/**
 * Dynamically load a schema validator by convention name.
 *
 * Resolves schema name to a sibling module: `<name>-schema.js`.
 * The module must export a `validate(data: unknown): unknown` function.
 *
 * @param name - Schema name (e.g. "plan" resolves to "./plan-schema.js")
 * @returns The validate function from the schema module
 * @throws {Error} If the module is not found or does not export `validate`
 */
export async function loadValidator(name: string): Promise<(data: unknown) => unknown> {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(`Invalid schema name: ${name}`);
  }
  let mod: Record<string, unknown>;
  try {
    mod = (await import(`./${name}-schema.js`)) as Record<string, unknown>;
  } catch {
    throw new Error(`Unknown schema: ${name}`);
  }
  if (typeof mod.validate !== 'function') {
    throw new Error(`Schema module '${name}-schema' does not export a validate() function`);
  }
  return mod.validate as (data: unknown) => unknown;
}

/**
 * Format a validation error (typically ZodError) as human-readable lines.
 *
 * @param error - The caught error (ZodError or other)
 * @param schemaName - Optional schema name for context in output
 * @returns Formatted multi-line error string
 */
export function formatValidationErrors(error: unknown, schemaName?: string): string {
  const label = schemaName ? ` (${schemaName})` : '';

  if (isZodError(error)) {
    const details = error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? `/${issue.path.join('/')}` : '(root)';
        return `  ${path}: ${issue.message}`;
      })
      .join('\n');
    return `error: schema validation failed${label}\n${details}\n`;
  }

  return `error: schema validation failed${label}\n  ${getErrorMessage(error)}\n`;
}
