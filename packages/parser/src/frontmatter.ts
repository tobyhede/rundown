import { z } from 'zod';
import * as yaml from 'js-yaml';

/**
 * Workflow frontmatter metadata
 */
export interface WorkflowFrontmatter {
  name: string;           // Required: workflow identifier
  description?: string;   // Optional: for listing
  version?: string;       // Optional: semantic version
  author?: string;        // Optional
  tags?: string[];        // Optional: categorization
}

/**
 * Zod schema for validating workflow frontmatter
 */
export const WorkflowFrontmatterSchema = z.object({
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
export type WorkflowFrontmatterType = z.infer<typeof WorkflowFrontmatterSchema>;

/**
 * Extract frontmatter from markdown content
 * Returns frontmatter object and remaining content (with frontmatter stripped)
 *
 * Frontmatter must be:
 * - At the start of the file
 * - Enclosed in --- delimiters
 * - Valid YAML
 *
 * If frontmatter is missing or invalid, returns null for frontmatter and original content
 */
export function extractFrontmatter(markdown: string): {
  frontmatter: WorkflowFrontmatter | null;
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
    const validated = WorkflowFrontmatterSchema.parse(parsed);

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
 * Extract workflow name from filename
 * Removes the .runbook.md extension
 *
 * Example: "my-runbook.runbook.md" -> "my-runbook"
 */
export function nameFromFilename(filename: string): string {
  return filename.replace(/\.runbook\.md$/i, '');
}
