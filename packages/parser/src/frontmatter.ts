import { z } from 'zod';
import * as yaml from 'js-yaml';

/**
 * Runbook frontmatter metadata
 */
export interface RunbookFrontmatter {
  name: string;           // Required: runbook identifier
  description?: string;   // Optional: for listing
  version?: string;       // Optional: semantic version
  author?: string;        // Optional
  tags?: string[];        // Optional: categorization
}

/**
 * Zod schema for validating runbook frontmatter
 */
export const RunbookFrontmatterSchema = z.object({
  name: z
    .string()
    .min(1, 'Name is required')
    .regex(/^[a-z0-9-]+$/i, 'Name must contain only alphanumeric characters and hyphens'),
  description: z.string().optional(),
  version: z.string().optional(),
  author: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

/**
 * Type derived from Zod schema
 */
export type RunbookFrontmatterType = z.infer<typeof RunbookFrontmatterSchema>;

/**
 * Extract YAML frontmatter from markdown content.
 *
 * Parses YAML frontmatter enclosed in --- delimiters at the start of
 * a markdown file. Returns both the parsed frontmatter and the remaining
 * content with frontmatter stripped.
 *
 * Frontmatter requirements:
 * - Must be at the start of the file
 * - Must be enclosed in --- delimiters
 * - Must be valid YAML conforming to RunbookFrontmatterSchema
 *
 * @param markdown - The raw markdown content to parse
 * @returns Object containing parsed frontmatter (or null if missing/invalid)
 *          and the remaining content with frontmatter removed
 */
export function extractFrontmatter(markdown: string): {
  frontmatter: RunbookFrontmatter | null;
  content: string;
} {
  const trimmed = markdown.trim();

  // Check if starts with ---
  if (!trimmed.startsWith('---')) {
    return {
      frontmatter: null,
      content: markdown,
    };
  }

  // Find the closing --- delimiter
  const lines = trimmed.split('\n');
  let endIndex = -1;

  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIndex = i;
      break;
    }
  }

  // If no closing delimiter found, treat as regular content
  if (endIndex === -1) {
    return {
      frontmatter: null,
      content: markdown,
    };
  }

  try {
    // Extract YAML content between delimiters
    const yamlContent = lines.slice(1, endIndex).join('\n');
    const parsed = yaml.load(yamlContent) as Record<string, unknown>;

    // Validate against schema
    const validated = RunbookFrontmatterSchema.parse(parsed);

    // Extract remaining content (after closing ---)
    const remaining = lines.slice(endIndex + 1).join('\n').trimStart();

    return {
      frontmatter: validated,
      content: remaining,
    };
  } catch {
    // If YAML parsing or validation fails, return null and original content
    return {
      frontmatter: null,
      content: markdown,
    };
  }
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
