/**
 * Render a markdown heading.
 *
 * @param level - Heading level (e.g., 2 for ##, 3 for ###)
 * @param id - Identifier prefix (e.g., step or substep id)
 * @param description - Optional heading description text
 * @param separator - Separator inserted between id and description when present
 * @returns Markdown heading string
 */
export function renderHeading(
  level: number,
  id: string,
  description?: string,
  separator = ' ',
): string {
  const marker = '#'.repeat(level);
  const text = description?.trim();
  if (!text) return `${marker} ${id}`;
  return `${marker} ${id}${separator}${text}`;
}

/**
 * Render a fenced code block.
 *
 * @param code - Code content
 * @param lang - Optional language tag
 * @returns Markdown code fence string
 */
export function renderCodeFence(code: string, lang?: string): string {
  return `\`\`\`${lang ?? ''}\n${code}\n\`\`\``;
}
