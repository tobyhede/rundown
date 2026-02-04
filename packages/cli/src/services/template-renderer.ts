/**
 * Template rendering service for runbook variable interpolation.
 *
 * Uses Handlebars to render {{variable}} placeholders in markdown content.
 * Preserves markdown characters without HTML escaping.
 * Preserves undefined variables as literal {{variable}} in output.
 *
 * @module
 */

import Handlebars from 'handlebars';

// Create isolated instance to avoid polluting global Handlebars
const handlebars = Handlebars.create();

const TEMPLATE_VAR_REGEX = /{{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*}}/g;

/**
 * Render Handlebars variables in markdown content.
 *
 * Uses `noEscape: true` to preserve markdown characters (no HTML escaping).
 * Missing variables are preserved as literal {{variable}} in output.
 *
 * Note: This does NOT affect Rundown's dynamic step syntax `{N}` and `{n}`,
 * which use single braces and are handled separately by the parser.
 *
 * @param markdown - Raw markdown content with {{variable}} placeholders
 * @param variables - Key-value pairs for variable substitution
 * @returns Rendered markdown with variables replaced
 * @throws Error if markdown contains invalid Handlebars syntax (e.g., unclosed
 *         braces or malformed expressions) - thrown by Handlebars.compile()
 *
 * @example
 * ```typescript
 * const rendered = renderTemplate(
 *   '## 1. Run Tests\n\n```bash\n{{test_command}}\n```',
 *   { test_command: 'npm test' }
 * );
 * // Returns: '## 1. Run Tests\n\n```bash\nnpm test\n```'
 * ```
 */
export function renderTemplate(
  markdown: string,
  variables: Record<string, string>
): string {
  const placeholderEntries: { name: string; raw: string }[] = [];
  const withPlaceholders = markdown.replace(
    TEMPLATE_VAR_REGEX,
    (raw, name: string) => {
      const index = placeholderEntries.length;
      placeholderEntries.push({ name, raw });
      return `{{__rd_resolve__ ${index.toString()}}}`;
    }
  );

  // Resolve placeholders while preserving original spacing for undefined vars.
  handlebars.registerHelper('__rd_resolve__', (index: number) => {
    const entry = placeholderEntries.at(index);
    if (!entry) return '';
    const value = Object.prototype.hasOwnProperty.call(variables, entry.name)
      ? variables[entry.name]
      : undefined;
    if (value === undefined) {
      return new handlebars.SafeString(entry.raw);
    }
    return value;
  });

  // Compile with noEscape to preserve markdown characters
  const template = handlebars.compile(withPlaceholders, { noEscape: true });
  return template(variables);
}
