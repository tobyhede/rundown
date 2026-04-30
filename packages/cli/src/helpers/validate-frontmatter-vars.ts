import type { OutputDeclaration, ValidationDiagnostic } from '@rundown-org/parser';
import {
  isRuntimeReservedVariable,
  RUNTIME_RESERVED_VARIABLES,
} from '../services/variable-discovery.js';

/**
 * Validate frontmatter `outputs` field against reserved names.
 *
 * Returns error diagnostics for:
 * - Duplicate output names within the outputs array
 * - Reserved runtime names (step, index, context — case-insensitive)
 *
 * @param outputs - Parsed output declarations from frontmatter, or undefined if absent
 * @returns Array of validation diagnostics (errors only)
 */
export function validateOutputsDeclarations(
  outputs: OutputDeclaration[] | undefined,
): ValidationDiagnostic[] {
  if (!outputs || outputs.length === 0) return [];

  const diagnostics: ValidationDiagnostic[] = [];
  const seen = new Set<string>();

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
