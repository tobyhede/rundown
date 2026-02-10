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
 * Note: Single-brace syntax like {varName} is not affected by template rendering.
 * Only double-brace Handlebars syntax {{varName}} is expanded.
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
  // Re-register helper on each call - intentional, as it needs closure access to
  // placeholderEntries and variables which differ per invocation.
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

/**
 * Expand loop variables in text using simple regex substitution.
 *
 * Phase 2 of variable expansion: per-iteration loop variables (regex).
 * Phase 1 (Handlebars via renderTemplate) runs once at rd-run startup.
 *
 * Unlike {@link renderTemplate} which uses Handlebars for full template processing,
 * this function performs lightweight per-iteration variable expansion for FOR loops.
 * Unmatched variables are preserved as literal `{{name}}` text.
 *
 * @param text - Text containing `{{variable}}` placeholders
 * @param variables - Key-value pairs for substitution (e.g., `{ batch: "2", Index: "2" }`)
 * @returns Text with matched variables replaced
 */
export function expandLoopVariables(
  text: string,
  variables: Record<string, string>
): string {
  return text.replace(TEMPLATE_VAR_REGEX, (match, name: string) => {
    return Object.prototype.hasOwnProperty.call(variables, name)
      ? variables[name]
      : match;
  });
}
