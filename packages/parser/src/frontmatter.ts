import matter from 'gray-matter';
import { z } from 'zod';
import { isReservedTemplateName } from './reserved.js';
import type { ValidationDiagnostic } from './validator.js';

const IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Known runbook frontmatter metadata fields.
 */
interface KnownRunbookFrontmatter {
  name?: string; // Optional: runbook identifier
  description?: string; // Optional: for listing
  version?: string; // Optional: semantic version
  author?: string; // Optional
  tags?: string[]; // Optional: categorization
  vars?: Record<string, string | number | boolean>; // Optional: default template variables
  required?: string[]; // Optional: variables that must be provided by caller
  inputs?: string[]; // Optional: variables this runbook can receive from context OUTPUTS
}

/**
 * Runbook frontmatter metadata with typed known fields plus passthrough extras.
 */
export type RunbookFrontmatter = KnownRunbookFrontmatter & Record<string, unknown>;

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
    vars: z
      .record(z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .catch(undefined),
    // Defer per-element validation of `required`/`inputs` to a post-zod pass
    // so we can preserve valid entries and emit per-index diagnostics
    // (rather than silently dropping the whole array on any single failure).
    required: z.array(z.unknown()).optional().catch(undefined),
    inputs: z.array(z.unknown()).optional().catch(undefined),
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

  // Validate with Zod — .catch(undefined) on each field ensures parse always succeeds.
  // Invalid fields become undefined; valid fields and unknown passthrough fields are preserved.
  const parsed = RunbookFrontmatterSchema.parse(data);

  // Per-element validation of `required` / `inputs` (zod accepts unknown[] for
  // these and we filter here so we can preserve valid entries and emit
  // diagnostics for each invalid one — instead of silently dropping the whole
  // array on the first bad element).
  const diagnostics: ValidationDiagnostic[] = [];
  const frontmatter: RunbookFrontmatter = {
    ...parsed,
    required:
      parsed.required !== undefined
        ? filterIdentifierArray(parsed.required, 'required', diagnostics)
        : undefined,
    inputs:
      parsed.inputs !== undefined
        ? filterIdentifierArray(parsed.inputs, 'inputs', diagnostics)
        : undefined,
  };

  return { frontmatter, content, diagnostics };
}

/**
 * Validate each element of a frontmatter identifier array, keeping the valid
 * entries and emitting an error diagnostic for each invalid one. Returns
 * `undefined` if no valid entries remain (so downstream code sees the same
 * "field absent" signal as before). An explicitly-empty input is preserved
 * as `[]` (no diagnostics emitted).
 *
 * @param raw         - Raw array elements from the parsed frontmatter
 * @param field       - Field name (`inputs` or `required`) used in diagnostic messages
 * @param diagnostics - Output array — error diagnostics are appended in-place
 * @returns The valid identifiers, `[]` when raw was empty, or `undefined` when all entries were rejected
 */
function filterIdentifierArray(
  raw: unknown[],
  field: 'inputs' | 'required',
  diagnostics: ValidationDiagnostic[],
): string[] | undefined {
  // Explicit empty array is preserved as-is (no diagnostics, no rejection).
  if (raw.length === 0) return [];

  const kept: string[] = [];
  raw.forEach((entry, index) => {
    if (typeof entry !== 'string') {
      diagnostics.push({
        severity: 'error',
        message: `Frontmatter "${field}[${String(index)}]" must be a string identifier (got ${typeof entry})`,
      });
      return;
    }
    if (!IDENTIFIER_PATTERN.test(entry)) {
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
    kept.push(entry);
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
