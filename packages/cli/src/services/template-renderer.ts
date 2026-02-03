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

// Register helper that preserves undefined variables as literal text
handlebars.registerHelper('helperMissing', function (...args: unknown[]) {
  // Last argument is the options object with the variable name
  const options = args[args.length - 1] as { name: string };
  return new handlebars.SafeString(`{{${options.name}}}`);
});

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
  // Compile with noEscape to preserve markdown characters
  const template = handlebars.compile(markdown, { noEscape: true });
  return template(variables);
}
