import { resolvedStepHasSubsteps } from '@rundown-org/parser';
import type { OutputDeclaration } from '@rundown-org/parser';
import { InvalidRunbookStateError } from './persisted-state-guards.js';
import type { ResolvedStep, Substep } from './types.js';

/**
 * Look up a step by name, refusing a cursor the parsed runbook does not define.
 *
 * A run's `step` column and its compiled steps are written together, so a miss
 * means the two have diverged — a corrupt cursor, or steps parsed from a
 * different document than the one the run was started against. Every caller
 * that resolves an execution unit needs the same refusal, so it lives beside
 * {@link resolveCurrentExecutionUnit} rather than being re-declared per module.
 *
 * The class is the contract, not the message. `rundown collect` wraps any
 * non-`InvalidRunbookStateError` rejection out of the entry seam as RD-833,
 * whose recovery is "fix the helper and re-delegate" — the wrong instruction for
 * a diverged cursor, which is corrupt persisted state and recoverable only by
 * prune or restart. Raising the typed refusal is what routes it onto the CLI's
 * existing RD-309 finish/stop/prune path instead.
 *
 * @param steps - Parsed steps for the run.
 * @param stepName - Step name from the run's cursor.
 * @param runId - The run whose cursor is being resolved, for the RD-309 defect.
 * @returns The matching step.
 * @throws {InvalidRunbookStateError} When no step carries that name.
 */
export function findStepOrThrow(
  steps: readonly ResolvedStep[],
  stepName: string,
  runId: string,
): ResolvedStep {
  const step = steps.find((candidate) => candidate.name === stepName);
  if (!step) {
    throw new InvalidRunbookStateError(`Step "${stepName}" not found`, {
      runId,
      reason: 'cursor_step_not_in_runbook',
    });
  }
  return step;
}

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
 * return the parent step's OUTPUTS. On a step that DEFINES substeps, a
 * `substepId` naming none of them yields no declarations rather than silently
 * falling back to the parent's — the parent's OUTPUTS belong to a different
 * channel path, so capturing them under a substep scope would misfile them.
 *
 * A `substepId` on a step that defines NO substeps is the other case, and it
 * DOES return the step's own OUTPUTS. That is not the misfiling above:
 * {@link resolveCurrentExecutionUnit} resolves the same cursor to the parent
 * step, so the unit being entered really is the step and its declarations are
 * the ones in scope.
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
