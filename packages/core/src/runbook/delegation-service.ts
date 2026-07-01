import { parseStepIdFromString, resolvedStepHasSubsteps } from '@rundown-org/parser';
import { Errors } from '../errors/factory.js';
import type { RundownError } from '../errors/rundown-error.js';
import { buildContextSnapshot } from './delegation-context.js';
import { generateDelegationToken, hashDelegationToken } from './delegation-token.js';
import type { DelegationTokenHash } from './delegation-token.js';
import { RunbookStateManager } from './state.js';
import { findSubstepState, type FrameKey } from './targeting.js';
import type {
  AncestorSnapshot,
  DelegationParentState,
  DelegationLinkage,
  RunbookState,
  ResolvedStep,
  StepDelegation,
  SubstepState,
  TemplateVarValue,
} from './types.js';
import { formatRunbookRef, type RunbookRef } from './runbook-ref.js';

/**
 * Pure read model describing whether a consumed delegation token has been closed.
 *
 * This model is intentionally derived only from persisted {@link RunbookState}
 * data. Callers outside core should use it instead of reconstructing delegation
 * closure rules from parent/child state.
 */
export type ConsumedDelegationClosureReadModel =
  | {
      /** Core proved the delegation no longer requires child closure. */
      readonly status: 'closed';
      /** Terminal condition that closed the delegation. */
      readonly reason: 'completed' | 'stopped' | 'cancelled';
      /** Convenience boolean for thin front ends that only need the policy decision. */
      readonly requiresClosure: false;
      /** Parent run that issued the delegation, when still present. */
      readonly parentRunId?: string;
      /** Claimed child run associated with the delegation, when present. */
      readonly childRunId?: string;
    }
  | {
      /** Core found a valid delegation that still needs explicit closure. */
      readonly status: 'requires_closure';
      /** Whether the delegation is unclaimed or claimed by an active child. */
      readonly reason: 'pending' | 'claimed_active';
      /** Convenience boolean for thin front ends that only need the policy decision. */
      readonly requiresClosure: true;
      /** Parent run that issued the delegation, when still present. */
      readonly parentRunId?: string;
      /** Claimed child run associated with the delegation, when present. */
      readonly childRunId?: string;
    }
  | {
      /** Core could not prove the delegation is closed from persisted state. */
      readonly status: 'unknown';
      /** Missing means no matching state exists; corrupt means state is internally inconsistent. */
      readonly reason: 'missing' | 'corrupt';
      /** Unknown state fails closed and requires explicit closure by callers. */
      readonly requiresClosure: true;
      /** Human-readable diagnostic for corrupt-state investigations. */
      readonly details?: string;
    };

type ParentDelegationMatch = {
  readonly state: RunbookState;
  readonly substep: SubstepState;
  readonly delegation: StepDelegation;
};

function isDelegationLinkage(linkage: RunbookState['parentLinkage']): linkage is DelegationLinkage {
  return linkage?.kind === 'delegation';
}

function findParentDelegationMatches(
  states: readonly RunbookState[],
  tokenHash: string,
): ParentDelegationMatch[] {
  return states.flatMap((state) =>
    (state.substepStates ?? []).flatMap((substep) => {
      const delegation = substep.delegation;
      return delegation?.tokenHash === tokenHash ? [{ state, substep, delegation }] : [];
    }),
  );
}

function findChildMatches(states: readonly RunbookState[], tokenHash: string): RunbookState[] {
  return states.filter(
    (state) =>
      isDelegationLinkage(state.parentLinkage) && state.parentLinkage.tokenHash === tokenHash,
  );
}

function childLinkageMatchesParent(parent: ParentDelegationMatch, child: RunbookState): boolean {
  const linkage = child.parentLinkage;
  return (
    isDelegationLinkage(linkage) &&
    linkage.parentRunId === parent.state.id &&
    linkage.parentStepId === parent.substep.id &&
    linkage.tokenHash === parent.delegation.tokenHash
  );
}

function activeChildModel(
  child: RunbookState,
  parentRunId?: string,
): ConsumedDelegationClosureReadModel {
  if (child.lifecycle === 'completed') {
    return {
      status: 'closed',
      reason: 'completed',
      requiresClosure: false,
      ...(parentRunId ? { parentRunId } : {}),
      childRunId: child.id,
    };
  }
  if (child.lifecycle === 'stopped') {
    return {
      status: 'closed',
      reason: 'stopped',
      requiresClosure: false,
      ...(parentRunId ? { parentRunId } : {}),
      childRunId: child.id,
    };
  }
  return {
    status: 'requires_closure',
    reason: 'claimed_active',
    requiresClosure: true,
    ...(parentRunId ? { parentRunId } : {}),
    childRunId: child.id,
  };
}

/**
 * Read closure status for a consumed delegation token hash from persisted states.
 *
 * The function performs no I/O and owns the canonical interpretation of
 * parent/child delegation closure. Corrupt or missing state returns an
 * `unknown` model with `requiresClosure: true`.
 *
 * @param states - Persisted runbook states to inspect
 * @param tokenHash - Canonical persisted delegation token hash
 * @returns Closure read model for the consumed delegation
 */
export function readConsumedDelegationClosure(
  states: readonly RunbookState[],
  tokenHash: string,
): ConsumedDelegationClosureReadModel {
  const parentMatches = findParentDelegationMatches(states, tokenHash);
  if (parentMatches.length > 1) {
    return {
      status: 'unknown',
      reason: 'corrupt',
      requiresClosure: true,
      details: 'Multiple parent delegations match token hash',
    };
  }

  const childMatches = findChildMatches(states, tokenHash);
  if (childMatches.length > 1) {
    return {
      status: 'unknown',
      reason: 'corrupt',
      requiresClosure: true,
      details: 'Multiple child runs match token hash',
    };
  }

  const parent = parentMatches.at(0);
  const child = childMatches.at(0);

  if (!parent) {
    if (!child) {
      return { status: 'unknown', reason: 'missing', requiresClosure: true };
    }
    return activeChildModel(child);
  }

  if (parent.delegation.cancelledAt !== null) {
    return {
      status: 'closed',
      reason: 'cancelled',
      requiresClosure: false,
      parentRunId: parent.state.id,
      ...(parent.delegation.childRunId ? { childRunId: parent.delegation.childRunId } : {}),
    };
  }

  if (!parent.delegation.childRunId) {
    return {
      status: 'requires_closure',
      reason: 'pending',
      requiresClosure: true,
      parentRunId: parent.state.id,
    };
  }

  const claimedChild = states.find((state) => state.id === parent.delegation.childRunId);
  if (!claimedChild) {
    return {
      status: 'unknown',
      reason: 'corrupt',
      requiresClosure: true,
      details: 'Claimed child run is missing',
    };
  }

  if (!childLinkageMatchesParent(parent, claimedChild)) {
    return {
      status: 'unknown',
      reason: 'corrupt',
      requiresClosure: true,
      details: 'Child parent linkage disagrees with parent delegation',
    };
  }

  if (childMatches.length === 1) {
    const child = childMatches[0];
    if (child.id !== claimedChild.id) {
      return {
        status: 'unknown',
        reason: 'corrupt',
        requiresClosure: true,
        details: 'Child token hash match disagrees with claimed child run',
      };
    }
  }

  return activeChildModel(claimedChild, parent.state.id);
}

/**
 * Read whether a consumed delegation token still requires explicit closure from persisted state.
 *
 * @param cwd - Project root containing `.rundown` state.
 * @param tokenHash - Hashed delegation token consumed by the plugin session hook.
 * @returns Closure read model for the consumed token.
 * @throws {Error} If reading persisted runbook state fails or returns invalid data.
 */
export async function readConsumedDelegationClosureForCwd(
  cwd: string,
  tokenHash: DelegationTokenHash,
): Promise<ConsumedDelegationClosureReadModel> {
  const manager = new RunbookStateManager(cwd);
  const states = await manager.list();
  return readConsumedDelegationClosure(states, tokenHash);
}

/**
 * Options for aborting a delegation.
 */
export interface AbortDelegationOptions {
  /** Current parent runbook state (loaded under lock). */
  readonly parentState: RunbookState;
  /** Substep ID that owns the delegation. */
  readonly substepId: string;
  /** Force cancel even if a child run has claimed the token. */
  readonly force?: boolean;
  /** Frame key scoping the lookup to a specific FOR iteration. */
  readonly frameKey: FrameKey;
}

/** Delegation was cancelled; caller must persist updated substep states. */
export interface AbortDelegationCancelledResult {
  readonly status: 'cancelled';
  /** Updated parent substep states containing the cancelled delegation timestamp. */
  readonly updatedSubstepStates: readonly SubstepState[];
}

/** Delegation was already cancelled; no state change required. */
export interface AbortDelegationAlreadyCancelledResult {
  readonly status: 'already_cancelled';
}

/** Delegation is claimed by a child run and requires `force` to cancel. */
export interface AbortDelegationNeedsForceResult {
  readonly status: 'needs_force';
  /** Child run currently holding the claimed delegation. */
  readonly childRunId: string;
}

/**
 * No delegation exists on the targeted substep.
 *
 * Wraps `Errors.delegationStepNotFound` (RD-801). Note: the same code is
 * also produced by `createDelegation` for parse/step-missing failures —
 * RD-801 is overloaded to cover both "step ID does not resolve" and
 * "no active delegation on the substep". Callers branching on
 * `error.code === 'RD-801'` should disambiguate via `status` (this
 * variant is reached only on the abort/retry primitives).
 */
export interface AbortDelegationNotFoundResult {
  readonly status: 'not_found';
  /** Substep ID the caller attempted to abort. */
  readonly substepId: string;
  /** Wrapped RundownError (RD-801) for callers that re-surface the message. */
  readonly error: RundownError;
}

/**
 * Possible outcomes when attempting to abort a delegation.
 */
export type AbortDelegationResult =
  | AbortDelegationCancelledResult
  | AbortDelegationAlreadyCancelledResult
  | AbortDelegationNeedsForceResult
  | AbortDelegationNotFoundResult;

/**
 * Options for creating a delegation.
 */
export interface DelegateOptions {
  /** Current parent runbook state (structural subset). */
  readonly state: DelegationParentState;
  /** Step (or substep) to delegate: "2" or "2.1". */
  readonly stepId: string;
  /** Path to the child runbook to delegate to. */
  readonly childRunbookPath: string;
  /** Canonical persisted identity of the child runbook. */
  readonly childRunbookRef: RunbookRef;
  /** Extra variables to merge into the context snapshot. */
  readonly extraVars?: Readonly<Record<string, TemplateVarValue>>;
  /** Ancestor chain built by the caller. */
  readonly ancestors?: readonly AncestorSnapshot[];
  /** Frame key scoping this delegation to a FOR iteration. */
  readonly frameKey: FrameKey;
}

/** Success variant: delegation created; caller must persist updatedSubstepStates. */
export interface CreateDelegationCreatedResult {
  readonly status: 'created';
  /** Plain-text token (to be given to the child agent). */
  readonly token: string;
  /** SHA-256 hash of the token (stored in state). */
  readonly tokenHash: string;
  /** The full delegation metadata. */
  readonly delegation: StepDelegation;
  /** Updated substep states array (caller persists this). */
  readonly updatedSubstepStates: readonly SubstepState[];
}

/** Step ID did not parse, or parsed step is missing from the resolved steps. */
export interface CreateDelegationStepNotFoundResult {
  readonly status: 'step_not_found';
  readonly step: string;
  readonly error: RundownError;
}

/** state.step !== parsed.step (step has advanced past the target). */
export interface CreateDelegationStepNotCurrentResult {
  readonly status: 'step_not_current';
  readonly step: string;
  readonly current: string;
  readonly error: RundownError;
}

/** Step has substeps but caller passed a bare step ID (no substep segment). */
export interface CreateDelegationSubstepRequiredResult {
  readonly status: 'substep_required';
  readonly step: string;
  /** Substep IDs available to target on this step. */
  readonly available: readonly string[];
  readonly error: RundownError;
}

/** Substep segment given but no matching substep on the target step. */
export interface CreateDelegationSubstepNotFoundResult {
  readonly status: 'substep_not_found';
  readonly substep: string;
  readonly step: string;
  readonly available: readonly string[];
  readonly error: RundownError;
}

/** Target substep exists but is not authored as a DELEGATE substep. */
export interface CreateDelegationNotDelegatableResult {
  readonly status: 'not_delegatable';
  readonly step: string;
  readonly error: RundownError;
}

/** An active (uncancelled, unclaimed) delegation already exists on the substep. */
export interface CreateDelegationExistsResult {
  readonly status: 'delegation_exists';
  /**
   * Caller-input `stepId` verbatim (e.g. `"1.1"` for a substep), not the
   * parsed step segment. This differs from {@link CreateDelegationStepNotFoundResult.step},
   * which holds the parsed step segment (e.g. `"99"` from input `"99.1"`).
   * The verbatim form is deliberate: the paired `error` is
   * `RD-804 delegationAlreadyExists(stepId, message)`, whose message echoes
   * what the operator typed and may include safe conflict metadata.
   */
  readonly step: string;
  /** Token hash for the active delegation; safe to display in conflict errors. */
  readonly existingTokenHash: string;
  /** Persisted runbook path for the active delegation. */
  readonly existingChildRunbookPath: string;
  /** Structured runbook identity for the active delegation. */
  readonly existingChildRunbookRef: RunbookRef;
  readonly error: RundownError;
}

/**
 * The active runbook is itself a claimed delegated child. Issuing further
 * delegations would violate the single-level delegation invariant
 * (Main -> Delegate -> Claim is the only chain; subagents may not spawn
 * subagents). Use `rd run` for runbook composition inside a claimed child.
 */
export interface CreateDelegationParentDelegatedResult {
  readonly status: 'parent_is_delegated';
  /** RunId of the parent delegation (the original delegating runbook). */
  readonly parentRunId: string;
  /** Wrapped RundownError (RD-819) for callers that re-surface the message. */
  readonly error: RundownError;
}

/**
 * Outcome of attempting to create a delegation.
 *
 * Discriminated on `status`. The `created` variant holds the token and
 * updated state; each error variant holds the same `RundownError` the
 * previous throw-based API raised, plus variant-specific context fields
 * for callers that branch structurally.
 */
export type CreateDelegationResult =
  | CreateDelegationCreatedResult
  | CreateDelegationStepNotFoundResult
  | CreateDelegationStepNotCurrentResult
  | CreateDelegationSubstepRequiredResult
  | CreateDelegationSubstepNotFoundResult
  | CreateDelegationNotDelegatableResult
  | CreateDelegationExistsResult
  | CreateDelegationParentDelegatedResult;

/**
 * Create a delegation for an authored DELEGATE substep of the current runbook.
 *
 * Deterministic validation and state update; no I/O; **never throws**.
 * Mints a fresh token and `createdAt` timestamp on the `created` variant,
 * so this is not referentially transparent across calls — repeated calls
 * with identical inputs produce Result values that differ on token and
 * timestamp fields.
 *
 * The caller persists the returned `updatedSubstepStates` via
 * `manager.update` after branching on the `status` discriminant. State is
 * unchanged on any error variant.
 *
 * Runs inside XState `assign` callbacks (via the auto-issuance loop in
 * `execution.ts`) so uncontrolled throws would corrupt actor state or
 * trigger XState's error boundary with unclear semantics.
 *
 * @param options - Delegation creation options
 * @param steps - Parsed steps from the active runbook
 * @returns Discriminated union: see {@link CreateDelegationResult}
 */
export function createDelegation(
  options: DelegateOptions,
  steps: readonly ResolvedStep[],
): CreateDelegationResult {
  const { state, stepId, childRunbookPath, childRunbookRef, extraVars, ancestors, frameKey } =
    options;

  // 0. Single-level delegation invariant: a claimed (delegated) child runbook
  //    may not issue further delegations. This guard runs before any other
  //    validation so it covers all three issuance paths uniformly: manual
  //    `rd delegate`, auto-fan-out on entry to a delegating step, and the
  //    retry-hook re-issuance path that flows through `retryDelegation`.
  if (state.parentLinkage?.kind === 'delegation') {
    return {
      status: 'parent_is_delegated',
      parentRunId: state.parentLinkage.parentRunId,
      error: Errors.delegationNestedForbidden(state.id),
    };
  }

  // 1. Parse step ID
  const parsed = parseStepIdFromString(stepId);
  if (!parsed) {
    return {
      status: 'step_not_found',
      step: stepId,
      error: Errors.delegationStepNotFound(stepId),
    };
  }

  // 2. Find step in parsed runbook
  const step = steps.find((s) => s.name === parsed.step);
  if (!step) {
    return {
      status: 'step_not_found',
      step: parsed.step,
      error: Errors.delegationStepNotFound(parsed.step),
    };
  }

  // 3. If step has substeps and no substep specified, require it
  if (resolvedStepHasSubsteps(step) && !parsed.substep) {
    const available = step.substeps.map((ss) => ss.id);
    return {
      status: 'substep_required',
      step: parsed.step,
      available,
      error: Errors.delegationSubstepRequired(parsed.step, available),
    };
  }

  // 3b. If substep specified, validate it exists in the step
  if (parsed.substep) {
    if (!resolvedStepHasSubsteps(step)) {
      return {
        status: 'substep_not_found',
        substep: parsed.substep,
        step: parsed.step,
        available: [],
        error: Errors.delegationSubstepNotFound(parsed.substep, parsed.step, []),
      };
    }
    const validIds = step.substeps.map((ss) => ss.id);
    if (!validIds.includes(parsed.substep)) {
      return {
        status: 'substep_not_found',
        substep: parsed.substep,
        step: parsed.step,
        available: validIds,
        error: Errors.delegationSubstepNotFound(parsed.substep, parsed.step, validIds),
      };
    }
  }

  // 3c. Three-level step ID (step.iteration.substep) requires a FOR-capable step
  if (typeof parsed.at === 'number' && step.kind !== 'for' && step.kind !== 'prompted-for') {
    return {
      status: 'step_not_found',
      step: stepId,
      error: Errors.delegationStepNotFound(stepId),
    };
  }

  // 4. Verify step is at frontier
  if (state.step !== parsed.step) {
    return {
      status: 'step_not_current',
      step: parsed.step,
      current: state.step,
      error: Errors.delegationStepNotCurrent(parsed.step, state.step),
    };
  }

  // 5. Determine the substep ID for delegation attachment
  if (!parsed.substep) {
    return {
      status: 'not_delegatable',
      step: stepId,
      error: Errors.delegationNoDelegatableSubstep(parsed.step),
    };
  }
  const substepId = parsed.substep;

  // 6. Delegation tokens may only be issued for authored DELEGATE substeps.
  const authoredSubstep = resolvedStepHasSubsteps(step)
    ? step.substeps.find((ss) => ss.id === parsed.substep)
    : undefined;
  if (authoredSubstep?.delegate !== true) {
    return {
      status: 'not_delegatable',
      step: stepId,
      error: Errors.delegationNoDelegatableSubstep(parsed.step),
    };
  }

  // 7. Check for existing active delegation on this substep (frame-scoped)
  const existingStates = state.substepStates ?? [];
  const targetSubstep = findSubstepState(existingStates, substepId, frameKey);

  const existingDelegation = targetSubstep?.delegation;
  if (existingDelegation?.cancelledAt === null && existingDelegation.childRunId === null) {
    const requestedRunbook = formatRunbookRef(childRunbookRef);
    const existingRunbook = formatRunbookRef(existingDelegation.childRunbookRef);
    const isDifferentRunbook = requestedRunbook !== existingRunbook;
    const message = isDifferentRunbook
      ? `in-flight delegation for a different runbook: requested ${requestedRunbook}, existing ${existingRunbook}, token hash ${existingDelegation.tokenHash}`
      : `in-flight delegation already exists for ${existingRunbook}, token hash ${existingDelegation.tokenHash}`;

    return {
      status: 'delegation_exists',
      step: stepId,
      existingTokenHash: existingDelegation.tokenHash,
      existingChildRunbookPath: existingDelegation.childRunbookPath,
      existingChildRunbookRef: existingDelegation.childRunbookRef,
      error: Errors.delegationAlreadyExists(stepId, message),
    };
  }

  // 8. Generate token and hash
  const token = generateDelegationToken();
  const tokenHash = hashDelegationToken(token);

  // 9. Build context snapshot
  const explicitIteration = typeof parsed.at === 'number' ? parsed.at : undefined;
  const contextSnapshot = buildContextSnapshot(state, parsed.substep, ancestors, {
    extraVars,
    iterationOverride: explicitIteration,
  });

  // 10. Create delegation object
  const delegation: StepDelegation = {
    token,
    tokenHash,
    childRunbookPath,
    childRunbookRef,
    contextSnapshot,
    childRunId: null,
    createdAt: new Date().toISOString(),
    cancelledAt: null,
    ...(extraVars ? { extraVars } : {}),
  };

  // 10. Produce updated substepStates (frame-scoped)
  let updatedSubstepStates: readonly SubstepState[];

  if (targetSubstep) {
    // Re-issuing over an existing entry (retry, or re-delegate after cancel) is a
    // fresh attempt: reset the mirrored status/result so a prior reported outcome
    // cannot leave the entry `done`. Mirrors the machine RETRY hook
    // (retry-hook.ts retrySingleSubstep) so manual and machine paths converge.
    updatedSubstepStates = existingStates.map((ss) =>
      ss === targetSubstep
        ? { ...ss, status: 'pending' as const, result: undefined, delegation }
        : ss,
    );
  } else {
    // Append new entry for this frame (new iteration or simple step)
    updatedSubstepStates = [
      ...existingStates,
      { id: substepId, frameKey, status: 'pending' as const, delegation },
    ];
  }

  return {
    status: 'created',
    token,
    tokenHash,
    delegation,
    updatedSubstepStates,
  };
}

/**
 * Abort a delegation on a substep.
 *
 * Deterministic validation and state update; no I/O; **never throws**.
 * Mints a `cancelledAt` timestamp on the `cancelled` variant, so this is
 * not referentially transparent across calls. The caller persists the
 * returned `updatedSubstepStates` into the runbook state (only on the
 * `cancelled` variant).
 *
 * @param options - Abort delegation options
 * @returns Discriminated union: see {@link AbortDelegationResult}
 */
export function abortDelegation(options: AbortDelegationOptions): AbortDelegationResult {
  const { parentState, substepId, force, frameKey } = options;

  // 1. Find substep (frame-scoped)
  const existingStates = parentState.substepStates ?? [];
  const targetSubstep = findSubstepState(existingStates, substepId, frameKey);

  if (!targetSubstep?.delegation) {
    return {
      status: 'not_found',
      substepId,
      error: Errors.delegationStepNotFound(substepId),
    };
  }

  const delegation = targetSubstep.delegation;

  // 2. Already cancelled → idempotent return
  if (delegation.cancelledAt !== null) {
    return { status: 'already_cancelled' };
  }

  // 3. Claimed but no --force → needs_force
  if (delegation.childRunId !== null && !force) {
    return { status: 'needs_force', childRunId: delegation.childRunId };
  }

  // 4. Set cancelledAt
  const updatedDelegation: StepDelegation = {
    ...delegation,
    token: undefined,
    cancelledAt: new Date().toISOString(),
  };

  const updatedSubstepStates = existingStates.map((ss) =>
    ss === targetSubstep ? { ...ss, delegation: updatedDelegation } : ss,
  );

  return { status: 'cancelled', updatedSubstepStates };
}

/**
 * Options for retrying a delegation.
 */
export interface RetryDelegationOptions {
  /** Current runbook state. */
  readonly state: RunbookState;
  /** Substep ID whose delegation will be retried. */
  readonly substepId: string;
  /** Frame key scoping the lookup to a specific FOR iteration. */
  readonly frameKey: FrameKey;
  /** Variables that override inherited extraVars; unspecified keys inherit verbatim. */
  readonly overrides?: Readonly<Record<string, TemplateVarValue>>;
  /**
   * Allow retry when the delegation still has a childRunId.
   *
   * Intended only for machine-owned retry hooks that run after child completion
   * has already been recorded into the parent. Manual CLI retry leaves this
   * false so linked child runs must go through abort --force teardown first.
   */
  readonly allowLinkedChildRun?: boolean;
}

/**
 * Substep had no delegation to retry.
 *
 * Mirrors {@link AbortDelegationNotFoundResult} — both variants carry a
 * pre-formatted `RundownError` (RD-801) so callers can choose between
 * structured code (e.g. CLI envelope) and formatted message without
 * re-synthesizing either.
 *
 * Note: RD-801 is also produced by `createDelegation` for parse /
 * step-missing failures. The code is overloaded across the three
 * primitives to cover both "step ID does not resolve" and "no active
 * delegation on the substep". Callers branching on
 * `error.code === 'RD-801'` should disambiguate via `status` (this
 * variant is reached only on the retry primitive).
 */
export interface RetryDelegationNotFoundResult {
  readonly status: 'not_found';
  /** Substep ID the caller attempted to retry. */
  readonly substepId: string;
  /** Wrapped RundownError (RD-801) for callers that re-surface the message. */
  readonly error: RundownError;
}

/**
 * State's current step is not the step that owns the delegation.
 *
 * Mirrors {@link CreateDelegationStepNotCurrentResult} — both variants
 * carry a pre-formatted `RundownError` so callers can choose between the
 * structured code (e.g. CLI envelope) and the formatted message without
 * re-synthesizing either.
 */
export interface RetryDelegationNotCurrentResult {
  readonly status: 'not_current';
  /** Step that owns the delegation. */
  readonly ownerStep: string;
  /** State's current step. */
  readonly currentStep: string;
  /** Wrapped RundownError (RD-802) for callers that re-surface the message. */
  readonly error: RundownError;
}

/**
 * `createDelegation` returned a non-`created` Result variant (path
 * unresolvable, substep removed, etc.); its `error` is propagated
 * verbatim into this `error` variant.
 *
 * Mirrors {@link CreateDelegationStepNotFoundResult} et al. — every
 * non-success Result variant carries an `error: RundownError`, so callers
 * have a single uniform shape to discriminate on across the three
 * delegation primitives.
 */
export interface RetryDelegationErrorResult {
  /** Discriminant: literal `'error'`. */
  readonly status: 'error';
  /** Wrapped RundownError describing why delegation failed. */
  readonly error: RundownError;
}

/**
 * Existing delegation has a linked child run.
 *
 * Retrying would replace the parent delegation record without stopping the
 * child run, releasing the claim tombstone, or recording a fail completion.
 * Callers must route through the force-abort flow before reissuing.
 */
export interface RetryDelegationInFlightResult {
  readonly status: 'in_flight';
  /** Linked child run that must be force-aborted before retry. */
  readonly childRunId: string;
  /** Wrapped RundownError (RD-823) for callers that re-surface the message. */
  readonly error: RundownError;
}

/**
 * Retry succeeded: the existing delegation has been force-cancelled and a
 * fresh one minted under a new token. The contract mirrors
 * {@link CreateDelegationCreatedResult} — every field a caller needs to
 * persist or surface to the operator is here.
 */
export interface RetryDelegationRetriedResult {
  readonly status: 'retried';
  /** Plain-text token (to be given to the child agent). */
  readonly token: string;
  /** SHA-256 hash of the token (stored in state). */
  readonly tokenHash: string;
  /** The full delegation metadata for the freshly-issued attempt. */
  readonly delegation: StepDelegation;
  /**
   * Full substep-state array reflecting the post-retry world. Callers must
   * persist this verbatim via `manager.update`; it is not a delta or a
   * partial update — it is the cumulative state with the cancelled
   * delegation flag set on the prior entry and the new delegation token
   * recorded on the targeted substep.
   */
  readonly updatedSubstepStates: readonly SubstepState[];
}

/**
 * Possible outcomes of a retry attempt.
 */
export type RetryDelegationResult =
  | RetryDelegationRetriedResult
  | RetryDelegationNotFoundResult
  | RetryDelegationNotCurrentResult
  | RetryDelegationInFlightResult
  | RetryDelegationErrorResult;

/**
 * Atomically cancel an existing delegation (force-style) and mint a replacement
 * using the same `childRunbookPath` and inherited (or overridden) `extraVars`.
 *
 * Deterministic validation and state update; no I/O; **never throws**.
 * Mints a fresh token, `createdAt`, and `cancelledAt` timestamp on the
 * `retried` variant, so this is not referentially transparent across calls.
 * Preconditions and inner `createDelegation` variants are translated into
 * the four outcomes in {@link RetryDelegationResult}; the `error` variant
 * wraps the `RundownError` produced by the inner `createDelegation`
 * (e.g. path unresolvable, substep removed) so callers have a single
 * uniform shape to discriminate on.
 *
 * The caller persists the returned `updatedSubstepStates` via
 * `manager.update`; state is unchanged on any non-retried variant.
 *
 * This is the canonical shape for delegation primitives consumed by XState
 * `assign` callbacks. `abortDelegation` and `createDelegation` also return
 * discriminated unions; the three primitives compose without try/catch.
 *
 * @param options - Retry options
 * @param steps - Parsed steps from the active runbook
 * @returns Discriminated union: see {@link RetryDelegationResult}
 */
export function retryDelegation(
  options: RetryDelegationOptions,
  steps: readonly ResolvedStep[],
): RetryDelegationResult {
  const { state, substepId, frameKey, overrides, allowLinkedChildRun = false } = options;

  // 1. Locate the existing delegation.
  const existingStates = state.substepStates ?? [];
  const targetSubstep = findSubstepState(existingStates, substepId, frameKey);
  const existingDelegation = targetSubstep?.delegation;
  if (!existingDelegation) {
    return {
      status: 'not_found',
      substepId,
      error: Errors.delegationStepNotFound(substepId),
    };
  }

  // 2. Verify step is at the execution frontier.
  //    `buildContextSnapshot` always records `contextSnapshot.step` for fresh
  //    delegations. A missing owner step here means the persisted snapshot
  //    predates that guarantee — reject rather than silently accepting
  //    `state.step`, which would degrade the currency check to always-true.
  const ownerStep = existingDelegation.contextSnapshot.step;
  if (ownerStep === undefined) {
    return { status: 'error', error: Errors.delegationSnapshotStale(substepId, state.step) };
  }
  if (state.step !== ownerStep) {
    return {
      status: 'not_current',
      ownerStep,
      currentStep: state.step,
      error: Errors.delegationStepNotCurrent(ownerStep, state.step),
    };
  }

  // 3. A linked, non-cancelled child run must be force-aborted before manual
  // retry. retryDelegation is a pure core primitive, so it cannot perform the
  // full abort --force teardown: delete/release child state, clear session
  // claim tombstones, and record fail completion. The retry hook opts out only
  // after the machine has already recorded child completion.
  if (
    existingDelegation.childRunId !== null &&
    existingDelegation.cancelledAt === null &&
    !allowLinkedChildRun
  ) {
    return {
      status: 'in_flight',
      childRunId: existingDelegation.childRunId,
      error: Errors.delegationInFlight(substepId, existingDelegation.childRunId),
    };
  }

  // 4. Compose inherited + override extraVars.
  const mergedExtraVars: Record<string, TemplateVarValue> | undefined =
    existingDelegation.extraVars || overrides
      ? { ...(existingDelegation.extraVars ?? {}), ...(overrides ?? {}) }
      : undefined;

  // 5. Force-cancel the existing delegation. Idempotent on already-cancelled.
  const abortResult = abortDelegation({
    parentState: state,
    substepId,
    force: true,
    frameKey,
  });
  let stateAfterAbort: RunbookState;
  switch (abortResult.status) {
    case 'cancelled':
      stateAfterAbort = { ...state, substepStates: abortResult.updatedSubstepStates };
      break;
    case 'already_cancelled':
      // Idempotent: state already reflects the cancellation.
      stateAfterAbort = state;
      break;
    case 'needs_force':
    case 'not_found': {
      // Unreachable in the current call graph: `force=true` rules out
      // `needs_force`, and the delegation existence is verified above
      // (rules out `not_found`). Surface as `error` so a future invariant
      // break does not silently proceed with stale state. `not_found`
      // carries `error`; `needs_force` does not, so synthesize one.
      // For `needs_force`, the only honest synthesis is "snapshot stale":
      // the variant is reached *because* the delegation exists and is
      // claimed, so RD-801 ("step not found") would be semantically wrong.
      const error =
        'error' in abortResult
          ? abortResult.error
          : Errors.delegationSnapshotStale(substepId, state.step);
      return { status: 'error', error };
    }
    default: {
      // Compile-time exhaustiveness guard — catches a future variant
      // addition without one of the cases above being updated. Returning
      // `_exhaustive` would surface as `undefined` at runtime and break
      // the "never throws / always returns a typed Result" contract, so
      // synthesize an `error` Result instead.
      const _exhaustive: never = abortResult;
      void _exhaustive;
      return {
        status: 'error',
        error: Errors.delegationInvariantViolated(
          `retryDelegation abortDelegation returned unhandled status for ${substepId}`,
        ),
      };
    }
  }

  // 6. Mint a fresh delegation. createDelegation returns a Result variant;
  //    translate any non-created outcome into this function's `error` variant
  //    so the state-machine caller has a single uniform shape to discriminate.
  //    Bare-step delegations are stored with substepState.id === step.name
  //    (see createDelegation step 5: `parsed.substep ?? parsed.step`), so the
  //    reconstructed stepId must NOT append the substep segment in that case.
  //    Disambiguate by checking whether the owning step has substeps.
  const ownerStepDefinition = steps.find((s) => s.name === state.step);
  const ownerHasSubsteps =
    ownerStepDefinition !== undefined && resolvedStepHasSubsteps(ownerStepDefinition);
  // Stale-state guard: the persisted delegation was created with a substep
  // target (`contextSnapshot.substep` is set), but the resolved runbook
  // now says the owner step has no substeps. Silently falling through to
  // the bare-step `stepIdForCreate` branch below would re-issue the
  // replacement token under the wrong persisted entry. Surface as error
  // so the operator can detect schema drift and restart cleanly. Per the
  // project's "never migrate persisted state" principle, the only safe
  // recovery is to complete or stop the running runbook and start fresh.
  const persistedSubstep = existingDelegation.contextSnapshot.substep;
  if (ownerStepDefinition !== undefined && !ownerHasSubsteps && persistedSubstep !== undefined) {
    return {
      status: 'error',
      error: Errors.delegationOwnerLostSubsteps(substepId, state.step),
    };
  }
  // Extract the FOR iteration from the frame key (format: "step|iteration",
  // see buildFrameKey). A FOR-scoped retry must pass a three-level
  // "${step}.${iteration}.${substep}" ID so parseStepIdFromString sets
  // `parsed.at` and deriveExecutionAt records the iteration on the
  // re-issued delegation. Falling back to two-level would emit e.g. "1.1"
  // where the canonical location is "1.2.1", losing the iteration context
  // on the retry.
  const frameIterationPart = frameKey.split('|')[1];
  const frameIteration =
    frameIterationPart && /^\d+$/.test(frameIterationPart) ? Number(frameIterationPart) : undefined;
  const stepIdForCreate = ownerHasSubsteps
    ? frameIteration !== undefined
      ? `${state.step}.${String(frameIteration)}.${substepId}`
      : `${state.step}.${substepId}`
    : state.step;
  const createResult: CreateDelegationResult = createDelegation(
    {
      state: stateAfterAbort,
      stepId: stepIdForCreate,
      childRunbookPath: existingDelegation.childRunbookPath,
      childRunbookRef: existingDelegation.childRunbookRef,
      ...(mergedExtraVars ? { extraVars: mergedExtraVars } : {}),
      ancestors: [],
      frameKey,
    },
    steps,
  );
  if (createResult.status !== 'created') {
    return { status: 'error', error: createResult.error };
  }

  return {
    status: 'retried',
    token: createResult.token,
    tokenHash: createResult.tokenHash,
    delegation: createResult.delegation,
    updatedSubstepStates: createResult.updatedSubstepStates,
  };
}
