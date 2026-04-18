import type { OutputDeclaration, ValidationDiagnostic } from '@rundown-org/parser';
import {
  isRuntimeReservedVariable,
  isValidVariableName,
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
  vars: Record<string, string | number | boolean> | undefined,
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

/**
 * Validate frontmatter `required` field against vars and reserved names.
 *
 * Returns error diagnostics for:
 * - Names appearing in both `required` and `vars` (required vars must not have defaults)
 * - Reserved runtime names (step, index, context — case-insensitive)
 * - Invalid variable identifiers
 *
 * @param required - The frontmatter `required` array, or undefined if absent
 * @param vars - The frontmatter `vars` object, or undefined if absent
 * @returns Array of validation diagnostics (errors only)
 */
export function validateRequiredVars(
  required: string[] | undefined,
  vars: Record<string, string | number | boolean> | undefined,
): ValidationDiagnostic[] {
  if (!required || required.length === 0) return [];
  const diagnostics: ValidationDiagnostic[] = [];
  const varsKeys = new Set(Object.keys(vars ?? {}));
  const seen = new Set<string>();

  for (const name of required) {
    if (seen.has(name)) {
      diagnostics.push({
        severity: 'error',
        message: `Duplicate entry "${name}" in "required" — each variable should be listed once`,
      });
      continue;
    }
    seen.add(name);
    if (!isValidVariableName(name)) {
      diagnostics.push({
        severity: 'error',
        message: `Required variable "${name}" is not a valid identifier`,
      });
      continue;
    }
    if (isRuntimeReservedVariable(name)) {
      diagnostics.push({
        severity: 'error',
        message: `Required variable "${name}" uses reserved runtime variable name. Reserved names (case-insensitive): ${[...RUNTIME_RESERVED_VARIABLES].join(', ')}`,
      });
    }
    if (varsKeys.has(name)) {
      diagnostics.push({
        severity: 'error',
        message: `Variable "${name}" cannot be both in "required" and "vars" — required variables must not have defaults`,
      });
    }
  }
  return diagnostics;
}

/**
 * Validate frontmatter `outputs` field against reserved names.
 *
 * Returns error diagnostics for:
 * - Duplicate output names within the outputs array
 * - Reserved runtime names (step, index, context — case-insensitive)
 *
 * @param outputs - Parsed output declarations from frontmatter, or undefined if absent
 * @param vars - The frontmatter `vars` object, or undefined if absent
 * @returns Array of validation diagnostics (errors only)
 */
export function validateOutputsDeclarations(
  outputs: OutputDeclaration[] | undefined,
  vars?: Record<string, string | number | boolean>,
): ValidationDiagnostic[] {
  if (!outputs || outputs.length === 0) return [];

  const diagnostics: ValidationDiagnostic[] = [];
  const seen = new Set<string>();
  const varsKeys = new Set(Object.keys(vars ?? {}));

  for (const output of outputs) {
    if (seen.has(output.name)) {
      diagnostics.push({
        severity: 'error',
        message: `Duplicate entry "${output.name}" in "outputs" — each output name should be listed once`,
      });
      continue;
    }
    seen.add(output.name);

    if (isRuntimeReservedVariable(output.name)) {
      diagnostics.push({
        severity: 'error',
        message: `Output variable "${output.name}" uses reserved runtime variable name. Reserved names (case-insensitive): ${[...RUNTIME_RESERVED_VARIABLES].join(', ')}`,
      });
    }
  }
  return diagnostics;
}
