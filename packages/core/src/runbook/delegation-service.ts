import { parseStepIdFromString, resolvedStepHasSubsteps } from '@rundown-org/parser';
import { Errors } from '../errors/factory.js';
import { generateDelegationToken, hashDelegationToken } from './delegation-token.js';
import {
  deriveExecutionAt,
  findSubstepState,
  getActiveForContext,
  type FrameKey,
} from './targeting.js';
import type {
  AncestorSnapshot,
  ContextSnapshot,
  RunbookState,
  ResolvedStep,
  StepDelegation,
  SubstepState,
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

/**
 * Possible outcomes when attempting to abort a delegation.
 */
export type AbortDelegationResult =
  | AbortDelegationCancelledResult
  | AbortDelegationAlreadyCancelledResult
  | AbortDelegationNeedsForceResult;

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
  readonly extraVars?: Readonly<Record<string, string>>;
  /** Ancestor chain built by the caller. */
  readonly ancestors?: readonly AncestorSnapshot[];
  /** Frame key scoping this delegation to a FOR iteration. */
  readonly frameKey: FrameKey;
}

/**
 * Result of creating a delegation.
 */
export interface DelegateResult {
  /** Plain-text token (to be given to the child agent). */
  readonly token: string;
  /** SHA-256 hash of the token (stored in state). */
  readonly tokenHash: string;
  /** The full delegation metadata. */
  readonly delegation: StepDelegation;
  /** Updated substep states array (caller persists this). */
  readonly updatedSubstepStates: readonly SubstepState[];
}

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
  const baseVars = { ...(state.templateVars ?? {}) };
  const mergedVars = extraVars ? { ...baseVars, ...extraVars } : baseVars;

  // Capture structural fields from the delegation target, not the cursor
  const activeFor = getActiveForContext(state.forStack, state.step);
  const iteration = (typeof parsed.at === 'number' ? parsed.at : undefined) ?? activeFor?.iteration;
  const at = deriveExecutionAt(state.step, parsed.substep, iteration);

  const contextSnapshot: ContextSnapshot = {
    vars: mergedVars,
    ancestors: ancestors ?? [],
    step: state.step,
    substep: parsed.substep,
    at,
    ...(iteration !== undefined ? { index: iteration } : {}),
  };

  // 9. Create delegation object
  const delegation: StepDelegation = {
    tokenHash,
    childRunbookPath,
    contextSnapshot,
    childRunId: null,
    createdAt: new Date().toISOString(),
    cancelledAt: null,
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
