/**
 * Reserved template-variable names that cannot be used in user-declared
 * identifiers (frontmatter `vars` / `inputs` / `required`, step-level
 * INPUTS / OUTPUTS declarations, CLI `--var`).
 *
 * These names are owned by runtime context resolution. Allowing them to be
 * shadowed by user values would corrupt template rendering of `{{step}}`,
 * `{{index}}`, and the entire `{{context.*}}` namespace.
 *
 * Stored lowercased — comparison is case-insensitive (`Step`, `STEP`, and
 * `step` are equivalent).
 *
 * @module reserved
 */

/**
 * Canonical reserved set (lowercased). Re-exported by the CLI as
 * `RUNTIME_RESERVED_VARIABLES` to keep one source of truth across packages.
 */
export const RESERVED_TEMPLATE_NAMES: ReadonlySet<string> = new Set(['step', 'index', 'context']);

/**
 * Check whether a name collides with a runtime-reserved template variable.
 *
 * Case-insensitive — `Context`, `CONTEXT`, and `context` all return `true`.
 *
 * @param name - Identifier to test
 * @returns `true` if the identifier is reserved
 */
export function isReservedTemplateName(name: string): boolean {
  return RESERVED_TEMPLATE_NAMES.has(name.toLowerCase());
}
