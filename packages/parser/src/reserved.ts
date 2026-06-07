/**
 * Reserved template-variable names that cannot be used in user-declared
 * identifiers (frontmatter `vars` / `inputs` / `required`, step-level
 * INPUTS / OUTPUTS declarations, CLI `--input`).
 *
 * These names are owned by runtime context resolution. Allowing them to be
 * shadowed by user values would corrupt template rendering of `{{step}}`,
 * `{{index}}`, runtime identity values, and the entire `{{context.*}}`
 * namespace.
 *
 * Stored lowercased — comparison is case-insensitive (`Step`, `STEP`, and
 * `step` are equivalent).
 *
 * @module reserved
 */

/**
 * Canonical runtime identity built-ins that belong to each individual runbook
 * execution and must not be inherited from a parent delegation context.
 */
export const IDENTITY_OWNED_BUILTINS = ['RunId', 'RunbookRef'] as const;

const IDENTITY_OWNED_RESERVED_NAMES = IDENTITY_OWNED_BUILTINS.map((name) => name.toLowerCase());

/**
 * Canonical reserved set (lowercased). Re-exported by the CLI as
 * `RUNTIME_RESERVED_VARIABLES` to keep one source of truth across packages.
 */
export const RESERVED_TEMPLATE_NAMES: ReadonlySet<string> = new Set([
  'step',
  'index',
  'context',
  ...IDENTITY_OWNED_RESERVED_NAMES,
]);

/**
 * Comma-separated reserved-name list for diagnostics.
 *
 * @returns Human-readable list of runtime-reserved template names
 */
export function formatReservedTemplateNames(): string {
  return [...RESERVED_TEMPLATE_NAMES].join(', ');
}

/**
 * Check whether a name collides with a runtime-reserved template variable.
 *
 * Case-insensitive — `Context`, `RunId`, and `RUNBOOKREF` all return `true`.
 *
 * @param name - Identifier to test
 * @returns `true` if the identifier is reserved
 */
export function isReservedTemplateName(name: string): boolean {
  return RESERVED_TEMPLATE_NAMES.has(name.toLowerCase());
}

/**
 * Built-in template helper names reserved for core render helpers.
 *
 * Parser owns helper identity so validation and front-end packages can share
 * one name source without importing core render semantics. Core owns behavior.
 */
export const BUILTIN_TEMPLATE_HELPER_NAMES = ['artifact', 'path', 'validateSchema'] as const;

/** Union of built-in template helper names, derived from {@link BUILTIN_TEMPLATE_HELPER_NAMES}. */
export type BuiltinTemplateHelperName = (typeof BUILTIN_TEMPLATE_HELPER_NAMES)[number];

/**
 * Set view of {@link BUILTIN_TEMPLATE_HELPER_NAMES}.
 *
 * Case-sensitive: helper calls match literal helper spelling.
 */
export const BUILTIN_TEMPLATE_HELPER_NAME_SET: ReadonlySet<BuiltinTemplateHelperName> = new Set(
  BUILTIN_TEMPLATE_HELPER_NAMES,
);

/**
 * Test whether a name is reserved for a built-in template helper.
 *
 * @param name - Candidate helper name
 * @returns `true` when the name is one of the built-in template helpers
 */
export function isBuiltinTemplateHelperName(name: string): name is BuiltinTemplateHelperName {
  return BUILTIN_TEMPLATE_HELPER_NAME_SET.has(name as BuiltinTemplateHelperName);
}
