import matter from 'gray-matter';
import { z } from 'zod';
import { isReservedTemplateName } from './reserved.js';
import type { ValidationDiagnostic } from './validator.js';
import type { OutputDeclaration } from './ast.js';
import { parseFrontmatterOutputDeclaration } from './helpers.js';

const IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const POISONED_IDENTIFIER_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Check whether a frontmatter identifier is syntactically valid and safe.
 *
 * @param name - Candidate identifier to validate
 * @returns True when the identifier matches the allowed pattern and is not a poisoned key
 */
function isSafeIdentifier(name: string): boolean {
  return IDENTIFIER_PATTERN.test(name) && !POISONED_IDENTIFIER_KEYS.has(name);
}

/**
 * Known frontmatter keys whose casing is normalized before Zod parsing.
 * All other keys are passed through as-is.
 */
const NORMALIZED_FRONTMATTER_KEYS = new Set([
  'name',
  'description',
  'version',
  'author',
  'tags',
  'required',
  'inputs',
  'outputs',
]);

/**
 * Normalize the casing of known frontmatter keys so that `INPUTS`, `OUTPUTS`,
 * `REQUIRED`, etc. are treated identically to their lowercase equivalents.
 *
 * Unknown keys (e.g. `skill`, `scenarios`) are preserved exactly as written.
 * When both `INPUTS` and `inputs` appear, the first one encountered wins and
 * the duplicate is silently dropped.
 *
 * @param obj - Raw YAML-parsed frontmatter object
 * @returns A new object with known keys lowercased
 */
function normalizeKnownFrontmatterKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const lower = key.toLowerCase();
    if (NORMALIZED_FRONTMATTER_KEYS.has(lower)) {
      if (!Object.hasOwn(result, lower)) {
        result[lower] = value; // first occurrence wins on case collision
      }
    } else {
      result[key] = value; // unknown passthrough keys preserved as-is
    }
  }
  return result;
}

/**
 * Runbook frontmatter metadata.
 *
 * Known fields have explicit types. The index signature (`[key: string]: unknown`)
 * allows unknown passthrough fields (e.g. `skill`, `scenarios`) to be preserved
 * without loss. Named properties always take precedence over the index signature
 * for property access.
 *
 * Use an explicit object type with an index signature rather than an intersection
 * (`KnownFields & Record<string, unknown>`) so that TypeScript correctly narrows
 * named properties to their declared types instead of widening to `unknown`.
 */
export interface RunbookFrontmatter {
  name?: string; // Optional: runbook identifier
  description?: string; // Optional: for listing
  version?: string; // Optional: semantic version
  author?: string; // Optional
  tags?: string[]; // Optional: categorization
  inputs?: string[]; // Optional: declared template variable names
  required?: string[]; // Optional: variables that must be provided by caller
  outputs?: OutputDeclaration[]; // Optional: variables to publish to context OUTPUTS at completion
  [key: string]: unknown; // Passthrough fields preserved verbatim
}

/**
 * Zod schema for validating runbook frontmatter.
 * Uses .passthrough() to allow unknown fields like 'skill' to be preserved.
 */
export const RunbookFrontmatterSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(
        /^[a-zA-Z0-9_-](?:[a-zA-Z0-9_ -]*[a-zA-Z0-9_-])?$/,
        'Name must contain only alphanumeric characters, spaces, underscores, and hyphens, and must not start or end with a space',
      )
      .optional()
      .catch(undefined),
    description: z.string().optional().catch(undefined),
    version: z.string().optional().catch(undefined),
    author: z.string().optional().catch(undefined),
    tags: z.array(z.string()).optional().catch(undefined),
    inputs: z.unknown().optional().catch(undefined),
    // Defer per-element validation of `required`/`outputs` to a post-zod pass
    // so we can preserve valid entries and emit per-index diagnostics
    // (rather than silently dropping the whole array on any single failure).
    required: z.array(z.unknown()).optional().catch(undefined),
    outputs: z.array(z.unknown()).optional().catch(undefined),
  })
  .passthrough();

/**
 * Type derived from Zod schema
 */
export type RunbookFrontmatterType = z.infer<typeof RunbookFrontmatterSchema>;

/**
 * Extract YAML frontmatter from markdown content using gray-matter.
 *
 * Parses YAML frontmatter enclosed in --- delimiters at the start of
 * a markdown file. Returns both the parsed frontmatter and the remaining
 * content with frontmatter stripped.
 *
 * Frontmatter requirements:
 * - Must be at the start of the file
 * - Must be enclosed in --- delimiters
 * - Must be valid YAML conforming to RunbookFrontmatterSchema
 * - Unknown fields are preserved via .passthrough()
 *
 * Note: Individual field validation errors are handled gracefully — invalid
 * fields become `undefined` while valid fields and unknown extension fields
 * are preserved. The original markdown is only returned when gray-matter itself
 * fails to parse the YAML syntax or when no frontmatter is present.
 *
 * Known frontmatter keys (`name`, `inputs`, `outputs`, `required`, etc.) are
 * case-insensitive: `INPUTS`, `Inputs`, and `inputs` are all equivalent.
 *
 * @param markdown - The raw markdown content to parse
 * @returns Object containing parsed frontmatter (or null if missing/invalid)
 *          and the remaining content with frontmatter removed
 */
export function extractFrontmatter(markdown: string): {
  frontmatter: RunbookFrontmatter | null;
  content: string;
  diagnostics: ValidationDiagnostic[];
} {
  let data: unknown;
  let content: string;

  try {
    const result = matter(markdown);
    data = result.data;
    content = result.content;
  } catch {
    // gray-matter throws on invalid YAML syntax
    return { frontmatter: null, content: markdown, diagnostics: [] };
  }

  // Non-object YAML (arrays, scalars) is not valid frontmatter
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { frontmatter: null, content, diagnostics: [] };
  }

  // No frontmatter fields present. gray-matter has already separated any
  // empty `---` / `---` fences from the body into `content`, so we must not
  // return the original `markdown` here — doing so puts the fences back into
  // the downstream parser input and changes the AST (the `---` becomes a
  // thematic break / heading underline).
  if (Object.keys(data).length === 0) {
    return { frontmatter: null, content, diagnostics: [] };
  }

  // Normalize known key casing before Zod parsing so that INPUTS/OUTPUTS/etc.
  // are treated the same as their lowercase counterparts.
  const normalized = normalizeKnownFrontmatterKeys(data as Record<string, unknown>);

  // Validate with Zod — .catch(undefined) on each field ensures parse always succeeds.
  // Invalid fields become undefined; valid fields and unknown passthrough fields are preserved.
  const parsed = RunbookFrontmatterSchema.parse(normalized);

  // Per-element validation of `inputs` / `required` / `outputs` (zod accepts unknown[] for
  // these and we filter here so we can preserve valid entries and emit
  // diagnostics for each invalid one — instead of silently dropping the whole
  // array on the first bad element).
  const diagnostics: ValidationDiagnostic[] = [];
  const inputs =
    parsed.inputs !== undefined ? filterInputDeclarations(parsed.inputs, diagnostics) : undefined;
  const required =
    parsed.required !== undefined
      ? filterIdentifierArray(parsed.required, 'required', diagnostics)
      : undefined;
  validateRequiredSubset(required, inputs, diagnostics);
  const frontmatter: RunbookFrontmatter = {
    ...parsed,
    inputs,
    required,
    outputs:
      parsed.outputs !== undefined
        ? filterOutputDeclarationArray(parsed.outputs, diagnostics)
        : undefined,
  };

  return { frontmatter, content, diagnostics };
}

/**
 * Validate frontmatter `inputs` declarations.
 *
 * Accepts a YAML sequence of bare identifier strings. Any non-sequence input
 * or non-string entry is rejected with a diagnostic. Valid entries are kept in
 * author order and duplicates are reported as errors.
 *
 * @param raw - Raw `inputs` value from frontmatter
 * @param diagnostics - Output array; validation errors are appended in-place
 * @returns The valid input names, or `undefined` when the field is absent,
 *   empty, or invalid
 */
function filterInputDeclarations(
  raw: unknown,
  diagnostics: ValidationDiagnostic[],
): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    diagnostics.push({
      severity: 'error',
      message:
        'Frontmatter "inputs" must be a YAML sequence of variable names (for example: inputs: [PlanPath] or inputs:\n  - PlanPath)',
    });
    return undefined;
  }

  if (raw.length === 0) return undefined;

  const kept: string[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    if (typeof entry !== 'string') {
      diagnostics.push({
        severity: 'error',
        message: `Frontmatter "inputs[${String(index)}]" must be a string identifier (got ${typeof entry})`,
      });
      return;
    }
    if (!isSafeIdentifier(entry)) {
      diagnostics.push({
        severity: 'error',
        message: `Frontmatter "inputs[${String(index)}]" — "${entry}" is not a valid identifier`,
      });
      return;
    }
    if (isReservedTemplateName(entry)) {
      diagnostics.push({
        severity: 'error',
        message: `Frontmatter "inputs[${String(index)}]" — "${entry}" is a reserved variable name (step, index, context — case-insensitive)`,
      });
      return;
    }
    if (seen.has(entry)) {
      diagnostics.push({
        severity: 'error',
        message: `Frontmatter "inputs[${String(index)}]" — duplicate entry "${entry}" in "inputs" — each variable should be listed once`,
      });
      return;
    }
    seen.add(entry);
    kept.push(entry);
  });
  return kept.length > 0 ? kept : undefined;
}

/**
 * Validate each element of a frontmatter identifier array, keeping the valid
 * entries and emitting an error diagnostic for each invalid one. Returns
 * `undefined` if no valid entries remain (so downstream code sees the same
 * "field absent" signal as before). An explicitly-empty input is preserved
 * as `[]` (no diagnostics emitted). Duplicate entries are rejected.
 *
 * @param raw         - Raw array elements from the parsed frontmatter
 * @param field       - Field name (`required`) used in diagnostic messages
 * @param diagnostics - Output array — error diagnostics are appended in-place
 * @returns The valid identifiers, `[]` when raw was empty, or `undefined` when all entries were rejected
 */
function filterIdentifierArray(
  raw: unknown[],
  field: 'required',
  diagnostics: ValidationDiagnostic[],
): string[] | undefined {
  // Explicit empty array is preserved as-is (no diagnostics, no rejection).
  if (raw.length === 0) return [];

  const kept: string[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    if (typeof entry !== 'string') {
      diagnostics.push({
        severity: 'error',
        message: `Frontmatter "${field}[${String(index)}]" must be a string identifier (got ${typeof entry})`,
      });
      return;
    }
    if (!isSafeIdentifier(entry)) {
      diagnostics.push({
        severity: 'error',
        message: `Frontmatter "${field}[${String(index)}]" — "${entry}" is not a valid identifier`,
      });
      return;
    }
    if (isReservedTemplateName(entry)) {
      diagnostics.push({
        severity: 'error',
        message: `Frontmatter "${field}[${String(index)}]" — "${entry}" is a reserved variable name (step, index, context — case-insensitive)`,
      });
      return;
    }
    if (seen.has(entry)) {
      diagnostics.push({
        severity: 'error',
        message: `Frontmatter "${field}[${String(index)}]" — duplicate entry "${entry}" in "${field}" — each variable should be listed once`,
      });
      return;
    }
    seen.add(entry);
    kept.push(entry);
  });
  return kept.length > 0 ? kept : undefined;
}

/**
 * Validate that required variables are declared in frontmatter inputs.
 *
 * @param required - Filtered required names from frontmatter
 * @param inputs - Filtered input declarations from frontmatter
 * @param diagnostics - Output array; validation errors are appended in-place
 */
function validateRequiredSubset(
  required: string[] | undefined,
  inputs: string[] | undefined,
  diagnostics: ValidationDiagnostic[],
): void {
  if (!required || required.length === 0) return;
  const declared = new Set(inputs ?? []);
  for (const name of required) {
    if (!declared.has(name)) {
      diagnostics.push({
        severity: 'error',
        message: `Frontmatter "required" variable "${name}" must also be declared in "inputs"`,
      });
    }
  }
}

/**
 * Validate each element of a frontmatter outputs array, keeping the valid
 * entries and emitting an error diagnostic for each invalid one.
 *
 * Accepts both naked form (`PlanPath`) and with-value form
 * (`PlanPath {{ path "plan.json" }}`). Returns `undefined` if no valid
 * entries remain.
 *
 * @param raw         - Raw array elements from the parsed frontmatter
 * @param diagnostics - Output array — error diagnostics are appended in-place
 * @returns Valid OutputDeclaration[], `[]` when raw was empty, or `undefined` when all rejected
 */
function filterOutputDeclarationArray(
  raw: unknown[],
  diagnostics: ValidationDiagnostic[],
): OutputDeclaration[] | undefined {
  if (raw.length === 0) return [];

  const kept: OutputDeclaration[] = [];
  raw.forEach((entry, index) => {
    if (typeof entry !== 'string') {
      diagnostics.push({
        severity: 'error',
        message: `Frontmatter "outputs[${String(index)}]" must be a string (got ${typeof entry})`,
      });
      return;
    }
    const decl = parseFrontmatterOutputDeclaration(entry);
    if (!decl) {
      diagnostics.push({
        severity: 'error',
        message: `Frontmatter "outputs[${String(index)}]" — "${entry}" is not a valid output declaration`,
      });
      return;
    }
    if (isReservedTemplateName(decl.name)) {
      diagnostics.push({
        severity: 'error',
        message: `Frontmatter "outputs[${String(index)}]" — "${decl.name}" is a reserved variable name (step, index, context — case-insensitive)`,
      });
      return;
    }
    kept.push(decl);
  });
  return kept.length > 0 ? kept : undefined;
}

/**
 * Extract runbook name from a runbook filename.
 *
 * Removes the .runbook.md extension to derive the runbook name.
 * Used as a fallback when frontmatter does not specify a name.
 *
 * @param filename - The runbook filename (e.g., "my-runbook.runbook.md")
 * @returns The runbook name without extension (e.g., "my-runbook")
 *
 * @example
 * nameFromFilename("setup.runbook.md") // returns "setup"
 */
export function nameFromFilename(filename: string): string {
  return filename.replace(/\.runbook\.md$/i, '');
}
