import { parseStepIdFromString } from '@rundown-org/parser';
import { Errors } from '../errors/factory.js';
import { generateDelegationToken, hashDelegationToken } from './delegation-token.js';
import type {
  AncestorSnapshot,
  ContextSnapshot,
  RunbookState,
  Step,
  StepDelegation,
  SubstepState,
} from './types.js';

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
 */
export function createDelegation(options: DelegateOptions, steps: readonly Step[]): DelegateResult {
  const { state, stepId, childRunbookPath, extraVars, ancestors } = options;

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
  if (step.substeps && step.substeps.length > 0 && !parsed.substep) {
    throw Errors.delegationSubstepRequired(
      parsed.step,
      step.substeps.map((ss) => ss.id),
    );
  }

  // 3b. If substep specified, validate it exists in the step
  if (parsed.substep && step.substeps) {
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

  // 6. Check for existing active delegation on this substep
  const existingStates = state.substepStates ?? [];
  const targetSubstep = existingStates.find((ss) => ss.id === substepId);

  if (targetSubstep?.delegation?.cancelledAt === null) {
    throw Errors.delegationAlreadyExists(stepId);
  }

  // 7. Generate token and hash
  const token = generateDelegationToken();
  const tokenHash = hashDelegationToken(token);

  // 8. Build context snapshot
  const baseVars = { ...(state.templateVars ?? {}) };
  const mergedVars = extraVars ? { ...baseVars, ...extraVars } : baseVars;

  const contextSnapshot: ContextSnapshot = {
    vars: mergedVars,
    ancestors: ancestors ?? [],
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

  // 10. Produce updated substepStates
  let updatedSubstepStates: readonly SubstepState[];

  if (existingStates.length > 0) {
    // Update existing substep states, attaching delegation to the target substep
    updatedSubstepStates = existingStates.map((ss) => {
      if (ss.id === substepId) {
        return { ...ss, delegation };
      }
      return ss;
    });
  } else {
    // No existing substep states (simple step) — create a synthetic one
    updatedSubstepStates = [
      {
        id: substepId,
        status: 'pending' as const,
        delegation,
      },
    ];
  }

  return {
    token,
    tokenHash,
    delegation,
    updatedSubstepStates,
  };
}
