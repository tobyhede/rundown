import type { ResolvedStep, Substep } from '@rundown-org/core';
import { resolvedStepHasSubsteps } from '@rundown-org/parser';

/**
 * Resolve the currently executing unit for the active cursor.
 *
 * Falls back to the parent step if the state references a substep that is not
 * present on the current step definition.
 *
 * @param currentStep - The active top-level step
 * @param substepId - Optional active substep identifier from state
 * @returns The active substep when present, otherwise the parent step
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
