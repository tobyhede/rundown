/**
 * Machine-owned interrupted-execution recovery.
 *
 * When a run's execution owner dies after the effect boundary, dead-owner
 * recovery moves its attempt to `recovery_pending` (still blocking, no execution
 * authority). This service resumes such a run: it rehydrates the persisted
 * snapshot, sends the single pure {@link ExecutionRecoveryEvent} through the
 * machine (jumping to the non-final `recoveryRequired` state), and atomically
 * commits the resulting snapshot while clearing ownership. It never invokes the
 * command, delegation, or helper actors, and never automatically re-runs the
 * ambiguous effect. A crash during recovery leaves the attempt `recovery_pending`
 * and resumable.
 *
 * The actor is supplied through an injected factory so this service does not
 * depend on actor-service internals: the factory rehydrates the snapshot; this
 * service only sends the pure event and persists the outcome.
 *
 * @module runbook/execution-recovery-service
 */

import type { RunId } from './run-id.js';
import type { RunbookState, ExecutionRecoveryReason, ExecutionRecoveryEvent } from './types.js';
import type { RunbookStore } from './storage/runbook-store.js';
import type { GuardedMutationResult } from './storage/mutation-result.js';

/**
 * Minimal machine-actor surface the recovery service drives. Rehydrated at the
 * persisted snapshot; only the pure recovery event is sent.
 */
export interface RecoveryActor {
  /**
   * Send the pure recovery event.
   *
   * @param event - The execution-recovery event.
   */
  send(event: ExecutionRecoveryEvent): void;
  /**
   * Return the persisted snapshot after the event settles.
   *
   * @returns The serialized machine snapshot.
   */
  getPersistedSnapshot(): unknown;
  /** Stop the actor, releasing any resources. */
  stop(): void;
}

/**
 * Factory that rehydrates a started {@link RecoveryActor} from persisted state.
 *
 * The factory MUST compile the machine with inert (or throwing) command,
 * delegation, and helper actor implementations: recovery jumps directly to
 * `recoveryRequired` and must never re-run the original effect path.
 */
export type RecoveryActorFactory = (state: RunbookState) => RecoveryActor;

/** Outcome of a recovery attempt. */
export type RecoveryOutcome =
  | { readonly kind: 'recovered'; readonly runId: RunId; readonly epoch: number }
  | { readonly kind: 'missing'; readonly runId: RunId }
  | { readonly kind: 'not_pending'; readonly runId: RunId }
  | {
      readonly kind: 'superseded';
      readonly runId: RunId;
      readonly message: string;
    };

/** Default recovery reason when the attempt row recorded none. */
const DEFAULT_REASON: ExecutionRecoveryReason = 'owner_dead';

/** Recognized recovery reasons for validating a persisted value. */
const RECOVERY_REASONS: readonly ExecutionRecoveryReason[] = [
  'owner_dead',
  'effect_boundary_crossed',
  'stale_commit',
];

/**
 * Resumes `recovery_pending` runs by driving the pure machine recovery event and
 * committing the resulting `recoveryRequired` snapshot.
 */
export class ExecutionRecoveryService {
  /**
   * Construct the recovery service.
   *
   * @param store - The runbook store.
   * @param makeActor - Factory rehydrating a started actor from persisted state.
   * @param now - Clock returning an ISO timestamp (injectable for tests).
   */
  constructor(
    private readonly store: RunbookStore,
    private readonly makeActor: RecoveryActorFactory,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /**
   * Recover an interrupted run.
   *
   * @param runId - Run to recover.
   * @returns The recovery outcome.
   */
  async recover(runId: RunId): Promise<RecoveryOutcome> {
    const state = await this.store.loadRun(runId);
    if (state === null) {
      return { kind: 'missing', runId };
    }
    const pending = await this.store.readPendingRecovery(runId);
    if (pending === null) {
      return { kind: 'not_pending', runId };
    }
    const reason = validateReason(pending.reason);

    // Rehydrate, send ONLY the pure recovery event, capture the new snapshot.
    const actor = this.makeActor(state);
    let snapshot: unknown;
    try {
      actor.send({
        type: 'EXECUTION_OUTCOME_UNKNOWN',
        epoch: pending.epoch,
        reason,
        interruptedStepId: state.step,
      });
      snapshot = actor.getPersistedSnapshot();
    } finally {
      actor.stop();
    }

    const next: RunbookState = {
      ...state,
      snapshot,
      lifecycle: 'running',
      updatedAt: this.now(),
    };
    const committed = await this.store.commitRecovery({ epoch: pending.epoch, reason, next });
    return toOutcome(runId, pending.epoch, committed);
  }
}

/**
 * Validate a persisted recovery-reason string, falling back to the default.
 *
 * @param value - Persisted reason, or null.
 * @returns A recognized recovery reason.
 */
function validateReason(value: string | null): ExecutionRecoveryReason {
  return value !== null && (RECOVERY_REASONS as readonly string[]).includes(value)
    ? (value as ExecutionRecoveryReason)
    : DEFAULT_REASON;
}

/**
 * Map a store commit result to a recovery outcome.
 *
 * @param runId - Recovered run.
 * @param epoch - Interrupted epoch.
 * @param result - Store commit result.
 * @returns The recovery outcome.
 */
function toOutcome(
  runId: RunId,
  epoch: number,
  result: GuardedMutationResult<RunbookState>,
): RecoveryOutcome {
  if (result.kind === 'committed') {
    return { kind: 'recovered', runId, epoch };
  }
  return {
    kind: 'superseded',
    runId,
    message: 'message' in result ? result.message : `Recovery of run ${runId} was superseded.`,
  };
}
