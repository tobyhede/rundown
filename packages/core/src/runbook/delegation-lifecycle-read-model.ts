import type { VariableValue } from './effective-vars.js';
import type { RunId } from './run-id.js';
import { deriveActiveFrame, SENTINEL_ENTRY, type FrameKey } from './targeting.js';
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
      targetSubstep: completion.targetSubstep as string,
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

function activeEntryFor(state: RunbookState, activeFrameKey: FrameKey): number {
  return state.activeEntry ?? state.frameEntries?.[activeFrameKey] ?? 1;
}

function belongsToActiveCollectionScope(
  fact: DelegationOutcomeReportedFact,
  activeFrameKey: FrameKey,
  activeEntry: number,
): boolean {
  // Provisional Plan 1 scope rule: report all delegation outcomes, but mark
  // collection pending only for the active cursor frame/entry until the
  // command-policy plan resolves wider enforcement semantics.
  return (
    fact.targetFrameKey === activeFrameKey &&
    (fact.targetEntry === activeEntry || fact.targetEntry === SENTINEL_ENTRY)
  );
}

/**
 * Derive collection-pending state for the delegating run's active scope.
 *
 * @param state - Delegating run state to inspect
 * @returns Collection-pending read model for the active frame and entry
 */
export function readDelegationCollectionPending(
  state: RunbookState,
): DelegationCollectionPendingReadModel {
  const derived = deriveActiveFrame(state);
  const activeFrameKey = state.activeFrameKey ?? derived.frameKey;
  const activeEntry = activeEntryFor(state, activeFrameKey);
  const outcomes = readDelegationOutcomeReportedFacts(state).filter((fact) =>
    belongsToActiveCollectionScope(fact, activeFrameKey, activeEntry),
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
