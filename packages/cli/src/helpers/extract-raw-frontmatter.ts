import { load as parseYaml } from 'js-yaml';

/**
 * Result of extracting raw frontmatter from markdown.
 */
export interface RawFrontmatterResult {
  /** Parsed YAML as plain object, or null if no valid frontmatter */
  frontmatter: Record<string, unknown> | null;
  /** Markdown content after frontmatter */
  content: string;
}

/**
 * Extract raw YAML frontmatter from markdown without validation.
 *
 * Unlike the parser's extractFrontmatter, this preserves ALL fields
 * from the YAML without validating against RunbookFrontmatterSchema.
 * Used by CLI for accessing extension fields like `scenarios`.
 *
 * @param markdown - The markdown content with optional frontmatter
 * @returns Object with raw frontmatter (or null) and remaining content
 */
export function extractRawFrontmatter(markdown: string): RawFrontmatterResult {
  // Trim leading whitespace to match parser behavior (allows blank lines before ---)
  const trimmed = markdown.trim();

  // Check if starts with frontmatter delimiter
  if (!trimmed.startsWith('---')) {
    return { frontmatter: null, content: markdown };
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
    return { frontmatter: null, content: markdown };
  }

  try {
    // Extract YAML content between delimiters
    const yamlContent = lines.slice(1, endIndex).join('\n');
    const parsed = parseYaml(yamlContent);

    if (typeof parsed !== 'object' || parsed === null) {
      return { frontmatter: null, content: markdown };
    }

    // Extract remaining content (after closing ---)
    const remaining = lines.slice(endIndex + 1).join('\n').trimStart();

    return { frontmatter: parsed as Record<string, unknown>, content: remaining };
  } catch {
    return { frontmatter: null, content: markdown };
  }
}
