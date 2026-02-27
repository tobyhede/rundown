import type { ValidationDiagnostic } from '@rundown-org/parser';
import {
  isRuntimeReservedVariable,
  RUNTIME_RESERVED_VARIABLES,
} from '../services/variable-discovery.js';

/**
 * Validate frontmatter vars against runtime-reserved variable names.
 *
 * Returns error diagnostics for any vars that collide with reserved names
 * like `Step`, `Index`, or `Context` (case-insensitive).
 *
 * @param vars - The frontmatter `vars` object, or undefined if absent
 * @returns Array of validation diagnostics (errors only)
 */
export function validateFrontmatterVars(
  vars: Record<string, unknown> | undefined,
): ValidationDiagnostic[] {
  if (!vars) return [];
  const diagnostics: ValidationDiagnostic[] = [];
  for (const key of Object.keys(vars)) {
    if (isRuntimeReservedVariable(key)) {
      diagnostics.push({
        severity: 'error',
        message: `Frontmatter var "${key}" uses reserved runtime variable name. Reserved names (case-insensitive): ${[...RUNTIME_RESERVED_VARIABLES].join(', ')}`,
      });
    }
  }
  return diagnostics;
}
