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
import type { ExecutionEpoch, GuardedMutationResult } from './storage/mutation-result.js';
import { InvalidRunbookStateError } from './state.js';

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
  /**
   * Whether the live snapshot has reached the machine's recovery state.
   *
   * Deliberately a single predicate rather than a general `hasTag(tag)`: this
   * seam only ever asks the one question, and a tag-taking signature invites
   * an implementation that answers for exactly one tag while appearing to
   * answer for all of them.
   *
   * @returns Whether the current snapshot carries the machine's `RECOVERY_TAG`.
   */
  isInRecoveryState(): boolean;
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

/**
 * Outcome of a persisted execution-recovery attempt.
 *
 * `recovered` committed the recovery snapshot; `missing`, `not_pending`, and
 * `superseded` report why no recovery write was needed. `recovery_required`
 * means the persisted snapshot is incompatible with automatic recovery and an
 * operator must stop, prune, or restart the run.
 */
export type RecoveryOutcome =
  | { readonly kind: 'recovered'; readonly runId: RunId; readonly epoch: ExecutionEpoch }
  | { readonly kind: 'missing'; readonly runId: RunId }
  | { readonly kind: 'not_pending'; readonly runId: RunId }
  | {
      readonly kind: 'superseded';
      readonly runId: RunId;
      readonly message: string;
    }
  | Extract<GuardedMutationResult<never>, { readonly kind: 'recovery_required' }>;

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
   * @param expectedEpoch - Exact interrupted attempt requested by the caller.
   * @returns The recovery outcome.
   */
  async recover(runId: RunId, expectedEpoch?: ExecutionEpoch): Promise<RecoveryOutcome> {
    const state = await this.store.loadRun(runId);
    if (state === null) {
      return { kind: 'missing', runId };
    }
    const pending = await this.store.readPendingRecovery(runId);
    if (pending === null) {
      return { kind: 'not_pending', runId };
    }
    if (expectedEpoch !== undefined && pending.epoch !== expectedEpoch) {
      return {
        kind: 'superseded',
        runId,
        message: `Recovery epoch ${String(expectedEpoch)} for run ${runId} was superseded by epoch ${String(pending.epoch)}.`,
      };
    }
    const reason = validateReason(pending.reason, runId);

    // Rehydrate, send ONLY the pure recovery event, capture the new snapshot.
    let actor: RecoveryActor | undefined;
    let snapshot: unknown;
    try {
      actor = this.makeActor(state);
      actor.send({
        type: 'EXECUTION_OUTCOME_UNKNOWN',
        epoch: pending.epoch,
        reason,
        interruptedStepId: state.step,
      });
      if (!actor.isInRecoveryState()) {
        // Carries NO structured defect, deliberately. The `catch` below
        // converts every `InvalidRunbookStateError` raised inside this `try`
        // into a `recovery_required` outcome, so this one never escapes to the
        // CLI wrapper and could never reach an RD-309 envelope. A defect here
        // would be dead data claiming to be a diagnosis. `validateReason` above
        // is called OUTSIDE this `try` and does propagate, which is why it
        // carries one.
        throw new InvalidRunbookStateError(
          `Recovery for run ${runId} did not enter the machine recovery state.`,
        );
      }
      snapshot = actor.getPersistedSnapshot();
    } catch (error) {
      if (error instanceof InvalidRunbookStateError) {
        return {
          kind: 'recovery_required',
          runId,
          epoch: pending.epoch,
          message: `Run ${runId} needs recovery: ${error.message}`,
        };
      }
      throw error;
    } finally {
      actor?.stop();
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
 * Validate a persisted recovery-reason string.
 *
 * Exported for unit tests of {@link ExecutionRecoveryService.recover}; not a
 * public contract.
 *
 * @param value - Persisted reason, or null.
 * @param runId - Run the reason was read from, carried into the refusal's
 *   structured defect so RD-309 names it without prose parsing.
 * @returns A recognized recovery reason.
 * @throws {InvalidRunbookStateError} When a non-null value is unrecognized.
 * @internal
 */
export function validateReason(value: string | null, runId: RunId): ExecutionRecoveryReason {
  if (value === null) {
    return DEFAULT_REASON;
  }
  if ((RECOVERY_REASONS as readonly string[]).includes(value)) {
    return value as ExecutionRecoveryReason;
  }
  throw new InvalidRunbookStateError(
    `Unrecognized persisted recovery reason ${JSON.stringify(value)}. This run's state is stale ` +
      'or corrupt and cannot be recovered; stop, prune, or restart it.',
    { runId, reason: 'unrecognized_recovery_reason' },
  );
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
  epoch: ExecutionEpoch,
  result: GuardedMutationResult<RunbookState>,
): RecoveryOutcome {
  if (result.kind === 'committed') {
    return { kind: 'recovered', runId, epoch };
  }
  // Every refusal variant of GuardedMutationResult declares an operator-facing
  // `message`, so there is nothing to synthesize here.
  return {
    kind: 'superseded',
    runId,
    message: result.message,
  };
}
