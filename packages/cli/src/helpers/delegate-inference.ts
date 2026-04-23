/**
 * Inference helpers for `rd delegate` when runbook or step is omitted.
 *
 * Pure functions that inspect parsed steps and persisted state to determine
 * the delegation target without requiring the user to specify it explicitly.
 *
 * @module
 */

import type { Substep, ResolvedStep } from '@rundown-org/parser';
import { resolvedStepHasSubsteps, hasRunbooks } from '@rundown-org/parser';
import type { RunbookState, SubstepState } from '@rundown-org/core';
import { Errors, findSubstepState, deriveActiveFrame, type FrameKey } from '@rundown-org/core';
import { parseStepIdFromString } from '@rundown-org/parser';

/**
 * Result of delegation target inference.
 */
export interface InferredDelegation {
  /** Runbook reference from the substep's `runbooks` field */
  readonly runbookRef: string;
  /** Qualified step ID (e.g., "1.1") */
  readonly stepId: string;
}

/**
 * Check whether a substep has an active (non-cancelled) delegation.
 *
 * @param substepId - The substep ID to check
 * @param substepStates - Current substep states from persisted state
 * @param frameKey - Frame key to scope the lookup
 * @returns True if the substep has a delegation with `cancelledAt === null`
 */
function hasActiveDelegation(
  substepId: string,
  substepStates: readonly SubstepState[] | undefined,
  frameKey: FrameKey,
): boolean {
  if (!substepStates) return false;
  const ss = findSubstepState(substepStates, substepId, frameKey);
  return ss?.delegation?.cancelledAt === null;
}

/**
 * Infer both the delegation target substep and its runbook reference.
 *
 * Finds the current step in `steps`, then iterates its substeps in order,
 * returning the first that has a `runbooks` field, is not already actively
 * delegated, and is not done.
 *
 * @param state - Current runbook state (provides `state.step` and `state.substepStates`)
 * @param steps - Parsed steps from the runbook
 * @returns The inferred delegation target (runbook ref and qualified step ID)
 * @throws {RundownError} RD-813 if no suitable substep is found
 */
export function inferDelegationTarget(
  state: RunbookState,
  steps: readonly ResolvedStep[],
): InferredDelegation {
  const currentStep = steps.find((s) => s.name === state.step);

  if (!currentStep || !resolvedStepHasSubsteps(currentStep)) {
    throw Errors.delegationNoDelegatableSubstep(state.step);
  }

  const activeFrameKey = state.activeFrameKey ?? deriveActiveFrame(state).frameKey;

  for (const substep of currentStep.substeps) {
    if (!hasRunbooks(substep)) continue;
    if (hasActiveDelegation(substep.id, state.substepStates, activeFrameKey)) continue;
    if (isSubstepDone(substep.id, state.substepStates, activeFrameKey)) continue;

    return {
      runbookRef: substep.runbooks[0],
      stepId: `${currentStep.name}.${substep.id}`,
    };
  }

  throw Errors.delegationNoDelegatableSubstep(state.step);
}

/**
 * Infer the runbook reference from a specific substep's `runbooks` field.
 *
 * @param state - Current runbook state
 * @param steps - Parsed steps from the runbook
 * @param stepId - Qualified step ID (e.g., "1.1")
 * @returns The first runbook reference from the substep
 * @throws {RundownError} RD-814 if the substep has no runbook reference
 */
export function inferRunbookFromStep(
  state: RunbookState,
  steps: readonly ResolvedStep[],
  stepId: string,
): string {
  const parsed = parseStepIdFromString(stepId);
  if (!parsed) {
    throw Errors.delegationSubstepNoRunbook(stepId, state.step);
  }

  const step = steps.find((s) => s.name === parsed.step);

  if (!step || !resolvedStepHasSubsteps(step) || !parsed.substep) {
    throw Errors.delegationSubstepNoRunbook(stepId, state.step);
  }

  const substep = step.substeps.find((ss: Substep) => ss.id === parsed.substep);
  if (!substep || !hasRunbooks(substep)) {
    throw Errors.delegationSubstepNoRunbook(stepId, state.step);
  }

  return substep.runbooks[0];
}

/**
 * Infer all delegation targets for fan-out when substeps carry `delegate: true`.
 *
 * Returns every substep in the current step that has `delegate: true`, has a runbook
 * reference, is not already actively delegated, and is not done.
 *
 * @param state - Current runbook state
 * @param steps - Parsed steps from the runbook
 * @returns Array of inferred delegation targets (may be empty if all are done/delegated)
 * @throws {RundownError} RD-813 if the current step has no substeps
 */
export function inferAllDelegateSubsteps(
  state: RunbookState,
  steps: readonly ResolvedStep[],
): InferredDelegation[] {
  const currentStep = steps.find((s) => s.name === state.step);

  if (!currentStep || !resolvedStepHasSubsteps(currentStep)) {
    throw Errors.delegationNoDelegatableSubstep(state.step);
  }

  const activeFrameKey = state.activeFrameKey ?? deriveActiveFrame(state).frameKey;
  const results: InferredDelegation[] = [];

  for (const substep of currentStep.substeps) {
    if (!substep.delegate) continue;
    if (!hasRunbooks(substep)) continue;
    if (hasActiveDelegation(substep.id, state.substepStates, activeFrameKey)) continue;
    if (isSubstepDone(substep.id, state.substepStates, activeFrameKey)) continue;

    results.push({
      runbookRef: substep.runbooks[0],
      stepId: `${currentStep.name}.${substep.id}`,
    });
  }

  return results;
}

/**
 * Check whether a substep is marked as done in the persisted state.
 * @param substepId - The substep ID to check
 * @param substepStates - Current substep states from persisted state
 * @param frameKey - Frame key to scope the lookup
 * @returns True if the substep has status 'done'
 */
function isSubstepDone(
  substepId: string,
  substepStates: readonly SubstepState[] | undefined,
  frameKey: FrameKey,
): boolean {
  if (!substepStates) return false;
  const ss = findSubstepState(substepStates, substepId, frameKey);
  return ss?.status === 'done';
}
