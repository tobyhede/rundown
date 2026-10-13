/**
 * The execution lease (#902, ADR 0005): one started marker per run.
 *
 * Run Progression sets a lease on the run row by one conditional update
 * immediately before an external effect (a command execution, together with
 * the helper evaluation of its OUTPUTS) and the state write that commits the
 * effect's finish clears it. The lease is run-row data, never machine context
 * and never a file lock.
 *
 * Setting the lease moves the row's `state_version`, and the lease's `attempt`
 * IS the version it moved to. So "the finish commits only if its attempt still
 * holds" is the ordinary conditional save at `state_version = attempt`, and any
 * command that read the run before the lease was set is refused
 * `CONCURRENT_MODIFICATION` when it writes. Nothing here retries.
 *
 * A held lease is one of two {@link ExecutionCondition}s, decided by
 * `(pid, start id)` liveness through the process-identity module:
 *
 * - **In Progress** — the process that started the effect is alive. Every
 *   mutation of the run is refused `EXECUTION_IN_PROGRESS`.
 * - **Interrupted** — that process is gone, or it is THIS process and no
 *   attempt of this process still holds the lease (its turn ended without
 *   committing a finish), so the effect's outcome is unknown.
 *   Rundown never repeats it. A decision that would treat the effect as having
 *   succeeded (`pass`, `complete`) is refused `EXECUTION_INTERRUPTED`; the
 *   owner's explicit decision — `fail` (which takes the step's authored FAIL
 *   handler, including RETRY), `goto`, or `stop` — commits and clears it, and
 *   `prune` deletes the run together with its lease.
 *
 * @module runbook/execution-lease
 */

import { isOwnerAlive, sharedProcessIdentity, type ProcessIdentity } from './process-identity.js';
import type { RunId } from './run-id.js';
import { deriveExecutionAt } from './targeting.js';

/** Symbolic refusal code for a mutation attempted while a live attempt holds the lease. */
export const EXECUTION_IN_PROGRESS_CODE = 'EXECUTION_IN_PROGRESS';

/** Symbolic refusal code for a mutation that would treat an Interrupted attempt as passed. */
export const EXECUTION_INTERRUPTED_CODE = 'EXECUTION_INTERRUPTED';

/** The lease columns of one run row, all present together. */
export interface ExecutionLease {
  /** The `state_version` the lease set produced; the finish commits only at it. */
  readonly attempt: number;
  /** Process that started the effect. */
  readonly pid: number;
  /** That process's start identity, or null where the host supplies none. */
  readonly startId: string | null;
  /** ISO-8601 time the lease was set. */
  readonly startedAt: string;
}

/** The process that is about to start an effect, as the lease records it. */
export interface ExecutionLeaseHolder {
  /** Holder pid. */
  readonly pid: number;
  /** Holder start identity, or null where the host supplies none. */
  readonly startId: string | null;
}

/** What a held lease means right now. */
export type ExecutionCondition =
  | { readonly kind: 'in_progress'; readonly lease: ExecutionLease }
  | { readonly kind: 'interrupted'; readonly lease: ExecutionLease };

/**
 * Describe this process as a lease holder.
 *
 * @param identity - Start-identity source; defaults to the process-wide one.
 * @returns This process's pid and start identity.
 */
export function currentLeaseHolder(
  identity: ProcessIdentity = sharedProcessIdentity(),
): ExecutionLeaseHolder {
  return { pid: process.pid, startId: identity.of(process.pid) };
}

/**
 * The attempts this process is running right now, keyed by run and attempt.
 *
 * Process-local by design: `(pid, start id)` liveness cannot tell a live
 * attempt from a dead one when the holder is this very process — a long-lived
 * host whose turn ended without committing its finish would otherwise read
 * In Progress until it exits. This set is the only place that knows, and it
 * is never persisted.
 */
const inFlightAttempts = new Set<string>();

/**
 * Key one attempt of one run.
 *
 * @param runId - The run.
 * @param attempt - The lease's attempt (the `state_version` its set produced).
 * @returns The registry key.
 */
function inFlightKey(runId: RunId, attempt: number): string {
  return `${runId}#${String(attempt)}`;
}

/**
 * Record that this process is running the attempt a lease it just set names,
 * until the returned handle is disposed.
 *
 * Run Progression holds this for exactly the command turn — from the lease
 * set until the turn returns or throws — with `using`, so every exit path
 * releases it. While held, {@link classifyExecutionLease} reads the lease In
 * Progress; once released, a lease still set by this process reads
 * Interrupted.
 *
 * @param runId - The run whose lease this process set.
 * @param lease - The lease the set produced.
 * @returns A handle whose disposal ends the attempt's registration.
 */
export function holdInFlightAttempt(runId: RunId, lease: ExecutionLease): Disposable {
  const key = inFlightKey(runId, lease.attempt);
  inFlightAttempts.add(key);
  return {
    [Symbol.dispose]() {
      inFlightAttempts.delete(key);
    },
  };
}

/**
 * Decide whether a held lease is In Progress or Interrupted.
 *
 * For a lease another process set, liveness is `(pid, start id)`: only a pid
 * with no process, or a recorded and an observed start id that disagree, prove
 * the holder gone. Every unknown reads as alive, so a doubtful lease refuses
 * rather than letting a second attempt run the effect again.
 *
 * For a lease whose pid is this process's, this process answers for itself:
 * the lease is In Progress only while one of its turns holds the attempt
 * ({@link holdInFlightAttempt}). Otherwise the turn that set it has ended
 * without committing — or an earlier process with a recycled pid set it — and
 * either way the effect's outcome is unknown: Interrupted.
 *
 * @param runId - The run the lease is on.
 * @param lease - The lease read from the run row.
 * @param identity - Start-identity source; defaults to the process-wide one.
 * @returns The lease's condition.
 */
export function classifyExecutionLease(
  runId: RunId,
  lease: ExecutionLease,
  identity: ProcessIdentity = sharedProcessIdentity(),
): ExecutionCondition {
  if (lease.pid === process.pid) {
    return inFlightAttempts.has(inFlightKey(runId, lease.attempt))
      ? { kind: 'in_progress', lease }
      : { kind: 'interrupted', lease };
  }
  return isOwnerAlive(identity, lease.pid, lease.startId)
    ? { kind: 'in_progress', lease }
    : { kind: 'interrupted', lease };
}

/**
 * The owner's decisions about a run, as the lease rule sees them.
 *
 * `pass` and `complete` would treat an Interrupted effect as having
 * succeeded; `fail`, `goto` and `stop` are the explicit decisions that clear
 * it. `prune` deletes the run: while In Progress that would erase the record
 * of an effect still running (its finish would find no row), so it is refused
 * like every other decision; once Interrupted no process will write the run
 * again, so deleting it is the owner's explicit decision to discard the
 * unknown outcome, as `stop` is. `collect` (#904) applies Delegations' Child
 * Results to the run; like `pass` it never clears an Interrupted effect.
 */
export type LeaseDecision =
  | 'pass'
  | 'complete'
  | 'fail'
  | 'goto'
  | 'stop'
  | 'prune'
  | 'collect'
  | 'retry'
  | 'release';

/** Refusal: a live attempt holds the lease. Nothing was written. */
export interface ExecutionInProgressRefusal {
  readonly kind: 'execution_in_progress';
  /** The symbolic refusal code. */
  readonly code: typeof EXECUTION_IN_PROGRESS_CODE;
  /** The run whose step is In Progress. */
  readonly runId: RunId;
  /** The step (`step` or `step.substep`) whose effect is running. */
  readonly step: string;
  /** The held lease. */
  readonly lease: ExecutionLease;
  /** Operator-facing message. */
  readonly message: string;
}

/** Refusal: the attempt holding the lease died and the decision would pass it. */
export interface ExecutionInterruptedRefusal {
  readonly kind: 'execution_interrupted';
  /** The symbolic refusal code. */
  readonly code: typeof EXECUTION_INTERRUPTED_CODE;
  /** The run whose step is Interrupted. */
  readonly runId: RunId;
  /** The step (`step` or `step.substep`) whose effect was interrupted. */
  readonly step: string;
  /** The orphaned lease. */
  readonly lease: ExecutionLease;
  /** Operator-facing message naming the decisions that clear it. */
  readonly message: string;
}

/** Either lease refusal. */
export type ExecutionLeaseRefusal = ExecutionInProgressRefusal | ExecutionInterruptedRefusal;

/**
 * Build the refusal for a held lease's condition.
 *
 * @param runId - The run whose lease is held.
 * @param cursor - The run's step cursor (the lease pins it: no write lands while held).
 * @param cursor.step - Current top-level step.
 * @param cursor.substep - Current substep, when inside one.
 * @param condition - The lease's classified condition.
 * @returns The typed refusal with its operator-facing message.
 */
export function executionLeaseRefusal(
  runId: RunId,
  cursor: { readonly step: string; readonly substep?: string },
  condition: ExecutionCondition,
): ExecutionLeaseRefusal {
  // The same label `status` shows for the run's position.
  const step = deriveExecutionAt(cursor.step, cursor.substep);
  const { lease } = condition;
  if (condition.kind === 'in_progress') {
    return {
      kind: 'execution_in_progress',
      code: EXECUTION_IN_PROGRESS_CODE,
      runId,
      step,
      lease,
      message: `Step ${step} of run ${runId} is In Progress: its command started at ${lease.startedAt} in process ${String(lease.pid)} and is still running. Nothing was written. Wait for it to finish, then re-read the run.`,
    };
  }
  return {
    kind: 'execution_interrupted',
    code: EXECUTION_INTERRUPTED_CODE,
    runId,
    step,
    lease,
    message: `Step ${step} of run ${runId} is Interrupted: the process ${String(lease.pid)} that started its command at ${lease.startedAt} is gone, so the command's outcome is unknown. Rundown never repeats it. Decide explicitly: \`rundown fail --step ${step} --token <owner_token>\` (the step's FAIL handler, including an authored RETRY), \`rundown goto <step> --token <owner_token>\`, or \`rundown stop --token <owner_token>\`.`,
  };
}

/**
 * The operator-facing message for a command whose finish could not be
 * derived after it ran (Run Progression's `command_outcome_unknown`).
 *
 * The lease stays set and the attempt is no longer in flight, so the step now
 * reads Interrupted; the message names the same explicit decisions the
 * Interrupted refusal does.
 *
 * @param runId - The run whose command finish failed.
 * @param cursor - The run's step cursor (the lease pins it).
 * @param cursor.step - Current top-level step.
 * @param cursor.substep - Current substep, when inside one.
 * @param cause - What stopped the finish (the machine-effect timeout or the actor error).
 * @returns The message.
 */
export function commandOutcomeUnknownMessage(
  runId: RunId,
  cursor: { readonly step: string; readonly substep?: string },
  cause: string,
): string {
  const step = deriveExecutionAt(cursor.step, cursor.substep);
  return `Step ${step} of run ${runId} is Interrupted: its command ran, but its finish could not be recorded (${cause}), so the command's outcome is unknown. Rundown never repeats it. Decide explicitly: \`rundown fail --step ${step} --token <owner_token>\` (the step's FAIL handler, including an authored RETRY), \`rundown goto <step> --token <owner_token>\`, or \`rundown stop --token <owner_token>\`.`;
}

/**
 * Apply the lease rule to an owner's decision.
 *
 * - No lease: the decision proceeds.
 * - In Progress: every decision is refused.
 * - Interrupted: `pass` and `complete` are refused; `fail`, `goto` and `stop`
 *   proceed, and their state write clears the lease; `prune` proceeds and its
 *   delete removes the lease with the row.
 *
 * @param runId - The run being decided about.
 * @param cursor - The run's step cursor.
 * @param cursor.step - Current top-level step.
 * @param cursor.substep - Current substep, when inside one.
 * @param lease - The lease read with the run, or null.
 * @param decision - The owner's decision.
 * @param identity - Start-identity source; defaults to the process-wide one.
 * @returns The refusal, or `undefined` when the decision proceeds.
 */
export function refuseUnderLease(
  runId: RunId,
  cursor: { readonly step: string; readonly substep?: string },
  lease: ExecutionLease | null,
  decision: LeaseDecision,
  identity: ProcessIdentity = sharedProcessIdentity(),
): ExecutionLeaseRefusal | undefined {
  if (lease === null) return undefined;
  const condition = classifyExecutionLease(runId, lease, identity);
  if (condition.kind === 'interrupted' && clearsInterruption(decision)) return undefined;
  return executionLeaseRefusal(runId, cursor, condition);
}

/**
 * Whether a decision is an explicit resolution of an Interrupted attempt.
 *
 * Exhaustive with a `never` fallthrough so a new decision cannot silently
 * clear an interruption.
 *
 * @param decision - The owner's decision.
 * @returns True for `fail`, `goto`, `stop`, `prune` and `release`.
 * @throws {Error} When an unhandled decision is supplied.
 */
function clearsInterruption(decision: LeaseDecision): boolean {
  switch (decision) {
    case 'fail':
    case 'goto':
    case 'stop':
    case 'prune':
    // `release` ends a Delegation abandoned (#905): an explicit decision, like
    // `stop`, that nobody will learn the attempt's result.
    case 'release':
      return true;
    case 'pass':
    case 'complete':
    // `collect` applies a Child Result to the cursor's unit: like `pass`, it
    // would record an outcome over an attempt whose result nobody knows.
    case 'collect':
    // `retry` replaces a Delegation and leaves the interrupted unit undecided.
    case 'retry':
      return false;
    default: {
      const _exhaustive: never = decision;
      throw new Error(`Unsupported lease decision: ${String(_exhaustive)}`);
    }
  }
}
