/**
 * The single core owner of the effectful-mutation choreography.
 *
 * Every mutation that crosses an external effect boundary — running a shell
 * command, preparing a delegation, invoking a helper — flows through exactly one
 * sequence: acquire an execution attempt under the captured claim/state CAS, mark
 * the effect boundary, run the effect (`compute`), then commit the result under
 * the exact token/epoch. The token never leaves core; frontends call a typed core
 * API and render only the discriminated {@link GuardedMutationResult}.
 *
 * The fence has one non-negotiable rule: an ambiguous external effect is never
 * automatically repeated. If an operation fails ambiguously after the effect
 * boundary — during `compute` or while observing its commit — the attempt is
 * abandoned to `recovery_pending` and the caller receives `recovery_required` —
 * the machine-owned recovery path resumes it later. If the guarded commit finds
 * the attempt was superseded (its phase moved, or a fresh attempt reacquired the
 * run), that refusal surfaces as itself; `compute` is run exactly once and never
 * retried on a stale commit.
 *
 * `ActorMutationCommitter` is not a second commit concept: it is the
 * actor-specific binding supplied as the executor's `commit` argument. There is
 * one commit abstraction — the executor's generic closure — and the committer is
 * its concrete binding over {@link RunbookStore.commitOwnedState}.
 *
 * @module runbook/effectful-mutation-executor
 */

import type { RunbookState, ExecutionRecoveryReason } from './types.js';
import type { ExecutionObservationEffect } from '../events/execution-observation.js';
import type { CapturedAuthority, GuardedMutationResult } from './storage/mutation-result.js';
import type {
  ExecutionAttempt,
  ExecutionLeaseService,
  LeaseWaitPolicy,
} from './storage/execution-lease.js';
import type { RunbookStore } from './storage/runbook-store.js';
import type { ActorSyncResult } from './actor-service.js';

/**
 * The pure result of running an actor transition without persisting it.
 *
 * Produced by the computation half of the compute/commit seam: the actor is
 * created, the event sent, and machine effects awaited, but no persistence
 * happens. `nextState` is the derived state the committer will write under the
 * execution CAS; `previousState` is the state the actor was hydrated from.
 */
export interface PreparedActorMutation {
  /** The run state the actor was hydrated from. */
  readonly previousState: RunbookState;
  /** The derived next run state, not yet persisted. */
  readonly nextState: RunbookState;
  /** The raw persisted machine snapshot after the transition. */
  readonly snapshot: unknown;
  /** Non-persisted execution observations produced while computing. */
  readonly effects: readonly ExecutionObservationEffect[];
}

/**
 * The actor-specific commit binding supplied to {@link EffectfulMutationExecutor}.
 *
 * Persists a {@link PreparedActorMutation} under the owning attempt's exact
 * token/epoch in one transaction: it writes the new run state, consumes any
 * resolved completion, marks the attempt committed, and clears ownership.
 */
export interface ActorMutationCommitter {
  /**
   * Commit a prepared actor mutation under the owning attempt.
   *
   * @param attempt - The owning `effect_started` execution attempt.
   * @param prepared - The computed, not-yet-persisted mutation.
   * @returns The committed sync result, or a typed refusal (including
   *   `recovery_required` when the attempt was superseded).
   */
  commit(
    attempt: ExecutionAttempt,
    prepared: PreparedActorMutation,
  ): Promise<GuardedMutationResult<ActorSyncResult>>;
}

/** Inputs describing one effectful mutation for {@link EffectfulMutationExecutor.run}. */
export interface EffectfulMutationInput<TPrepared, TResult> {
  /** Authority captured before the effect (claim/state CAS predicate). */
  readonly captured: CapturedAuthority;
  /** Run the external effect and return its prepared, not-yet-committed result. */
  readonly compute: () => Promise<TPrepared>;
  /** Persist the prepared result under the owning attempt's exact token/epoch. */
  readonly commit: (
    attempt: ExecutionAttempt,
    prepared: TPrepared,
  ) => Promise<GuardedMutationResult<TResult>>;
  /** Recovery cause recorded for an ambiguous failure after the effect boundary. */
  readonly recoveryReason?: ExecutionRecoveryReason;
  /** Optional finite wait policy for lease contention (default: immediate refusal). */
  readonly wait?: LeaseWaitPolicy;
}

/** The sole core owner of capture/acquire/mark-effect/compute/commit/recovery. */
export interface EffectfulMutationExecutor {
  /**
   * Run one effectful mutation through the full fence.
   *
   * @param input - The mutation's captured authority, compute, and commit steps.
   * @returns The committed result, or a typed refusal.
   */
  run<TPrepared, TResult>(
    input: EffectfulMutationInput<TPrepared, TResult>,
  ): Promise<GuardedMutationResult<TResult>>;
}

/** Default recovery cause for an ambiguous failure after the effect boundary. */
const DEFAULT_MID_EFFECT_REASON: ExecutionRecoveryReason = 'effect_boundary_crossed';

/**
 * SQLite-lease-backed {@link EffectfulMutationExecutor}.
 *
 * Owns the acquire → mark-effect → compute → commit sequence and the mid-effect
 * recovery decision. Holds no store reference: persistence is entirely delegated
 * to the injected `commit` closure (an {@link ActorMutationCommitter} binding),
 * so this class knows only the execution protocol, never the repository shape.
 */
export class CoreEffectfulMutationExecutor implements EffectfulMutationExecutor {
  /**
   * Construct the executor.
   *
   * @param lease - The execution-ownership protocol.
   * @param ownerPid - The acquiring process id (defaults to the current process).
   */
  constructor(
    private readonly lease: ExecutionLeaseService,
    private readonly ownerPid: number = process.pid,
  ) {}

  async run<TPrepared, TResult>(
    input: EffectfulMutationInput<TPrepared, TResult>,
  ): Promise<GuardedMutationResult<TResult>> {
    const acquired = await this.lease.acquire(input.captured, this.ownerPid, input.wait);
    if (acquired.kind !== 'committed') {
      return acquired;
    }
    // Mark the effect boundary BEFORE running the effect, so a crash during
    // `compute` leaves an `effect_started` attempt that dead-owner recovery moves
    // to `recovery_pending` rather than silently re-running.
    const marked = await this.lease.markEffectStarted(acquired.value);
    if (marked.kind !== 'committed') {
      // Ownership lost before the boundary; nothing external ran. Refuse.
      return marked;
    }
    const attempt = marked.value;

    let prepared: TPrepared;
    try {
      prepared = await input.compute();
    } catch {
      // The effect boundary was crossed; the external outcome is unknown. Record
      // recovery instead of retrying — the ambiguous effect must never repeat.
      // A failed recovery-write must never mask this typed post-boundary outcome
      // (RD-102): the surviving `effect_started` attempt stays reclaimable by
      // dead-owner recovery, so suppress the write error and still return
      // `recovery_required`.
      try {
        await this.lease.abandonToRecovery(
          attempt,
          input.recoveryReason ?? DEFAULT_MID_EFFECT_REASON,
        );
      } catch {
        // The surviving exact lease remains recoverable by dead-owner recovery.
      }
      return {
        kind: 'recovery_required',
        runId: input.captured.runId,
        epoch: attempt.epoch,
        message: `Run ${input.captured.runId} needs recovery: its execution outcome is unknown after a mid-effect failure.`,
      };
    }

    try {
      return await input.commit(attempt, prepared);
    } catch (commitError) {
      // A thrown commit has an ambiguous durability outcome: it may have failed
      // before commit, or committed durably before its caller observed an error.
      // The exact token/epoch/phase guard ensures this only moves our still-live
      // effect_started attempt; it cannot overwrite a committed or superseded
      // attempt. If that guarded recovery refuses or itself fails, preserve the
      // primary commit exception rather than reporting a recovery state that was
      // not recorded.
      try {
        const recovery = await this.lease.abandonToRecovery(
          attempt,
          input.recoveryReason ?? DEFAULT_MID_EFFECT_REASON,
        );
        if (recovery.kind === 'recovery_required') {
          return recovery;
        }
      } catch {
        // The surviving exact lease remains recoverable by dead-owner recovery.
      }
      throw commitError;
    }
  }
}

/**
 * Concrete {@link ActorMutationCommitter} over a {@link RunbookStore}.
 *
 * Bound to the authority captured for one mutation; each guarded commit persists
 * the prepared actor mutation under that authority and the owning attempt.
 */
export class RunbookStoreActorCommitter implements ActorMutationCommitter {
  /**
   * Construct the committer.
   *
   * @param store - The transactional runbook store.
   * @param captured - Authority captured before the effect.
   */
  constructor(
    private readonly store: RunbookStore,
    private readonly captured: CapturedAuthority,
  ) {}

  async commit(
    attempt: ExecutionAttempt,
    prepared: PreparedActorMutation,
  ): Promise<GuardedMutationResult<ActorSyncResult>> {
    const result = await this.store.commitOwnedState(
      this.captured,
      { token: attempt.token, epoch: attempt.epoch },
      prepared.nextState,
    );
    if (result.kind !== 'committed') {
      return result;
    }
    return {
      kind: 'committed',
      value: {
        state: result.value,
        snapshot: prepared.snapshot,
        effects: prepared.effects,
      },
    };
  }
}
