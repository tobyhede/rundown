/**
 * Shared helpers for the currently executing step or substep.
 *
 * Centralizes execution-unit lookup so INPUTS/OUTPUTS behavior stays consistent
 * across manual transitions, auto-execution, and drained substep completions.
 *
 * @module helpers/execution-units
 */

import type { ActionType, ResolvedStep, Substep, TemplateVarValue } from '@rundown-org/core';
import { resolvedStepHasSubsteps } from '@rundown-org/parser';
import { storeStepOutputs } from './step-outputs.js';

/** A runtime execution unit — either a top-level step or the active substep. */
export type ExecutionUnit = ResolvedStep | Substep;

/**
 * Narrow an {@link ExecutionUnit} to a {@link Substep}.
 *
 * Discriminates on the `kind` field: only step variants carry `kind`, so its
 * absence uniquely identifies a substep. Preferred over ad-hoc `'id' in unit`
 * duck-typing at call sites.
 *
 * @param unit - The execution unit to test
 * @returns `true` when `unit` is a {@link Substep}
 */
export function isSubstep(unit: ExecutionUnit): unit is Substep {
  return !('kind' in unit);
}

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
): ExecutionUnit {
  if (!substepId || !resolvedStepHasSubsteps(currentStep)) {
    return currentStep;
  }
  return currentStep.substeps.find((substep) => substep.id === substepId) ?? currentStep;
}

/**
 * Collect the INPUTS declarations that apply to the current execution unit.
 *
 * Parent step INPUTS are inherited by substeps. Substep-local INPUTS augment
 * rather than replace the inherited set, and duplicate names are removed.
 *
 * @param currentStep - The active top-level step
 * @param substepId - Optional active substep identifier from state
 * @returns Ordered, deduplicated input names for the current execution unit
 */
export function collectExecutionUnitInputs(
  currentStep: ResolvedStep,
  substepId: string | undefined,
): readonly string[] {
  const parentInputs = currentStep.inputs ?? [];
  if (!substepId || !resolvedStepHasSubsteps(currentStep)) {
    return parentInputs;
  }

  const substep = currentStep.substeps.find((candidate) => candidate.id === substepId);
  if (!substep?.inputs?.length) {
    return parentInputs;
  }

  return [...new Set([...parentInputs, ...substep.inputs])];
}

/**
 * Merge template variables from the execution context and the post-transition state.
 *
 * The runtime may inject INPUTS into the in-memory execution state without
 * persisting them. Merging here preserves those injected values for OUTPUTS
 * evaluation while still letting post-transition actor state override shared keys.
 *
 * @param before - Template variables used while executing the current unit
 * @param after - Template variables from the post-transition persisted state
 * @returns Combined template variables, or undefined when neither side is present
 */
export function mergeExecutionTemplateVars(
  before: Readonly<Record<string, TemplateVarValue>> | undefined,
  after: Readonly<Record<string, TemplateVarValue>> | undefined,
): Readonly<Record<string, TemplateVarValue>> | undefined {
  if (before && after) {
    return { ...before, ...after };
  }
  return after ?? before;
}

/**
 * Persist OUTPUTS declarations for a PASS transition.
 *
 * Substep OUTPUTS publish immediately when that substep passes. Parent-step
 * OUTPUTS only publish when the parent step itself advances or a terminal PASS
 * action fires without step advancement.
 *
 * @param args - PASS transition context
 * @param args.cwd - Project root directory
 * @param args.currentStep - Active parent step before the transition
 * @param args.currentSubstepId - Active substep identifier before the transition
 * @param args.previousStepId - Step identifier before the PASS was applied
 * @param args.updatedStepId - Step identifier after the PASS was applied
 * @param args.actionType - Parsed action produced by the PASS transition
 * @param args.templateVarsBefore - Execution-time template variables
 * @param args.templateVarsAfter - Post-transition persisted template variables
 */
export async function persistPassOutputs({
  cwd,
  currentStep,
  currentSubstepId,
  previousStepId,
  updatedStepId,
  actionType,
  templateVarsBefore,
  templateVarsAfter,
}: {
  cwd: string;
  currentStep: ResolvedStep;
  currentSubstepId: string | undefined;
  previousStepId: string;
  updatedStepId: string;
  actionType: ActionType;
  templateVarsBefore: Readonly<Record<string, TemplateVarValue>> | undefined;
  templateVarsAfter: Readonly<Record<string, TemplateVarValue>> | undefined;
}): Promise<void> {
  const templateVars = mergeExecutionTemplateVars(templateVarsBefore, templateVarsAfter);
  const executionUnit = resolveCurrentExecutionUnit(currentStep, currentSubstepId);

  if (isSubstep(executionUnit) && executionUnit.outputs?.length) {
    await storeStepOutputs(executionUnit.outputs, templateVars, cwd);
  }

  const isSubstepContext = currentSubstepId !== undefined;
  const parentStepAdvanced = updatedStepId !== previousStepId;
  const isTerminalAction = actionType === 'COMPLETE' || actionType === 'STOP';
  const shouldStoreParentOutputs =
    currentStep.outputs?.length && (!isSubstepContext || parentStepAdvanced || isTerminalAction);

  if (shouldStoreParentOutputs) {
    await storeStepOutputs(currentStep.outputs, templateVars, cwd);
  }
}
