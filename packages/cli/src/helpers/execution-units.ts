/**
 * Shared helpers for the currently executing step or substep.
 *
 * Centralizes execution-unit lookup so OUTPUTS behavior stays consistent
 * across manual transitions, auto-execution, and drained substep completions.
 *
 * @module helpers/execution-units
 */

import type { ResolvedStep, Substep } from '@rundown-org/core';
import { resolvedStepHasSubsteps } from '@rundown-org/parser';
import type { StepVariables } from '../services/execution-vars.js';

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
 * Merge template variables from the execution context and the post-transition state.
 *
 * The execution frame (`before`) is authoritative for OUTPUTS evaluation: it
 * carries FOR-loop iteration values, Step/Index frame, and INPUTS injection
 * that the persisted post-transition state cannot see. Post-transition state
 * (`after`) contributes only the keys that the execution frame did not carry
 * — e.g., CLI `--var` overrides on non-loop names. A caller passing
 * `--var item=stale` while a step iterates `FOR item IN {{items}}` must not
 * shadow the current iteration value.
 *
 * @param before - Template variables used while executing the current unit
 * @param after - Template variables from the post-transition persisted state
 * @returns Combined template variables, or undefined when neither side is present
 */
export function mergeExecutionTemplateVars(
  before: Readonly<StepVariables> | undefined,
  after: Readonly<StepVariables> | undefined,
): Readonly<StepVariables> | undefined {
  if (before && after) {
    return { ...after, ...before };
  }
  return after ?? before;
}

/**
 * Decide whether parent-step OUTPUTS should publish on a PASS transition.
 *
 * Decision matrix (parent has OUTPUTS in every row):
 *
 * | substep present | parent advanced | terminal action | publish? |
 * |-----------------|-----------------|-----------------|----------|
 * | no              | —               | —               | yes      |
 * | yes             | yes             | —               | yes      |
 * | yes             | no              | yes (STOP/COMPLETE) | yes  |
 * | yes             | no              | no              | no       |
 *
 * Pure: no I/O, no state. Allows the decision to be unit-tested directly
 * across the cross-product of inputs
 * (CONTINUE / DEFER / NEXT / BREAK / GOTO / COMPLETE / STOP × substep on/off ×
 * parent advanced on/off).
 *
 * @param args                       - Decision inputs
 * @param args.isSubstepContext      - True when the PASS originated from a substep, not the parent step itself
 * @param args.parentStepAdvanced    - True when the post-transition step id differs from the pre-transition id
 * @param args.isTerminalAction      - True for STOP / COMPLETE actions that exit the runbook from a substep
 * @param args.parentHasOutputs      - True when the parent step declares any OUTPUTS
 * @returns `true` when parent-step OUTPUTS should be persisted
 */
export function shouldPersistParentOutputs(args: {
  isSubstepContext: boolean;
  parentStepAdvanced: boolean;
  isTerminalAction: boolean;
  parentHasOutputs: boolean;
}): boolean {
  if (!args.parentHasOutputs) return false;
  if (!args.isSubstepContext) return true;
  return args.parentStepAdvanced || args.isTerminalAction;
}
