/**
 * PID-aware execution ownership protocol over the SQLite store.
 *
 * Acquisition installs a fresh {@link ExecutionToken} and a strictly increasing
 * {@link ExecutionEpoch} on a run under the captured claim/state CAS, with the
 * attempt phase `claimed`. The effect boundary moves the exact owned attempt to
 * `effect_started`. Dead-owner recovery evaluates liveness OUTSIDE SQLite (never
 * in a SQL predicate) and then changes only the exact observed
 * `(pid, token, epoch, phase)` tuple: a dead pre-effect owner is reclaimed
 * automatically; a dead effect-started owner becomes `recovery_pending` and is
 * never auto-re-executed.
 *
 * The default contention policy is immediate refusal (`execution_in_progress`).
 * An optional {@link LeaseWaitPolicy} retries the WHOLE short transaction outside
 * SQLite within a finite budget; no transaction or trigger ever waits.
 *
 * @module runbook/storage/execution-lease
 */

import { isProcessAlive } from '../file-lock.js';
import type { RunId } from '../run-id.js';
import type { ExecutionRecoveryReason } from '../types.js';
import type { ClaimLookupKey } from '../claim-id.js';
import type { SqlDriver, SqlReadTransaction, SqlTransaction } from './sql-driver.js';
import {
  selectCommitRow,
  classifyCommitRow,
  assertExactlyOneRow,
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

/** Phase-aware dead-owner recovery outcome. */
export type DeadOwnerRecovery =
  | { readonly kind: 'reclaimed_pre_effect'; readonly cleared: ClearedAttemptRef }
  | { readonly kind: 'recovery_pending'; readonly runId: RunId; readonly epoch: ExecutionEpoch }
  | { readonly kind: 'alive'; readonly runId: RunId; readonly ownerPid: number }
  | { readonly kind: 'missing'; readonly runId: RunId };

/** Execution ownership operations. */
export interface ExecutionLeaseService {
  /**
   * Acquire execution ownership. `wait` omitted → immediate refusal (the
   * default); provided → finite retry outside SQLite.
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
   * Recover a run whose owner may be dead, using out-of-SQLite liveness and
   * exact-tuple CAS.
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
  readonly phase: string | null;
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
   */
  constructor(
    private readonly driver: SqlDriver,
    private readonly onWaitProgress?: (progress: LeaseWaitProgress) => void,
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
    if (isProcessAlive(owner.execPid)) {
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
    try {
      const attempts = await this.driver.immediate((tx) => {
        const acquired: ExecutionAttempt[] = [];
        for (const cap of captured) {
          const result = acquireInTx(tx, cap, ownerPid);
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
    return this.driver.immediate((tx) => acquireInTx(tx, captured, ownerPid));
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
    const changes = await this.driver.immediate(
      (tx) =>
        tx
          .prepare(
            `UPDATE runs
                SET exec_pid = NULL, exec_token = NULL, exec_epoch = NULL, exec_start_id = NULL
              WHERE id = :runId AND exec_pid = :pid AND exec_token = :hash AND exec_epoch = :epoch`,
          )
          .run({ runId, pid: owner.execPid, hash: owner.execTokenHash, epoch }).changes,
    );
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
   * @returns The recovery outcome.
   */
  private async markRecoveryPending(
    runId: RunId,
    owner: OwnerRow,
    epoch: ExecutionEpoch,
  ): Promise<DeadOwnerRecovery> {
    await this.driver.immediate((tx) => {
      tx.prepare(
        `UPDATE execution_attempts
            SET phase = 'recovery_pending', reason = COALESCE(reason, 'owner_dead')
          WHERE run_id = :runId AND exec_epoch = :epoch AND exec_token = :hash
            AND phase IN ('effect_started', 'recovery_pending')`,
      ).run({ runId, epoch, hash: owner.execTokenHash });
    });
    return { kind: 'recovery_pending', runId, epoch };
  }

  /**
   * Run an acquisition thunk with the finite wait policy.
   *
   * On `execution_in_progress` with a wait policy, attempts dead-owner recovery
   * (self-healing a crashed pre-effect owner) and retries within the budget; a
   * run needing recovery surfaces as `recovery_required`.
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
    const deadline = Date.now() + (wait?.budgetMs ?? 0);
    let attempts = 0;
    for (;;) {
      const result = await once();
      if (result.kind !== 'execution_in_progress' || wait === undefined) {
        return result;
      }
      if (wait.signal?.aborted || Date.now() >= deadline) {
        return result;
      }
      const runId = result.runId;
      const recovery = await this.recoverDeadOwner(runId);
      if (recovery.kind === 'recovery_pending') {
        return {
          kind: 'recovery_required',
          runId,
          epoch: recovery.epoch,
          message: `Run ${runId} needs recovery before it can be acquired.`,
        };
      }
      if (recovery.kind === 'reclaimed_pre_effect') {
        continue; // The dead lease is cleared; retry immediately.
      }
      attempts += 1;
      const remainingMs = Math.max(0, deadline - Date.now());
      this.onWaitProgress?.({ runId, attempts, remainingMs });
      if (remainingMs === 0) {
        return result;
      }
      const requestedBackoff = Math.max(0, wait.backoff(attempts - 1));
      await delay(Math.min(requestedBackoff, remainingMs), wait.signal);
      if (wait.signal?.aborted || Date.now() >= deadline) {
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
 * @returns The attempt, or a typed refusal.
 */
function acquireInTx(
  tx: SqlTransaction,
  captured: CapturedAuthority,
  ownerPid: number,
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
       (run_id, exec_epoch, exec_token, phase, owner_pid, started_at)
     VALUES (:runId, :epoch, :hash, 'claimed', :pid, :now)`,
  ).run({ runId: captured.runId, epoch, hash, pid: ownerPid, now });
  const changes = tx
    .prepare(
      `UPDATE runs
          SET exec_pid = :pid, exec_token = :hash, exec_epoch = :epoch
        WHERE id = :runId
          AND state_version = :stateVersion
          AND claim_generation = :claimGeneration
          AND exec_token IS NULL`,
    )
    .run({
      pid: ownerPid,
      hash,
      epoch,
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
              a.phase AS phase
         FROM runs r
         LEFT JOIN execution_attempts a ON a.run_id = r.id AND a.exec_epoch = r.exec_epoch
        WHERE r.id = :runId`,
    )
    .get<{
      readonly exec_pid: number | null;
      readonly exec_token: string | null;
      readonly exec_epoch: number | null;
      readonly phase: string | null;
    }>({ runId });
  if (row === undefined) {
    return { present: false, execPid: null, execTokenHash: null, execEpoch: null, phase: null };
  }
  return {
    present: true,
    execPid: row.exec_pid,
    execTokenHash: row.exec_token,
    execEpoch: row.exec_epoch,
    phase: row.phase,
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
 * transaction.
 *
 * @param ms - Delay in milliseconds.
 * @param signal - Optional cancellation signal that resolves the delay early.
 * @returns A promise that resolves after the delay or cancellation.
 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });

    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
  });
}

export type { ClaimLookupKey, ExecutionPhase };
