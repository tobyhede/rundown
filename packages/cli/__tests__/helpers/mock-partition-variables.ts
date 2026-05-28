import {
  isTrustedArtifactValue,
  type TemplateVarValue,
  type VariableValue,
} from '@rundown-org/core';

function hasArtifactKind(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    ((value as { readonly kind?: unknown }).kind === 'artifact-record' ||
      (value as { readonly kind?: unknown }).kind === 'file-artifact-record')
  );
}

function isArtifactValueShape(value: unknown): boolean {
  return (
    hasArtifactKind(value) ||
    (Array.isArray(value) && value.length > 0 && value.every(hasArtifactKind))
  );
}

/**
 * Test-only standalone partitioner mirroring the production `partitionVariables`.
 *
 * Used by CLI tests that mock `@rundown-org/core` and therefore cannot call
 * the real function. Trust is checked via the structural
 * {@link isTrustedArtifactValue} brand guard.
 *
 * @param vars - Mixed variable map to split into template and runtime buckets
 * @returns Template-safe values and runtime artifact values
 * @throws {Error} When a variable contains an untrusted artifact-shaped value
 */
export function partitionVariablesForTest(vars: Readonly<Record<string, unknown>>): {
  readonly templateVars: Record<string, TemplateVarValue>;
  readonly runtimeVars: Record<string, VariableValue>;
} {
  const templateVars: Record<string, TemplateVarValue> = {};
  const runtimeVars: Record<string, VariableValue> = {};
  for (const [key, value] of Object.entries(vars)) {
    if (isTrustedArtifactValue(value)) {
      runtimeVars[key] = value;
      continue;
    }
    if (isArtifactValueShape(value)) {
      throw new Error(
        `Artifact record input for "${key}" is not trusted. Pass an artifact URI so Rundown can resolve it.`,
      );
    }
    templateVars[key] = value as TemplateVarValue;
  }
  return { templateVars, runtimeVars };
}
