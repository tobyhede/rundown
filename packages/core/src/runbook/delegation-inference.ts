/**
 * Pure delegation inference helpers.
 *
 * These helpers inspect parsed steps and persisted state data to determine
 * delegation targets. They perform no I/O and never persist state.
 *
 * @module
 */

import { hasRunbooks, parseStepIdFromString, resolvedStepHasSubsteps } from '@rundown-org/parser';
import type { ResolvedStep, Substep } from '@rundown-org/parser';

import { Errors } from '../errors/index.js';
import type { DelegateFrontierEntry } from '../events/types.js';
import type { ParentLinkage, RunId, SubstepState } from './types.js';
import type { RunbookRef } from './runbook-ref.js';
import { buildFrameKey, findSubstepState, type FrameKey } from './targeting.js';

/**
 * Structural state required by pure delegation inference.
 */
export interface DelegationInferenceState {
  /** Current run id, used for nested-delegation diagnostics. */
  readonly id: RunId;
  /** Current top-level step id. */
  readonly step: string;
  /** Current substep id, when the persisted state is positioned inside one. */
  readonly substep?: string;
  /** Persisted per-frame substep execution state. */
  readonly substepStates?: readonly SubstepState[];
  /** Active frame key for frame-scoped substep lookup. */
  readonly activeFrameKey?: FrameKey;
  /** Active frame entry counter. */
  readonly activeEntry?: number;
  /** Known frame entry counters by frame key. */
  readonly frameEntries?: Readonly<Record<FrameKey, number>>;
  /** Optional parent linkage for inline or delegated child runs. */
  readonly parentLinkage?: ParentLinkage;
}

/**
 * Result of delegation target inference.
 */
export interface InferredDelegation {
  /** Runbook reference from the substep's `runbooks` field. */
  readonly runbookRef: string;
  /** Qualified step id, for example `1.1`. */
  readonly stepId: string;
}

/**
 * Resolution of a bare `rd delegate` request against the current step.
 *
 * - `issuable` — a delegate substep has no active delegation; the caller should
 *   issue a fresh token via {@link createDelegation}.
 * - `already-issued` — every delegate substep already carries a pending
 *   (auto-issued) token; the caller should echo the existing frontier token
 *   rather than re-issue. Makes `rd delegate` idempotent on an auto-issued
 *   frontier instead of throwing RD-813.
 * - `none` — the current step has no delegatable substep at all (genuine
 *   RD-813 condition; the caller throws).
 */
export type DelegateTargetResolution =
  | { readonly kind: 'issuable'; readonly target: InferredDelegation }
  | {
      readonly kind: 'already-issued';
      readonly stepId: string;
      readonly token: string;
      readonly runbookRef: string;
    }
  | { readonly kind: 'none' };

/**
 * Resolved child runbook identity for delegation issuance.
 */
export interface ResolvedDelegationRunbook {
  /** Filesystem path passed to delegation creation as the child runbook path. */
  readonly path: string;
  /** Author-facing ref shown in delegate frontier entries. */
  readonly runbookRef: string;
  /** Canonical persisted child runbook reference. */
  readonly childRunbookRef: RunbookRef;
}

/**
 * Runtime resolver supplied by the front end that knows runbook discovery rules.
 *
 * The resolver MUST signal failure by resolving to `null`; it MUST NOT reject.
 * Callers (notably {@link delegationIssueActor}) wrap calls defensively, but
 * the contract keeps front-end-supplied resolvers compatible with the actor's
 * typed `failed` output.
 *
 * @param runbookRef - Runbook reference authored on the delegated substep.
 * @returns Resolved child runbook metadata, or `null` when the reference
 *   cannot be resolved.
 */
export type ResolveDelegationRunbook = (
  runbookRef: string,
) => Promise<ResolvedDelegationRunbook | null>;

/**
 * Check whether a substep has an active delegation in a frame.
 *
 * @param substepId - Substep id to check.
 * @param substepStates - Current substep states from persisted state.
 * @param frameKey - Frame key that scopes the lookup.
 * @returns True if the substep has a non-cancelled delegation.
 */
function hasActiveDelegation(
  substepId: string,
  substepStates: readonly SubstepState[] | undefined,
  frameKey: FrameKey,
): boolean {
  if (!substepStates) return false;
  const substepState = findSubstepState(substepStates, substepId, frameKey);
  return substepState?.delegation?.cancelledAt === null;
}

/**
 * Check whether a substep is marked done in a frame.
 *
 * @param substepId - Substep id to check.
 * @param substepStates - Current substep states from persisted state.
 * @param frameKey - Frame key that scopes the lookup.
 * @returns True if the substep status is `done`.
 */
function isSubstepDone(
  substepId: string,
  substepStates: readonly SubstepState[] | undefined,
  frameKey: FrameKey,
): boolean {
  if (!substepStates) return false;
  const substepState = findSubstepState(substepStates, substepId, frameKey);
  return substepState?.status === 'done';
}

/**
 * Infer the first manual delegation target from the current step.
 *
 * @param state - Current runbook state data.
 * @param steps - Parsed steps from the active runbook.
 * @returns The inferred delegation target.
 * @throws {RundownError} RD-813 if no suitable substep exists.
 */
export function inferDelegationTarget(
  state: DelegationInferenceState,
  steps: readonly ResolvedStep[],
): InferredDelegation {
  const currentStep = steps.find((step) => step.name === state.step);

  if (!currentStep || !resolvedStepHasSubsteps(currentStep)) {
    throw Errors.delegationNoDelegatableSubstep(state.step);
  }

  const activeFrameKey = state.activeFrameKey ?? buildFrameKey(state.step);

  for (const substep of currentStep.substeps) {
    if (!substep.delegate) continue;
    if (!hasRunbooks(substep)) {
      throw Errors.delegationSubstepNoRunbook(`${currentStep.name}.${substep.id}`, state.step);
    }
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
 * Resolve a bare `rd delegate` request, treating an auto-issued frontier as a
 * valid idempotent target rather than an RD-813 error.
 *
 * Prefers a fresh issuable substep (document order). Falls back to the first
 * substep that already has a pending delegation, surfacing its frontier token.
 *
 * @param state - Current runbook state data.
 * @param steps - Parsed steps from the active runbook.
 * @param frontier - The persisted delegate frontier (`state.delegateFrontier`).
 * @returns Discriminated resolution; never throws RD-813 (returns `none`).
 * @throws {RundownError} RD-814 if a delegate substep lacks a runbook reference.
 */
export function resolveDelegateTarget(
  state: DelegationInferenceState,
  steps: readonly ResolvedStep[],
  frontier: readonly DelegateFrontierEntry[] = [],
): DelegateTargetResolution {
  const currentStep = steps.find((step) => step.name === state.step);
  if (!currentStep || !resolvedStepHasSubsteps(currentStep)) {
    return { kind: 'none' };
  }

  const activeFrameKey = state.activeFrameKey ?? buildFrameKey(state.step);
  let alreadyIssued: DelegateTargetResolution | undefined;

  for (const substep of currentStep.substeps) {
    if (!substep.delegate) continue;
    if (!hasRunbooks(substep)) {
      throw Errors.delegationSubstepNoRunbook(`${currentStep.name}.${substep.id}`, state.step);
    }
    const stepId = `${currentStep.name}.${substep.id}`;
    if (isSubstepDone(substep.id, state.substepStates, activeFrameKey)) continue;

    if (hasActiveDelegation(substep.id, state.substepStates, activeFrameKey)) {
      if (!alreadyIssued) {
        const entry = frontier.find((candidate) => candidate.id === stepId);
        if (entry) {
          alreadyIssued = {
            kind: 'already-issued',
            stepId,
            token: entry.token,
            runbookRef: entry.runbook,
          };
        }
      }
      continue;
    }

    return { kind: 'issuable', target: { runbookRef: substep.runbooks[0], stepId } };
  }

  return alreadyIssued ?? { kind: 'none' };
}

/**
 * Infer the runbook reference from a specific substep.
 *
 * @param state - Current runbook state data.
 * @param steps - Parsed steps from the active runbook.
 * @param stepId - Qualified step id, for example `1.1`.
 * @returns The first runbook reference from the substep.
 * @throws {RundownError} RD-813 if the substep is not marked as delegatable.
 * @throws {RundownError} RD-814 if the substep has no runbook reference.
 */
export function inferRunbookFromStep(
  state: DelegationInferenceState,
  steps: readonly ResolvedStep[],
  stepId: string,
): string {
  const parsed = parseStepIdFromString(stepId);
  if (!parsed) {
    throw Errors.delegationSubstepNoRunbook(stepId, state.step);
  }

  const step = steps.find((candidate) => candidate.name === parsed.step);

  if (!step) {
    throw Errors.delegationStepNotFound(parsed.step);
  }

  if (!resolvedStepHasSubsteps(step) || !parsed.substep) {
    throw Errors.delegationNoDelegatableSubstep(state.step);
  }

  const substep = step.substeps.find((candidate: Substep) => candidate.id === parsed.substep);
  if (!substep) {
    throw Errors.delegationSubstepNoRunbook(stepId, state.step);
  }

  if (!substep.delegate) {
    throw Errors.delegationNoDelegatableSubstep(state.step);
  }
  if (!hasRunbooks(substep)) {
    throw Errors.delegationSubstepNoRunbook(stepId, state.step);
  }

  return substep.runbooks[0];
}

/**
 * Infer every eligible auto-delegated substep in the current active frame.
 *
 * @param state - Current runbook state data.
 * @param steps - Parsed steps from the active runbook.
 * @returns Inferred delegation targets in document order.
 * @throws {RundownError} RD-813 if the current step has no substeps.
 * @throws {RundownError} RD-814 if a delegated substep lacks a runbook ref.
 * @throws {RundownError} RD-817 if a delegated child attempts delegation fan-out.
 */
export function inferAllDelegateSubsteps(
  state: DelegationInferenceState,
  steps: readonly ResolvedStep[],
): InferredDelegation[] {
  if (state.parentLinkage?.kind === 'delegation') {
    throw Errors.delegationNestedForbidden(state.id);
  }

  const currentStep = steps.find((step) => step.name === state.step);

  if (!currentStep || !resolvedStepHasSubsteps(currentStep)) {
    throw Errors.delegationNoDelegatableSubstep(state.step);
  }

  const activeFrameKey = state.activeFrameKey ?? buildFrameKey(state.step);
  const results: InferredDelegation[] = [];

  for (const substep of currentStep.substeps) {
    if (!substep.delegate) continue;
    if (!hasRunbooks(substep)) {
      throw Errors.delegationSubstepNoRunbook(`${currentStep.name}.${substep.id}`, state.step);
    }
    if (hasActiveDelegation(substep.id, state.substepStates, activeFrameKey)) continue;
    if (isSubstepDone(substep.id, state.substepStates, activeFrameKey)) continue;

    results.push({
      runbookRef: substep.runbooks[0],
      stepId: `${currentStep.name}.${substep.id}`,
    });
  }

  return results;
}
