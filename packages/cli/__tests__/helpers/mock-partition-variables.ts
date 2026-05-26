import type { TemplateVarValue, VariableValue } from '@rundown-org/core';

interface MockPartitionOptions {
  readonly trustedArtifactKeys?: ReadonlySet<string>;
  readonly trustAllArtifactValues?: boolean;
}

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

export function partitionVariablesForTest(
  vars: Readonly<Record<string, unknown>>,
  options?: MockPartitionOptions,
): {
  readonly templateVars: Record<string, TemplateVarValue>;
  readonly runtimeVars: Record<string, VariableValue>;
} {
  const templateVars: Record<string, TemplateVarValue> = {};
  const runtimeVars: Record<string, VariableValue> = {};
  for (const [key, value] of Object.entries(vars)) {
    if (isArtifactValueShape(value)) {
      if (!options?.trustAllArtifactValues && !options?.trustedArtifactKeys?.has(key)) {
        throw new Error(
          `Artifact record input for "${key}" is not trusted. Pass an artifact URI so Rundown can resolve it.`,
        );
      }
      runtimeVars[key] = value as VariableValue;
    } else {
      templateVars[key] = value as TemplateVarValue;
    }
  }
  return { templateVars, runtimeVars };
}
