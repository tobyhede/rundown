import { resolvedStepHasSubsteps } from '@rundown-org/parser';
import type { OutputDeclaration } from '@rundown-org/parser';
import type { ResolvedStep, Substep } from './types.js';

/**
 * Resolve the currently executing unit for the active runbook cursor.
 *
 * Falls back to the parent step if the state references a substep that is not
 * present on the current step definition.
 *
 * @param currentStep - Active top-level step
 * @param substepId - Optional active substep id from persisted state
 * @returns Matching substep when present, otherwise the parent step
 */
export function resolveCurrentExecutionUnit(
  currentStep: ResolvedStep,
  substepId: string | undefined,
): ResolvedStep | Substep {
  if (!substepId || !resolvedStepHasSubsteps(currentStep)) {
    return currentStep;
  }
  return currentStep.substeps.find((substep) => substep.id === substepId) ?? currentStep;
}

/**
 * Extract the OUTPUTS declarations attached to one execution unit.
 *
 * For a substep, return the substep's OUTPUTS; for a step-level command,
 * return the parent step's OUTPUTS. A `substepId` that names no substep on
 * `currentStep` yields no declarations rather than silently falling back to
 * the parent's — the parent's OUTPUTS belong to a different channel path, so
 * capturing them under a substep scope would misfile them.
 *
 * @param currentStep - The resolved parent step
 * @param substepId - Substep identifier, or undefined for a step-level unit
 * @returns Output declarations for the unit, or an empty list
 */
export function extractUnitOutputs(
  currentStep: ResolvedStep,
  substepId: string | undefined,
): readonly OutputDeclaration[] {
  if (substepId !== undefined && resolvedStepHasSubsteps(currentStep)) {
    return currentStep.substeps.find((s) => s.id === substepId)?.outputs ?? [];
  }
  return currentStep.outputs ?? [];
}
