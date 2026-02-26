import matter from 'gray-matter';
import { z } from 'zod';

/**
 * Runbook frontmatter metadata
 */
export interface RunbookFrontmatter {
  name?: string; // Optional: runbook identifier
  description?: string; // Optional: for listing
  version?: string; // Optional: semantic version
  author?: string; // Optional
  tags?: string[]; // Optional: categorization
  vars?: Record<string, string | number | boolean>; // Optional: default template variables
  [key: string]: unknown; // Allow unknown fields
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
        /^[a-zA-Z0-9_-]+$/,
        'Name must contain only alphanumeric characters, underscores, and hyphens',
      )
      .optional(),
    description: z.string().optional(),
    version: z.string().optional(),
    author: z.string().optional(),
    tags: z.array(z.string()).optional(),
    vars: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
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
 * Note: When validation fails, content is still stripped of frontmatter.
 * The original markdown is only returned when gray-matter itself fails to parse
 * the YAML syntax or when no frontmatter is present.
 *
 * @param markdown - The raw markdown content to parse
 * @returns Object containing parsed frontmatter (or null if missing/invalid)
 *          and the remaining content with frontmatter removed
 */
export function extractFrontmatter(markdown: string): {
  frontmatter: RunbookFrontmatter | null;
  content: string;
} {
  let data: Record<string, unknown>;
  let content: string;

  try {
    const result = matter(markdown);
    data = result.data;
    content = result.content;
  } catch {
    // gray-matter throws on invalid YAML syntax
    return { frontmatter: null, content: markdown };
  }

  // No frontmatter present
  if (Object.keys(data).length === 0) {
    return { frontmatter: null, content: markdown };
  }

  // Validate with Zod (passthrough allows unknown fields)
  const result = RunbookFrontmatterSchema.safeParse(data);

  if (!result.success) {
    // Log validation errors in debug mode, but still return content stripped of frontmatter
    if (process.env.RUNDOWN_LOG_LEVEL === 'debug') {
      console.error('Frontmatter validation error:', result.error.format());
    }
    return { frontmatter: null, content };
  }

  return { frontmatter: result.data, content };
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
