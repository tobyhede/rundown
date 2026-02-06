/**
 * Frontmatter parsing utilities for gate modules.
 */

/**
 * Parse runbook field from YAML frontmatter.
 *
 * Extracts the `runbook:` field value from a YAML frontmatter block
 * at the start of a file. Supports both LF and CRLF line endings.
 *
 * @param content - The file content containing YAML frontmatter
 * @returns The runbook path if found, undefined otherwise
 *
 * @example
 * ```typescript
 * const content = '---\nrunbook: my-runbook.md\n---\n# Content';
 * parseRunbookFromFrontmatter(content); // 'my-runbook.md'
 * ```
 */
export function parseRunbookFromFrontmatter(content: string): string | undefined {
  // Match YAML frontmatter block (supports both LF and CRLF line endings)
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return undefined;

  // Extract runbook field from frontmatter
  const runbookMatch = /^runbook:\s*(.+)$/m.exec(match[1]);
  return runbookMatch?.[1];
}
