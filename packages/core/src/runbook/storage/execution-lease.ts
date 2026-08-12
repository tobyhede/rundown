/**
 * PID-aware execution ownership protocol over the SQLite store.
 *
 * Acquisition installs a fresh {@link ExecutionToken} and a strictly increasing
 * {@link ExecutionEpoch} on a run under the captured claim/state CAS, with the
 * attempt phase `claimed`. The owner's identity is `(pid, host start id)`, not a
 * bare pid — see `runbook/process-identity` for why a pid alone cannot say
 * whether the recorded owner is the process running under it now. The effect
 * boundary moves the exact owned attempt to `effect_started`. Dead-owner
 * recovery evaluates liveness OUTSIDE SQLite (never in a SQL predicate) and then
 * changes only the exact observed `(pid, token, epoch, phase)` tuple: a dead
 * pre-effect owner is reclaimed automatically; a dead effect-started owner
 * becomes `recovery_pending` and is never auto-re-executed.
 *
 * The default contention policy is immediate refusal (`execution_in_progress`),
 * but never before one dead-owner probe: a hard-killed owner has no other exit
 * (see {@link SqliteExecutionLeaseService.withWait}). An optional
 * {@link LeaseWaitPolicy} adds a finite retry budget on top, retrying the WHOLE
 * short transaction outside SQLite; no transaction or trigger ever waits.
 *
 * @module runbook/storage/execution-lease
 */

import { isOwnerAlive, sharedProcessIdentity, type ProcessIdentity } from '../process-identity.js';
import type { RunId } from '../run-id.js';
import type { ExecutionRecoveryReason } from '../types.js';
import type { ClaimLookupKey } from '../claim-id.js';
import type { SqlDriver, SqlReadTransaction, SqlTransaction } from './sql-driver.js';
import {
  selectCommitRow,
  classifyCommitRow,
  assertExactlyOneRow,
  assertExecutionPhase,
  type ExecutionPhase,
} from './runbook-store.js';
import {
  type CapturedAuthority,
  type ExecutionEpoch,
  type ExecutionToken,
  type GuardedMutationResult,
  assertExecutionEpoch,
  generateExecutionToken,
  hashExecutionToken,
} from './mutation-result.js';

/** An acquired execution attempt, held in-process by its owner (carries the raw token). */
export interface ExecutionAttempt {
  /** Owned run. */
  readonly runId: RunId;
  /** Raw execution token; only its hash is persisted. Never logged. */
  readonly token: ExecutionToken;
  /** Attempt epoch. */
  readonly epoch: ExecutionEpoch;
  /** Owning process id. */
  readonly ownerPid: number;
  /** Attempt phase. */
  readonly phase: 'claimed' | 'effect_started' | 'recovery_pending';
}

/**
 * Identity of a reclaimed dead attempt.
 *
 * A dead owner's raw token cannot be recovered (only its hash is persisted), so a
 * reclamation reports this descriptor rather than a full {@link ExecutionAttempt}.
 */
export interface ClearedAttemptRef {
  /** The run whose dead lease was cleared. */
  readonly runId: RunId;
  /** The cleared attempt's epoch. */
  readonly epoch: ExecutionEpoch;
  /** The dead owner's pid. */
  readonly ownerPid: number;
}

/**
 * Finite caller-level wait policy for lease contention. Retries the whole short
 * transaction OUTSIDE SQLite; no transaction or trigger ever waits.
 */
export interface LeaseWaitPolicy {
  /** Total wall-clock budget in milliseconds. */
  readonly budgetMs: number;
  /** Backoff for a given zero-based attempt, in milliseconds. */
  readonly backoff: (attempt: number) => number;
  /** Optional cancellation. */
  readonly signal?: AbortSignal;
}

/**
 * Time source for the contended-wait loop.
 *
 * The loop's whole observable contract is temporal — how many attempts it makes,
 * how long each backoff actually sleeps once capped to the remaining budget, and
 * whether it gave up for the deadline or for the abort. Reading the clock through
 * this seam lets a test drive that contract deterministically instead of asserting
 * wall-clock tolerances, which pass under almost any mutation of the loop body.
 *
 * Governs the wait loop ONLY. Persisted attempt timestamps
 * (`started_at`, `effect_started_at`) always come from the real clock: they are
 * stored data, not wait arithmetic.
 */
export interface LeaseWaitClock {
  /**
   * Current time in milliseconds, on the same origin as the wait deadline.
   *
   * @returns Milliseconds since an arbitrary but consistent epoch.
   */
  now(): number;
  /**
   * Sleep between wait attempts, resolving early if the signal aborts.
   *
   * @param ms - Delay in milliseconds, already capped to the remaining budget.
   * @param signal - Optional cancellation that resolves the sleep early.
   * @returns A promise resolving after the delay or cancellation.
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/**
 * Build the real-time {@link LeaseWaitClock} used when no clock is injected.
 *
 * A factory rather than a module-level constant: a constant's initializer runs at
 * import time, which puts its contents outside every test's reach (a "static"
 * mutant that no assertion can falsify). Built per construction, the same code is
 * ordinary runtime behaviour and is pinned by the tests like anything else.
 *
 * @returns A clock reading real time and sleeping on a real timer.
 */
export function createDefaultLeaseWaitClock(): LeaseWaitClock {
  return {
    now: () => Date.now(),
    sleep: (ms, signal) => delay(ms, signal),
  };
}

/** Progress diagnostic emitted between contended wait attempts. */
export interface LeaseWaitProgress {
  /** Run being waited on. */
  readonly runId: RunId;
  /** Number of wait attempts so far. */
  readonly attempts: number;
  /** Milliseconds remaining in the budget. */
  readonly remainingMs: number;
}

/**
 * The outcomes {@link ExecutionLeaseService.abandonToRecovery} can produce.
 *
 * The guarded update either moves this process's own `effect_started` attempt to
 * `recovery_pending` (`recovery_required`, carrying the run and epoch that now
 * need recovery), or matches no row because the attempt already moved
 * (`execution_in_progress`). There is no committed value to hand back, so the
 * `committed` variant is deliberately unrepresentable: no caller has to narrow a
 * case this operation cannot return.
 */
export type AbandonedAttemptOutcome = Extract<
  GuardedMutationResult<never>,
  { readonly kind: 'recovery_required' | 'execution_in_progress' }
>;

/** Exact interrupted attempt identity retained for aggregate recovery. */
export interface InterruptedAttemptRef {
  /** Run whose effect outcome is ambiguous. */
  readonly runId: RunId;
  /** Execution epoch that crossed the effect boundary. */
  readonly epoch: ExecutionEpoch;
}

/** Outcome of abandoning an aggregate effect to recovery all-or-none. */
export type AbandonedAttemptSetOutcome =
  | {
      readonly kind: 'aggregate_recovery_required';
      /** Every exact attempt that must be recovered before the workflow resumes. */
      readonly attempts: readonly InterruptedAttemptRef[];
      readonly message: string;
    }
  | Extract<GuardedMutationResult<never>, { readonly kind: 'execution_in_progress' }>;

/**
 * Phase-aware dead-owner recovery outcome.
 *
 * `missing` and `unresolved` are kept apart because a waiter's retry policy turns
 * on the difference. `missing` is read-derived — there is no owner tuple at all —
 * so the next acquisition attempt provably cannot refuse for the same reason.
 * `unresolved` means the exact-tuple CAS matched nothing and this call changed
 * nothing, leaving the obstruction fully intact; retrying it without charge would
 * re-run an identical observation forever.
 */
export type DeadOwnerRecovery =
  | { readonly kind: 'reclaimed_pre_effect'; readonly cleared: ClearedAttemptRef }
  | { readonly kind: 'recovery_pending'; readonly runId: RunId; readonly epoch: ExecutionEpoch }
  | { readonly kind: 'alive'; readonly runId: RunId; readonly ownerPid: number }
  | { readonly kind: 'missing'; readonly runId: RunId }
  | { readonly kind: 'unresolved'; readonly runId: RunId };

/** Execution ownership operations. */
export interface ExecutionLeaseService {
  /**
   * Acquire execution ownership. `wait` omitted → refusal after one dead-owner
   * probe (the default); provided → finite retry outside SQLite.
   *
   * @param captured - Authority captured before the effect.
   * @param ownerPid - Acquiring process id.
   * @param wait - Optional finite wait policy.
   * @returns The acquired attempt, or a typed refusal.
   */
  acquire(
    captured: CapturedAuthority,
    ownerPid: number,
    wait?: LeaseWaitPolicy,
  ): Promise<GuardedMutationResult<ExecutionAttempt>>;
  /**
   * Move the exact owned attempt from `claimed` to `effect_started`.
   *
   * @param attempt - The owned attempt.
   * @returns The effect-started attempt, or a typed refusal on lost ownership.
   */
  markEffectStarted(attempt: ExecutionAttempt): Promise<GuardedMutationResult<ExecutionAttempt>>;
  /**
   * Move an owned run set from `claimed` to `effect_started` atomically.
   *
   * @param attempts - The exact attempts acquired for one aggregate workflow.
   * @returns Every marked attempt, or a refusal with no attempt changed.
   */
  markEffectStartedAll(
    attempts: readonly ExecutionAttempt[],
  ): Promise<GuardedMutationResult<readonly ExecutionAttempt[]>>;
  /**
   * Best-effort release of exact attempts that never crossed the effect boundary.
   *
   * @param attempts - Claimed attempts to clear when still owned exactly.
   * @returns A promise resolving after every still-matching attempt is cleared.
   */
  releaseClaimed(attempts: readonly ExecutionAttempt[]): Promise<void>;
  /**
   * Release one exact effect-started attempt after a provably write-free commit
   * refusal.
   *
   * This is deliberately narrower than {@link abandonToRecovery}: callers may
   * use it only when the decisive commit guard ran before its first write, so the
   * attempt has a known non-durable outcome rather than an ambiguous one.
   *
   * @param attempt - Exact effect-started attempt to close and disown.
   * @returns A promise resolving once the matching attempt is released, or when
   *   it no longer owns the run.
   */
  releaseEffectStarted(attempt: ExecutionAttempt): Promise<void>;
  /**
   * Abandon this process's own `effect_started` attempt to `recovery_pending`
   * after a mid-effect failure whose external outcome is unknown.
   *
   * Unlike {@link recoverDeadOwner}, no liveness check runs: the caller holds the
   * attempt and has already decided the effect outcome is ambiguous. The run stays
   * owned (its `exec_*` columns are untouched) so it remains blocked until
   * {@link RunbookStore.commitRecovery} clears ownership. Recording recovery is
   * strictly preferred over re-running the effect.
   *
   * @param attempt - The `effect_started` attempt this process owns.
   * @param reason - The recovery cause to record.
   * @returns `recovery_required` on success, or `execution_in_progress` when the
   *   attempt was already moved by another actor.
   */
  abandonToRecovery(
    attempt: ExecutionAttempt,
    reason: ExecutionRecoveryReason,
  ): Promise<AbandonedAttemptOutcome>;
  /**
   * Move an aggregate workflow's exact attempts to `recovery_pending` atomically.
   *
   * @param attempts - The effect-started attempts owned by the workflow.
   * @param reason - Closed recovery cause recorded on every attempt.
   * @returns Every exact recovery identity, or a refusal with no attempt changed.
   */
  abandonAllToRecovery(
    attempts: readonly ExecutionAttempt[],
    reason: ExecutionRecoveryReason,
  ): Promise<AbandonedAttemptSetOutcome>;
  /**
   * Recover a run whose owner may be dead, using out-of-SQLite liveness and
   * exact-tuple CAS.
   *
   * Liveness compares the recorded `(exec_pid, exec_start_id)` against the host's
   * view of that pid now, so a pid the kernel has since recycled reads as dead
   * rather than as the original owner. A lease carrying no start id — written on
   * a host that cannot supply one — falls back to the pid-only decision.
   *
   * @param runId - Run to inspect.
   * @returns The recovery outcome.
   */
  recoverDeadOwner(runId: RunId): Promise<DeadOwnerRecovery>;
  /**
   * Acquire ownership of several runs all-or-none in one short transaction.
   *
   * @param captured - Captured authority for each affected run.
   * @param ownerPid - Acquiring process id.
   * @param wait - Optional finite wait policy.
   * @returns All acquired attempts, or a typed refusal (with nothing acquired).
   */
  acquireAll(
    captured: readonly CapturedAuthority[],
    ownerPid: number,
    wait?: LeaseWaitPolicy,
  ): Promise<GuardedMutationResult<readonly ExecutionAttempt[]>>;
}

/** Owner identity read for liveness evaluation. */
interface OwnerRow {
  readonly present: boolean;
  readonly execPid: number | null;
  readonly execTokenHash: string | null;
  readonly execEpoch: number | null;
  /** Host start id recorded with the pid; `null` on a host that has none. */
  readonly execStartId: string | null;
  readonly phase: ExecutionPhase | null;
}

/** Thrown inside an all-or-none transaction to roll back on the first refusal. */
class AllOrNoneRefusal extends Error {
  constructor(readonly refusal: GuardedMutationResult<never>) {
    super('all-or-none acquisition refused');
    this.name = 'AllOrNoneRefusal';
  }
}

/**
 * SQLite-backed {@link ExecutionLeaseService}.
 */
export class SqliteExecutionLeaseService implements ExecutionLeaseService {
  /**
   * Construct the lease service.
   *
   * @param driver - Capability-selected SQL driver.
   * @param onWaitProgress - Optional progress callback for contended waits.
   * @param clock - Time source for the contended-wait loop; defaults to real time.
   * @param identity - Process start-identity source used to disambiguate a
   *   reused owner pid. Defaults to the process-wide identity, NOT a fresh one:
   *   this class is constructed per mutation, and a per-instance memo would pay
   *   the BSD `ps` spawn on every acquisition.
   */
  constructor(
    private readonly driver: SqlDriver,
    private readonly onWaitProgress?: (progress: LeaseWaitProgress) => void,
    private readonly clock: LeaseWaitClock = createDefaultLeaseWaitClock(),
    private readonly identity: ProcessIdentity = sharedProcessIdentity(),
  ) {}

  async acquire(
    captured: CapturedAuthority,
    ownerPid: number,
    wait?: LeaseWaitPolicy,
  ): Promise<GuardedMutationResult<ExecutionAttempt>> {
    return this.withWait(wait, () => this.acquireOnce(captured, ownerPid));
  }

  async markEffectStarted(
    attempt: ExecutionAttempt,
  ): Promise<GuardedMutationResult<ExecutionAttempt>> {
    const hash = hashExecutionToken(attempt.token);
    const now = new Date().toISOString();
    return this.driver.immediate((tx) => {
      const changes = tx
        .prepare(
          `UPDATE execution_attempts
              SET phase = 'effect_started', effect_started_at = :now
            WHERE run_id = :runId AND exec_epoch = :epoch
              AND exec_token = :hash AND phase = 'claimed'
              AND EXISTS (
                SELECT 1 FROM runs
                 WHERE id = :runId AND exec_token = :hash AND exec_epoch = :epoch
              )`,
        )
        .run({ now, runId: attempt.runId, epoch: attempt.epoch, hash }).changes;
      if (changes !== 1) {
        return {
          kind: 'execution_in_progress',
          runId: attempt.runId,
          message: `Lost execution ownership of run ${attempt.runId} before the effect boundary.`,
        };
      }
      return { kind: 'committed', value: { ...attempt, phase: 'effect_started' } };
    });
  }

  async markEffectStartedAll(
    attempts: readonly ExecutionAttempt[],
  ): Promise<GuardedMutationResult<readonly ExecutionAttempt[]>> {
    if (attempts.length === 0) {
      return { kind: 'committed', value: [] };
    }
    const now = new Date().toISOString();
    try {
      const marked = await this.driver.immediate((tx) => {
        const result: ExecutionAttempt[] = [];
        for (const attempt of attempts) {
          const hash = hashExecutionToken(attempt.token);
          const changes = tx
            .prepare(
              `UPDATE execution_attempts
                  SET phase = 'effect_started', effect_started_at = :now
                WHERE run_id = :runId AND exec_epoch = :epoch
                  AND exec_token = :hash AND phase = 'claimed'
                  AND EXISTS (
                    SELECT 1 FROM runs
                     WHERE id = :runId AND exec_token = :hash AND exec_epoch = :epoch
                  )`,
            )
            .run({ now, runId: attempt.runId, epoch: attempt.epoch, hash }).changes;
          if (changes !== 1) {
            throw new AllOrNoneRefusal({
              kind: 'execution_in_progress',
              runId: attempt.runId,
              message: `Lost execution ownership of run ${attempt.runId} before the aggregate effect boundary.`,
            });
          }
          result.push({ ...attempt, phase: 'effect_started' });
        }
        return result;
      });
      return { kind: 'committed', value: marked };
    } catch (err) {
      if (err instanceof AllOrNoneRefusal) return err.refusal;
      throw err;
    }
  }

  async abandonToRecovery(
    attempt: ExecutionAttempt,
    reason: ExecutionRecoveryReason,
  ): Promise<AbandonedAttemptOutcome> {
    const hash = hashExecutionToken(attempt.token);
    return this.driver.immediate((tx) => {
      const changes = tx
        .prepare(
          `UPDATE execution_attempts
              SET phase = 'recovery_pending', reason = COALESCE(reason, :reason)
            WHERE run_id = :runId AND exec_epoch = :epoch
              AND exec_token = :hash AND phase = 'effect_started'`,
        )
        .run({ reason, runId: attempt.runId, epoch: attempt.epoch, hash }).changes;
      if (changes !== 1) {
        return {
          kind: 'execution_in_progress',
          runId: attempt.runId,
          message: `The interrupted attempt for run ${attempt.runId} was no longer effect-started.`,
        };
      }
      return {
        kind: 'recovery_required',
        runId: attempt.runId,
        epoch: attempt.epoch,
        message: `Run ${attempt.runId} needs recovery: its execution outcome is unknown after a mid-effect failure.`,
      };
    });
  }

  async releaseClaimed(attempts: readonly ExecutionAttempt[]): Promise<void> {
    if (attempts.length === 0) return;
    const finishedAt = new Date().toISOString();
    await this.driver.immediate((tx) => {
      for (const attempt of attempts) {
        const hash = hashExecutionToken(attempt.token);
        const cleared = tx
          .prepare(
            `UPDATE runs
                SET exec_pid = NULL, exec_token = NULL, exec_epoch = NULL, exec_start_id = NULL
              WHERE id = :runId AND exec_pid = :ownerPid
                AND exec_token = :hash AND exec_epoch = :epoch
                AND EXISTS (
                  SELECT 1 FROM execution_attempts
                   WHERE run_id = :runId AND exec_epoch = :epoch
                     AND exec_token = :hash AND phase = 'claimed'
                )`,
          )
          .run({
            runId: attempt.runId,
            ownerPid: attempt.ownerPid,
            hash,
            epoch: attempt.epoch,
          }).changes;
        if (cleared === 0) continue;
        // 'released', not 'committed': this attempt never crossed the effect
        // boundary and wrote no state, so it must not satisfy the durable-commit
        // probe. `reason` is left alone — it is a closed recovery-reason union
        // (see `validateReason`) and a release is not a recovery.
        const closed = tx
          .prepare(
            `UPDATE execution_attempts
                SET phase = 'released', finished_at = :finishedAt
              WHERE run_id = :runId AND exec_epoch = :epoch
                AND exec_token = :hash AND phase = 'claimed'`,
          )
          .run({ finishedAt, runId: attempt.runId, epoch: attempt.epoch, hash }).changes;
        assertExactlyOneRow(closed, attempt.runId);
      }
    });
  }

  async releaseEffectStarted(attempt: ExecutionAttempt): Promise<void> {
    const hash = hashExecutionToken(attempt.token);
    const finishedAt = new Date().toISOString();
    await this.driver.immediate((tx) => {
      const cleared = tx
        .prepare(
          `UPDATE runs
              SET exec_pid = NULL, exec_token = NULL, exec_epoch = NULL, exec_start_id = NULL
            WHERE id = :runId AND exec_pid = :ownerPid
              AND exec_token = :hash AND exec_epoch = :epoch
              AND EXISTS (
                SELECT 1 FROM execution_attempts
                 WHERE run_id = :runId AND exec_epoch = :epoch
                   AND exec_token = :hash AND phase = 'effect_started'
              )`,
        )
        .run({
          runId: attempt.runId,
          ownerPid: attempt.ownerPid,
          hash,
          epoch: attempt.epoch,
        }).changes;
      if (cleared === 0) return;
      const closed = tx
        .prepare(
          `UPDATE execution_attempts
              SET phase = 'released', finished_at = :finishedAt
            WHERE run_id = :runId AND exec_epoch = :epoch
              AND exec_token = :hash AND phase = 'effect_started'`,
        )
        .run({ finishedAt, runId: attempt.runId, epoch: attempt.epoch, hash }).changes;
      assertExactlyOneRow(closed, attempt.runId);
    });
  }

  async abandonAllToRecovery(
    attempts: readonly ExecutionAttempt[],
    reason: ExecutionRecoveryReason,
  ): Promise<AbandonedAttemptSetOutcome> {
    if (attempts.length === 0) {
      return {
        kind: 'aggregate_recovery_required',
        attempts: [],
        message: 'No attempts require recovery.',
      };
    }
    try {
      const interrupted = await this.driver.immediate((tx) => {
        const result: InterruptedAttemptRef[] = [];
        for (const attempt of attempts) {
          const hash = hashExecutionToken(attempt.token);
          const changes = tx
            .prepare(
              `UPDATE execution_attempts
                  SET phase = 'recovery_pending', reason = COALESCE(reason, :reason)
                WHERE run_id = :runId AND exec_epoch = :epoch
                  AND exec_token = :hash AND phase = 'effect_started'`,
            )
            .run({ reason, runId: attempt.runId, epoch: attempt.epoch, hash }).changes;
          if (changes !== 1) {
            throw new AllOrNoneRefusal({
              kind: 'execution_in_progress',
              runId: attempt.runId,
              message: `The aggregate attempt for run ${attempt.runId} was no longer effect-started.`,
            });
          }
          result.push({ runId: attempt.runId, epoch: attempt.epoch });
        }
        return result;
      });
      return {
        kind: 'aggregate_recovery_required',
        attempts: interrupted,
        message: 'The aggregate execution outcome is unknown and requires recovery.',
      };
    } catch (err) {
      if (err instanceof AllOrNoneRefusal) {
        if (err.refusal.kind !== 'execution_in_progress') {
          throw new Error(`Unexpected aggregate-abandon refusal: ${err.refusal.kind}`);
        }
        return err.refusal;
      }
      throw err;
    }
  }

  async recoverDeadOwner(runId: RunId): Promise<DeadOwnerRecovery> {
    const owner = await this.driver.read((tx) => readOwner(tx, runId));
    if (!owner.present) {
      return { kind: 'missing', runId };
    }
    if (owner.execPid === null || owner.execTokenHash === null || owner.execEpoch === null) {
      // No active owner to recover.
      return { kind: 'missing', runId };
    }
    // Liveness is evaluated OUTSIDE SQLite, then protected by exact-tuple CAS.
    // The recorded start id is what separates "the owner is still running" from
    // "an unrelated process inherited its pid"; absent one, this is the pid-only
    // decision, which errs towards alive.
    if (isOwnerAlive(this.identity, owner.execPid, owner.execStartId)) {
      return { kind: 'alive', runId, ownerPid: owner.execPid };
    }
    const epoch = assertExecutionEpoch(owner.execEpoch);
    if (owner.phase === 'claimed') {
      return this.reclaimPreEffect(runId, owner, epoch);
    }
    return this.markRecoveryPending(runId, owner, epoch);
  }

  async acquireAll(
    captured: readonly CapturedAuthority[],
    ownerPid: number,
    wait?: LeaseWaitPolicy,
  ): Promise<GuardedMutationResult<readonly ExecutionAttempt[]>> {
    const deduped = dedupeByRun(captured);
    if (deduped.length === 0) {
      return { kind: 'committed', value: [] };
    }
    return this.withWait(wait, () => this.acquireAllOnce(deduped, ownerPid));
  }

  /**
   * One all-or-none acquisition transaction.
   *
   * @param captured - Deduplicated captured authorities.
   * @param ownerPid - Acquiring process id.
   * @returns All attempts, or the first refusal (nothing acquired).
   */
  private async acquireAllOnce(
    captured: readonly CapturedAuthority[],
    ownerPid: number,
  ): Promise<GuardedMutationResult<readonly ExecutionAttempt[]>> {
    // Read the owner start id BEFORE opening the transaction: on a BSD host it
    // costs a `ps` spawn, and no write lock may be held across one.
    const startId = this.identity.of(ownerPid);
    try {
      const attempts = await this.driver.immediate((tx) => {
        const acquired: ExecutionAttempt[] = [];
        for (const cap of captured) {
          const result = acquireInTx(tx, cap, ownerPid, startId);
          if (result.kind !== 'committed') {
            throw new AllOrNoneRefusal(result);
          }
          acquired.push(result.value);
        }
        return acquired;
      });
      return { kind: 'committed', value: attempts };
    } catch (err) {
      if (err instanceof AllOrNoneRefusal) {
        return err.refusal;
      }
      throw err;
    }
  }

  /**
   * One acquisition transaction.
   *
   * @param captured - Captured authority.
   * @param ownerPid - Acquiring process id.
   * @returns The attempt, or a typed refusal.
   */
  private acquireOnce(
    captured: CapturedAuthority,
    ownerPid: number,
  ): Promise<GuardedMutationResult<ExecutionAttempt>> {
    // Outside the transaction: see acquireAllOnce.
    const startId = this.identity.of(ownerPid);
    return this.driver.immediate((tx) => acquireInTx(tx, captured, ownerPid, startId));
  }

  /**
   * Clear a dead pre-effect owner's exact tuple.
   *
   * @param runId - Run to reclaim.
   * @param owner - Observed owner identity.
   * @param epoch - Observed epoch.
   * @returns The recovery outcome.
   */
  private async reclaimPreEffect(
    runId: RunId,
    owner: OwnerRow,
    epoch: ExecutionEpoch,
  ): Promise<DeadOwnerRecovery> {
    const finishedAt = new Date().toISOString();
    const changes = await this.driver.immediate((tx) => {
      const cleared = tx
        .prepare(
          `UPDATE runs
              SET exec_pid = NULL, exec_token = NULL, exec_epoch = NULL, exec_start_id = NULL
            WHERE id = :runId AND exec_pid = :pid AND exec_token = :hash AND exec_epoch = :epoch
              AND EXISTS (
                SELECT 1 FROM execution_attempts
                 WHERE run_id = :runId AND exec_epoch = :epoch
                   AND exec_token = :hash AND phase = 'claimed'
              )`,
        )
        .run({ runId, pid: owner.execPid, hash: owner.execTokenHash, epoch }).changes;
      if (cleared === 0) return 0;
      const closed = tx
        .prepare(
          `UPDATE execution_attempts
              SET phase = 'released', finished_at = :finishedAt
            WHERE run_id = :runId AND exec_epoch = :epoch
              AND exec_token = :hash AND phase = 'claimed'`,
        )
        .run({ finishedAt, runId, epoch, hash: owner.execTokenHash }).changes;
      assertExactlyOneRow(closed, runId);
      return cleared;
    });
    if (changes !== 1) {
      // Another process reclaimed or reissued the lease between the read and the
      // CAS; do not steal a newer lease.
      return { kind: 'alive', runId, ownerPid: owner.execPid ?? -1 };
    }
    return {
      kind: 'reclaimed_pre_effect',
      cleared: { runId, epoch, ownerPid: owner.execPid ?? -1 },
    };
  }

  /**
   * Move a dead effect-started (or already-pending) attempt to `recovery_pending`.
   *
   * @param runId - Run needing recovery.
   * @param owner - Observed owner identity.
   * @param epoch - Observed epoch.
   * @returns `recovery_pending` when the exact-tuple CAS moved the attempt, else
   *   `unresolved` — the observed attempt has left the recoverable phases while
   *   the run still names an owner, so nothing was changed here.
   */
  private async markRecoveryPending(
    runId: RunId,
    owner: OwnerRow,
    epoch: ExecutionEpoch,
  ): Promise<DeadOwnerRecovery> {
    const changes = await this.driver.immediate(
      (tx) =>
        tx
          .prepare(
            `UPDATE execution_attempts
                SET phase = 'recovery_pending', reason = COALESCE(reason, 'owner_dead')
              WHERE run_id = :runId AND exec_epoch = :epoch AND exec_token = :hash
                AND phase IN ('effect_started', 'recovery_pending')`,
          )
          .run({ runId, epoch, hash: owner.execTokenHash }).changes,
    );
    if (changes !== 1) {
      // The observed attempt left the recoverable phases without releasing the
      // run, so nothing here changed and the run still names an owner. This is
      // NOT absence: reporting it as such would license a free retry against a
      // row this call did not touch. Mirrors reclaimPreEffect's CAS miss, which
      // is likewise conservative rather than optimistic.
      return { kind: 'unresolved', runId };
    }
    return { kind: 'recovery_pending', runId, epoch };
  }

  /**
   * Run an acquisition thunk, probing for a dead owner before any refusal.
   *
   * Every `execution_in_progress` is owed exactly one dead-owner probe, wait
   * policy or not. Without it, a SIGKILLed owner leaves `runs.exec_token` set
   * forever: every later mutation refuses, and `deleteRun` guards on the same
   * column, so even `rundown prune` cannot clear the run and the only exit is
   * deleting the project database. The probe is what gives that case an
   * in-product exit — a dead pre-effect owner is reclaimed and the acquisition
   * retried, and a dead post-boundary owner surfaces as `recovery_required`,
   * which the runner resolves inline through the machine-owned recovery path.
   *
   * The debt is owed PER RUN, not per call. `acquireAll` acquires a set
   * together, so a killed owner dies holding the set: probing only the first
   * refusal would clear one member, and the retry would then refuse on the next
   * dead member with the debt already spent — leaving the operator to repeat the
   * command once per stranded run to escape a single crash. `probedRuns` records
   * which obstruction was examined, so each distinct one is owed its own probe.
   *
   * A run's FIRST probe is ungated — not by the wait budget, not by the abort
   * signal. It is a correctness step, not a waiting step, and gating it on a
   * budget would make `{ budgetMs: 0 }` strictly worse than supplying no policy
   * at all: the caller who asked to wait least would be the only one left with
   * no exit from a stranded run. Every LATER probe of the SAME run is a retry,
   * and the budget governs those.
   *
   * Each probe is charged to its run, so the loop always terminates: probes are
   * bounded by the number of distinct runs in the call, which `acquireAll`
   * deduplicates and `acquire` fixes at one. In the default (no-policy) mode an
   * unwinnable single run costs two acquisition attempts and one probe. Only a
   * wait policy sleeps.
   *
   * @template T - Attempt payload type.
   * @param wait - Optional wait policy.
   * @param once - The single-attempt acquisition thunk.
   * @returns The acquisition result.
   */
  private async withWait<T>(
    wait: LeaseWaitPolicy | undefined,
    once: () => Promise<GuardedMutationResult<T>>,
  ): Promise<GuardedMutationResult<T>> {
    const deadline = this.clock.now() + (wait?.budgetMs ?? 0);
    let attempts = 0;
    const probedRuns = new Set<RunId>();
    for (;;) {
      const result = await once();
      if (result.kind !== 'execution_in_progress') {
        return result;
      }
      const runId = result.runId;
      if (
        probedRuns.has(runId) &&
        (wait === undefined || wait.signal?.aborted || this.clock.now() >= deadline)
      ) {
        return result;
      }
      const recovery = await this.recoverDeadOwner(runId);
      probedRuns.add(runId);
      if (recovery.kind === 'recovery_pending') {
        return {
          kind: 'recovery_required',
          runId,
          epoch: recovery.epoch,
          message: `Run ${runId} needs recovery before it can be acquired.`,
        };
      }
      // A free retry is licensed only when THIS iteration provably changed the
      // obstruction, or provably observed that there is none. Every other outcome
      // — `alive`, and `unresolved` where the CAS matched nothing — falls through
      // to the charged path below, because repeating an unchanged observation has
      // no exit but the wall clock, and none at all on virtual time.
      if (recovery.kind === 'reclaimed_pre_effect') {
        continue; // The dead lease is cleared; retry immediately.
      }
      if (recovery.kind === 'missing') {
        continue; // No owner tuple at all; the next attempt cannot refuse for it.
      }
      if (wait === undefined) {
        // The obstruction is a live owner (or one this call did not change). The
        // probe has done its job; without a wait policy there is nothing left to
        // do but report the contention that was there all along.
        return result;
      }
      attempts += 1;
      const remainingMs = Math.max(0, deadline - this.clock.now());
      this.onWaitProgress?.({ runId, attempts, remainingMs });
      if (remainingMs === 0) {
        return result;
      }
      const requestedBackoff = Math.max(0, wait.backoff(attempts - 1));
      await this.clock.sleep(Math.min(requestedBackoff, remainingMs), wait.signal);
      if (wait.signal?.aborted || this.clock.now() >= deadline) {
        return result;
      }
    }
  }
}

/**
 * Acquire ownership within an already-open transaction.
 *
 * @param tx - Open writing transaction.
 * @param captured - Captured authority.
 * @param ownerPid - Acquiring process id.
 * @param ownerStartId - Host start id observed for `ownerPid` before this
 *   transaction opened, or `null` on a host that has none.
 * @returns The attempt, or a typed refusal.
 */
function acquireInTx(
  tx: SqlTransaction,
  captured: CapturedAuthority,
  ownerPid: number,
  ownerStartId: string | null,
): GuardedMutationResult<ExecutionAttempt> {
  const row = selectCommitRow(tx, captured.runId, captured.claimKey);
  const classification = classifyCommitRow(row, captured);
  if (classification.kind !== 'ok') {
    return classification;
  }
  const token = generateExecutionToken();
  const hash = hashExecutionToken(token);
  const epoch = nextEpoch(tx, captured.runId);
  const now = new Date().toISOString();
  tx.prepare(
    `INSERT INTO execution_attempts
       (run_id, exec_epoch, exec_token, phase, owner_pid, owner_start_id, started_at)
     VALUES (:runId, :epoch, :hash, 'claimed', :pid, :startId, :now)`,
  ).run({ runId: captured.runId, epoch, hash, pid: ownerPid, startId: ownerStartId, now });
  const changes = tx
    .prepare(
      `UPDATE runs
          SET exec_pid = :pid, exec_token = :hash, exec_epoch = :epoch, exec_start_id = :startId
        WHERE id = :runId
          AND state_version = :stateVersion
          AND claim_generation = :claimGeneration
          AND exec_token IS NULL`,
    )
    .run({
      pid: ownerPid,
      hash,
      epoch,
      startId: ownerStartId,
      runId: captured.runId,
      stateVersion: captured.stateVersion,
      claimGeneration: captured.claimGeneration,
    }).changes;
  assertExactlyOneRow(changes, captured.runId);
  return {
    kind: 'committed',
    value: { runId: captured.runId, token, epoch, ownerPid, phase: 'claimed' },
  };
}

/**
 * Compute the next strictly-increasing, never-reused epoch for a run.
 *
 * @param tx - Open transaction.
 * @param runId - Run whose epoch to advance.
 * @returns The next epoch.
 */
function nextEpoch(tx: SqlTransaction, runId: RunId): ExecutionEpoch {
  const row = tx
    .prepare(
      'SELECT COALESCE(MAX(exec_epoch), 0) + 1 AS next FROM execution_attempts WHERE run_id = :runId',
    )
    .get<{ readonly next: number }>({ runId });
  return assertExecutionEpoch(row?.next ?? 1);
}

/**
 * Read a run's active owner identity and joined attempt phase.
 *
 * @param tx - Open transaction.
 * @param runId - Run to read.
 * @returns The owner row.
 */
function readOwner(tx: SqlReadTransaction, runId: RunId): OwnerRow {
  const row = tx
    .prepare(
      `SELECT r.exec_pid AS exec_pid, r.exec_token AS exec_token, r.exec_epoch AS exec_epoch,
              r.exec_start_id AS exec_start_id, a.phase AS phase
         FROM runs r
         LEFT JOIN execution_attempts a ON a.run_id = r.id AND a.exec_epoch = r.exec_epoch
        WHERE r.id = :runId`,
    )
    .get<{
      readonly exec_pid: number | null;
      readonly exec_token: string | null;
      readonly exec_epoch: number | null;
      readonly exec_start_id: string | null;
      readonly phase: string | null;
    }>({ runId });
  if (row === undefined) {
    return {
      present: false,
      execPid: null,
      execTokenHash: null,
      execEpoch: null,
      execStartId: null,
      phase: null,
    };
  }
  return {
    present: true,
    execPid: row.exec_pid,
    execTokenHash: row.exec_token,
    execEpoch: row.exec_epoch,
    execStartId: row.exec_start_id,
    // Validated at this edge like every other raw row, so the narrowed union
    // names a domain the read establishes rather than one it merely asserts.
    phase: row.phase === null ? null : assertExecutionPhase(row.phase),
  };
}

/**
 * Deduplicate captured authorities by run id, preserving first occurrence.
 *
 * @param captured - Captured authorities.
 * @returns Deduplicated authorities.
 */
function dedupeByRun(captured: readonly CapturedAuthority[]): readonly CapturedAuthority[] {
  const seen = new Set<RunId>();
  const out: CapturedAuthority[] = [];
  for (const cap of captured) {
    if (!seen.has(cap.runId)) {
      seen.add(cap.runId);
      out.push(cap);
    }
  }
  return out;
}

/**
 * Resolve after `ms` milliseconds. Used only between wait retries, never inside a
 * transaction. Backs {@link createDefaultLeaseWaitClock}.
 *
 * `finish` always detaches the abort listener, so `{ once: true }` would be pure
 * redundancy. The unconditional removal is the load-bearing half: one wait loop
 * calls this repeatedly with the SAME long-lived signal, and the common exit is
 * the timer firing, not the abort — leaving that listener attached would
 * accumulate one per retry.
 *
 * @param ms - Delay in milliseconds.
 * @param signal - Optional cancellation signal that resolves the delay early.
 * @returns A promise that resolves after the delay or cancellation.
 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish);

    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
  });
}

export type { ClaimLookupKey, ExecutionPhase };
