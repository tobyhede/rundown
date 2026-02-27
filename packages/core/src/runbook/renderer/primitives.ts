/**
 * Render a markdown heading.
 *
 * @param level - Heading level (e.g., 2 for ##, 3 for ###)
 * @param id - Identifier prefix (e.g., step or substep id)
 * @param description - Optional heading description text
 * @param separator - Separator inserted between id and description when present
 * @returns Markdown heading string
 * @throws {RangeError} If level is not an integer between 1 and 6
 */
export function renderHeading(
  level: number,
  id: string,
  description?: string,
  separator = ' ',
): string {
  if (!Number.isInteger(level) || level < 1 || level > 6) {
    throw new RangeError(`Heading level must be an integer 1–6, got ${String(level)}`);
  }
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
  let fenceLen = 3;
  const match = code.match(/`{3,}/g);
  if (match) {
    fenceLen = Math.max(fenceLen, ...match.map((m) => m.length)) + 1;
  }
  const fence = '`'.repeat(fenceLen);
  return `${fence}${lang ?? ''}\n${code}\n${fence}`;
}
