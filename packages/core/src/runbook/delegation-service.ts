import { parseStepIdFromString, resolvedStepHasSubsteps } from '@rundown-org/parser';
import { Errors } from '../errors/factory.js';
import { RundownError } from '../errors/rundown-error.js';
import { buildContextSnapshot } from './delegation-context.js';
import { generateDelegationToken, hashDelegationToken } from './delegation-token.js';
import { findSubstepState, type FrameKey } from './targeting.js';
import type {
  AncestorSnapshot,
  RunbookState,
  ResolvedStep,
  StepDelegation,
  SubstepState,
  TemplateVarValue,
} from './types.js';

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
interface AbortDelegationCancelledResult {
  readonly status: 'cancelled';
  /** Updated parent substep states containing the cancelled delegation timestamp. */
  readonly updatedSubstepStates: readonly SubstepState[];
}

/** Delegation was already cancelled; no state change required. */
interface AbortDelegationAlreadyCancelledResult {
  readonly status: 'already_cancelled';
}

/** Delegation is claimed by a child run and requires `force` to cancel. */
interface AbortDelegationNeedsForceResult {
  readonly status: 'needs_force';
  /** Child run currently holding the claimed delegation. */
  readonly childRunId: string;
}

/** No delegation exists on the targeted substep (or substep not found). */
interface AbortDelegationNotFoundResult {
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
  /** Current runbook state. */
  readonly state: RunbookState;
  /** Step (or substep) to delegate: "2" or "2.1". */
  readonly stepId: string;
  /** Path to the child runbook to delegate to. */
  readonly childRunbookPath: string;
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
  readonly substeps: readonly string[];
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

/** An active (uncancelled, unclaimed) delegation already exists on the substep. */
export interface CreateDelegationExistsResult {
  readonly status: 'delegation_exists';
  readonly step: string;
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
  | CreateDelegationExistsResult;

/**
 * @deprecated INTERNAL REFACTOR PLUMBING ONLY. Not a public API, not intended
 * for external consumption, and will be removed in Task 4 of this plan.
 *
 * This alias exists solely to keep `retryDelegation`'s local variable
 * declaration type-compiling through the multi-step refactor. It is NOT a
 * bridging mechanism for downstream callers.
 *
 * External consumers (if any are discovered by the pre-Task-4 audit of
 * `packages/mcp/` and `packages/claude-code-plugin/`) should migrate
 * directly to `CreateDelegationResult` — do not depend on this alias.
 */
export type DelegateResult = CreateDelegationCreatedResult;

/**
 * Create a delegation for a substep (or bare step) of the current runbook.
 *
 * Pure function — no I/O, no persistence. The caller is responsible for
 * persisting the returned `updatedSubstepStates` into the runbook state.
 *
 * @param options - Delegation creation options
 * @param steps - Parsed steps from the active runbook
 * @returns Delegation result with token, hash, delegation object, and updated substep states
 * @throws {RundownError} RD-801 if step not found
 * @throws {RundownError} RD-802 if step not at execution frontier
 * @throws {RundownError} RD-803 if step has substeps but no substep specified
 * @throws {RundownError} RD-804 if an active delegation already exists on the substep
 * @throws {RundownError} RD-805 if substep specified but step has no substeps
 */
export function createDelegation(
  options: DelegateOptions,
  steps: readonly ResolvedStep[],
): DelegateResult {
  const { state, stepId, childRunbookPath, extraVars, ancestors, frameKey } = options;

  // 1. Parse step ID
  const parsed = parseStepIdFromString(stepId);
  if (!parsed) {
    throw Errors.delegationStepNotFound(stepId);
  }

  // 2. Find step in parsed runbook
  const step = steps.find((s) => s.name === parsed.step);
  if (!step) {
    throw Errors.delegationStepNotFound(parsed.step);
  }

  // 3. If step has substeps and no substep specified, require it
  if (resolvedStepHasSubsteps(step) && !parsed.substep) {
    throw Errors.delegationSubstepRequired(
      parsed.step,
      step.substeps.map((ss) => ss.id),
    );
  }

  // 3b. If substep specified, validate it exists in the step
  if (parsed.substep) {
    if (!resolvedStepHasSubsteps(step)) {
      throw Errors.delegationSubstepNotFound(parsed.substep, parsed.step, []);
    }
    const validIds = step.substeps.map((ss) => ss.id);
    if (!validIds.includes(parsed.substep)) {
      throw Errors.delegationSubstepNotFound(parsed.substep, parsed.step, validIds);
    }
  }

  // 3c. Three-level step ID (step.iteration.substep) requires a FOR-capable step
  if (typeof parsed.at === 'number' && step.kind !== 'for' && step.kind !== 'prompted-for') {
    throw Errors.delegationStepNotFound(stepId);
  }

  // 4. Verify step is at frontier
  if (state.step !== parsed.step) {
    throw Errors.delegationStepNotCurrent(parsed.step, state.step);
  }

  // 5. Determine the substep ID for delegation attachment
  const substepId = parsed.substep ?? parsed.step;

  // 6. Check for existing active delegation on this substep (frame-scoped)
  const existingStates = state.substepStates ?? [];
  const targetSubstep = findSubstepState(existingStates, substepId, frameKey);

  const existingDelegation = targetSubstep?.delegation;
  if (existingDelegation?.cancelledAt === null && existingDelegation.childRunId === null) {
    throw Errors.delegationAlreadyExists(stepId);
  }

  // 7. Generate token and hash
  const token = generateDelegationToken();
  const tokenHash = hashDelegationToken(token);

  // 8. Build context snapshot
  const explicitIteration = typeof parsed.at === 'number' ? parsed.at : undefined;
  const contextSnapshot = buildContextSnapshot(state, parsed.substep, ancestors, {
    extraVars,
    iterationOverride: explicitIteration,
  });

  // 9. Create delegation object
  const delegation: StepDelegation = {
    tokenHash,
    childRunbookPath,
    contextSnapshot,
    childRunId: null,
    createdAt: new Date().toISOString(),
    cancelledAt: null,
    ...(extraVars ? { extraVars } : {}),
  };

  // 10. Produce updated substepStates (frame-scoped)
  let updatedSubstepStates: readonly SubstepState[];

  if (targetSubstep) {
    // Update existing entry for this frame
    updatedSubstepStates = existingStates.map((ss) =>
      ss === targetSubstep ? { ...ss, delegation } : ss,
    );
  } else {
    // Append new entry for this frame (new iteration or simple step)
    updatedSubstepStates = [
      ...existingStates,
      { id: substepId, frameKey, status: 'pending' as const, delegation },
    ];
  }

  return {
    status: 'created' as const,
    token,
    tokenHash,
    delegation,
    updatedSubstepStates,
  };
}

/**
 * Abort a delegation on a substep.
 *
 * Pure function — no I/O, no persistence. The caller is responsible for
 * persisting the returned `updatedSubstepStates` into the runbook state.
 *
 * @param options - Abort delegation options
 * @returns Abort result indicating outcome
 * @throws {RundownError} RD-801 if substep not found or has no delegation
 */
export function abortDelegation(options: AbortDelegationOptions): AbortDelegationResult {
  const { parentState, substepId, force, frameKey } = options;

  // 1. Find substep (frame-scoped)
  const existingStates = parentState.substepStates ?? [];
  const targetSubstep = findSubstepState(existingStates, substepId, frameKey);

  if (!targetSubstep?.delegation) {
    throw Errors.delegationStepNotFound(substepId);
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
}

/** Substep had no delegation to retry. */
interface RetryDelegationNotFoundResult {
  readonly status: 'not_found';
}

/** State's current step is not the step that owns the delegation. */
interface RetryDelegationNotCurrentResult {
  readonly status: 'not_current';
  /** Step that owns the delegation. */
  readonly ownerStep: string;
  /** State's current step. */
  readonly currentStep: string;
}

/** createDelegation raised a RundownError (path unresolvable, substep removed, etc.). */
interface RetryDelegationErrorResult {
  readonly status: 'error';
  readonly error: RundownError;
}

/** Retry succeeded: old delegation cancelled, new one issued. */
interface RetryDelegationRetriedResult {
  readonly status: 'retried';
  readonly token: string;
  readonly tokenHash: string;
  readonly delegation: StepDelegation;
  readonly updatedSubstepStates: readonly SubstepState[];
}

/**
 * Possible outcomes of a retry attempt.
 */
export type RetryDelegationResult =
  | RetryDelegationRetriedResult
  | RetryDelegationNotFoundResult
  | RetryDelegationNotCurrentResult
  | RetryDelegationErrorResult;

/**
 * Atomically cancel an existing delegation (force-style) and mint a replacement
 * using the same `childRunbookPath` and inherited (or overridden) `extraVars`.
 *
 * Pure function, Result-based for expected outcomes. The caller persists the
 * returned `updatedSubstepStates` via `manager.update`. Preconditions are
 * validated up-front; if any fails the function returns a discriminated error
 * variant and state is unchanged.
 *
 * This diverges from `abortDelegation`'s mixed throw/return shape deliberately:
 * `retryDelegation` runs inside XState `assign` callbacks where throws conflict
 * with actor atomicity for expected outcomes. The `error` variant wraps
 * `createDelegation`'s `RundownError` so callers can distinguish validation
 * failures (missing child runbook, substep renamed, racing delegation) from
 * normal flow. Non-`RundownError` exceptions from `createDelegation` are
 * rethrown: those indicate a bug where actor atomicity is already in question,
 * so preserving the panic is preferable to silently swallowing it. A future
 * refactor of `createDelegation` to a Result-based shape would eliminate the
 * non-`RundownError` rethrow path and make `retryDelegation` genuinely
 * throw-free.
 *
 * @param options - Retry options
 * @param steps - Parsed steps from the active runbook
 * @returns Discriminated union: `retried` | `not_found` | `not_current` | `error`
 * @throws {Error} Non-`RundownError` exceptions raised by `createDelegation`
 *   are rethrown. This indicates a bug in `createDelegation` rather than a
 *   normal validation outcome; expected domain failures return the `error`
 *   variant instead.
 */
export function retryDelegation(
  options: RetryDelegationOptions,
  steps: readonly ResolvedStep[],
): RetryDelegationResult {
  const { state, substepId, frameKey, overrides } = options;

  // 1. Locate the existing delegation.
  const existingStates = state.substepStates ?? [];
  const targetSubstep = findSubstepState(existingStates, substepId, frameKey);
  const existingDelegation = targetSubstep?.delegation;
  if (!existingDelegation) {
    return { status: 'not_found' };
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
    return { status: 'not_current', ownerStep, currentStep: state.step };
  }

  // 3. Compose inherited + override extraVars.
  const mergedExtraVars: Record<string, TemplateVarValue> | undefined =
    existingDelegation.extraVars || overrides
      ? { ...(existingDelegation.extraVars ?? {}), ...(overrides ?? {}) }
      : undefined;

  // 4. Force-cancel the existing delegation. Idempotent on already-cancelled.
  const abortResult = abortDelegation({
    parentState: state,
    substepId,
    force: true,
    frameKey,
  });
  const stateAfterAbort: RunbookState =
    abortResult.status === 'cancelled'
      ? { ...state, substepStates: abortResult.updatedSubstepStates }
      : state;

  // 5. Mint a fresh delegation. createDelegation can throw RundownError; catch
  //    and wrap as the `error` variant so the state-machine caller can discriminate.
  //    Bare-step delegations are stored with substepState.id === step.name
  //    (see createDelegation step 5: `parsed.substep ?? parsed.step`), so the
  //    reconstructed stepId must NOT append the substep segment in that case.
  //    Disambiguate by checking whether the owning step has substeps.
  const ownerStepDefinition = steps.find((s) => s.name === state.step);
  const ownerHasSubsteps =
    ownerStepDefinition !== undefined && resolvedStepHasSubsteps(ownerStepDefinition);
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
  let createResult: DelegateResult;
  try {
    createResult = createDelegation(
      {
        state: stateAfterAbort,
        stepId: stepIdForCreate,
        childRunbookPath: existingDelegation.childRunbookPath,
        ...(mergedExtraVars ? { extraVars: mergedExtraVars } : {}),
        ancestors: [],
        frameKey,
      },
      steps,
    );
  } catch (err) {
    if (err instanceof RundownError) {
      return { status: 'error', error: err };
    }
    throw err;
  }

  return {
    status: 'retried',
    token: createResult.token,
    tokenHash: createResult.tokenHash,
    delegation: createResult.delegation,
    updatedSubstepStates: createResult.updatedSubstepStates,
  };
}
