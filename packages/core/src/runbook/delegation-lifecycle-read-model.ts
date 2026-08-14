import type { VariableValue } from './effective-vars.js';
import { deriveActiveCompletionFrame } from './frame-entry.js';
import type { RunId } from './run-id.js';
import { completionEntryForFrame, completionTargetsFrame, type FrameKey } from './targeting.js';
import type { DelegationOutcome, RunbookState } from './types.js';

const DELEGATION_AGENT_ID = 'delegation';

/** Message paired with the DELEGATION_COLLECTION_PENDING frontend error code. */
export const DELEGATION_COLLECTION_PENDING_MESSAGE =
  'A delegated claim has reported an outcome that must be collected by the orchestrator.';

/**
 * Pure read model for a reported delegation outcome.
 *
 * This is derived from existing `resolvedCompletions` rows whose `agentId` is
 * `delegation`. It intentionally does not introduce a persisted schema field.
 */
export interface DelegationOutcomeReportedFact {
  /** Read-model discriminant. */
  readonly kind: 'delegation-outcome-reported';
  /** Completion key under which the reported outcome is currently persisted. */
  readonly completionKey: string;
  /** Delegating run that owns the reported outcome row. */
  readonly parentRunId: RunId;
  /** Step that owns the delegated substep. */
  readonly targetStep: string;
  /** Delegated substep that reported an outcome. */
  readonly targetSubstep: string;
  /** FOR iteration for loop-scoped delegation outcomes. */
  readonly targetIteration?: number;
  /** Active or historical frame key for the delegated substep. */
  readonly targetFrameKey: FrameKey;
  /** Active, exact, or sentinel entry for the delegated substep frame. */
  readonly targetEntry: number;
  /** Delegation outcome projected from the delegated run terminal lifecycle. */
  readonly outcome: DelegationOutcome;
  /** ISO timestamp when the outcome was reported. */
  readonly reportedAt: string;
  /** Final variables produced by the delegated run. */
  readonly finalVars?: Readonly<Record<string, VariableValue>>;
}

/** Pure read model for collection-pending state at the delegating run's active scope. */
export type DelegationCollectionPendingReadModel =
  | {
      /** Read-model discriminant. */
      readonly kind: 'delegation-collection-pending';
      /** Whether the active scope has unconsumed reported delegation outcomes. */
      readonly pending: true;
      /** Delegating run that may need collection. */
      readonly parentRunId: RunId;
      /** Active frame key used to derive collection scope. */
      readonly activeFrameKey: FrameKey;
      /** Active entry used to derive collection scope. */
      readonly activeEntry: number;
      /** Reported outcomes in the active collection scope. */
      readonly outcomes: readonly DelegationOutcomeReportedFact[];
      /** Operator-facing guidance for frontend error rendering. */
      readonly message: typeof DELEGATION_COLLECTION_PENDING_MESSAGE;
    }
  | {
      /** Read-model discriminant. */
      readonly kind: 'delegation-collection-pending';
      /** No unconsumed reported delegation outcomes exist in the active scope. */
      readonly pending: false;
      /** Delegating run that was inspected. */
      readonly parentRunId: RunId;
      /** Active frame key used to derive collection scope. */
      readonly activeFrameKey: FrameKey;
      /** Active entry used to derive collection scope. */
      readonly activeEntry: number;
      /** Empty when no collection is pending. */
      readonly outcomes: readonly [];
    };

/** Pure read model for collection-pending state used by command policy guards. */
export type DelegationCollectionPendingPolicyReadModel =
  | {
      /** Read-model discriminant. */
      readonly kind: 'delegation-collection-pending-policy';
      /** At least one unconsumed reported outcome is reachable from the live cursor. */
      readonly pending: true;
      /** Delegating run that may need collection. */
      readonly parentRunId: RunId;
      /** Reported outcomes blocking bare mutation. */
      readonly outcomes: readonly DelegationOutcomeReportedFact[];
      /** Operator-facing guidance for frontend error rendering. */
      readonly message: typeof DELEGATION_COLLECTION_PENDING_MESSAGE;
    }
  | {
      /** Read-model discriminant. */
      readonly kind: 'delegation-collection-pending-policy';
      /** No unconsumed reported outcome is reachable from the live cursor. */
      readonly pending: false;
      /** Delegating run that was inspected. */
      readonly parentRunId: RunId;
      /** Empty when no collection is pending. */
      readonly outcomes: readonly [];
    };

/**
 * Read reported delegation outcomes from existing completion rows.
 *
 * @param state - Delegating run state to inspect
 * @returns Reported delegation outcome facts sorted by persisted completion key
 */
export function readDelegationOutcomeReportedFacts(
  state: RunbookState,
): readonly DelegationOutcomeReportedFact[] {
  return Object.entries(state.resolvedCompletions ?? {})
    .filter(
      ([, completion]) =>
        completion.agentId === DELEGATION_AGENT_ID && completion.targetSubstep !== undefined,
    )
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([completionKey, completion]) => ({
      kind: 'delegation-outcome-reported',
      completionKey,
      parentRunId: state.id,
      targetStep: completion.targetStep,
      targetSubstep: completion.targetSubstep!,
      ...(completion.targetIteration !== undefined
        ? { targetIteration: completion.targetIteration }
        : {}),
      targetFrameKey: completion.targetFrameKey,
      targetEntry: completion.targetEntry,
      outcome: completion.result,
      reportedAt: completion.completedAt,
      ...(completion.finalVars ? { finalVars: completion.finalVars } : {}),
    }));
}

/**
 * Derive collection-pending state for the delegating run's active scope.
 *
 * Scope is the frame the completion drain resolves against — the live cursor's
 * frame at its live entry, plus the sentinel entry — decided by the drain's own
 * rule (`completionTargetsFrame`) rather than a second hand-written test. A row
 * outside it is one `rundown collect` cannot consume, now or ever: entry
 * ordinals are monotonic, so a frame the cursor left is re-entered at a strictly
 * greater entry.
 *
 * @param state - Delegating run state to inspect
 * @returns Collection-pending read model for the active frame and entry
 */
export function readDelegationCollectionPending(
  state: RunbookState,
): DelegationCollectionPendingReadModel {
  const frame = deriveActiveCompletionFrame(state);
  const activeFrameKey = frame.frameKey;
  const activeEntry = completionEntryForFrame(frame);
  const outcomes = readDelegationOutcomeReportedFacts(state).filter((fact) =>
    completionTargetsFrame(frame, fact),
  );

  if (outcomes.length === 0) {
    return {
      kind: 'delegation-collection-pending',
      pending: false,
      parentRunId: state.id,
      activeFrameKey,
      activeEntry,
      outcomes: [],
    };
  }

  return {
    kind: 'delegation-collection-pending',
    pending: true,
    parentRunId: state.id,
    activeFrameKey,
    activeEntry,
    outcomes,
    message: DELEGATION_COLLECTION_PENDING_MESSAGE,
  };
}

/**
 * Derive policy-level collection-pending state for bare mutation guards.
 *
 * The projection of {@link readDelegationCollectionPending} the command-policy
 * guards consume — same scope, different shape (the guards report the blocking
 * completion keys, not the cursor they were derived from). Deriving it rather
 * than re-testing scope is the fix for #749: the guard used to match on frame
 * openness alone, so a row at a superseded entry — or on a frame the cursor had
 * left — was reported as awaiting collection while the drain could never select
 * it. `rundown pass` then named a completion key that `rundown collect` refused,
 * and the run could neither advance nor collect. Blocking now implies the drain
 * can reach the row, which is what makes "run rundown collect" a remedy that
 * works.
 *
 * A row outside the scope is genuinely abandoned: it stays in
 * `resolvedCompletions` and in {@link readDelegationOutcomeReportedFacts}, and
 * `rundown delegate --retry` is what clears it before re-delegating the substep.
 *
 * @param state - Delegating run state to inspect
 * @returns Policy read model for the outcomes a bare mutation must yield to
 */
export function readDelegationCollectionPendingForPolicy(
  state: RunbookState,
): DelegationCollectionPendingPolicyReadModel {
  const active = readDelegationCollectionPending(state);

  if (!active.pending) {
    return {
      kind: 'delegation-collection-pending-policy',
      pending: false,
      parentRunId: active.parentRunId,
      outcomes: [],
    };
  }

  return {
    kind: 'delegation-collection-pending-policy',
    pending: true,
    parentRunId: active.parentRunId,
    outcomes: active.outcomes,
    message: active.message,
  };
}
