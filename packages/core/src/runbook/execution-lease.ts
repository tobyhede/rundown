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
 * - **Interrupted** — that process is gone, so the effect's outcome is unknown.
 *   Rundown never repeats it. A decision that would treat the effect as having
 *   succeeded (`pass`, `complete`) is refused `EXECUTION_INTERRUPTED`; the
 *   owner's explicit decision — `fail` (which takes the step's authored FAIL
 *   handler, including RETRY), `goto`, or `stop` — commits and clears it.
 *
 * @module runbook/execution-lease
 */

import { isOwnerAlive, sharedProcessIdentity, type ProcessIdentity } from './process-identity.js';
import type { RunId } from './run-id.js';

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
 * Decide whether a held lease is In Progress or Interrupted.
 *
 * Liveness is `(pid, start id)`: only a pid with no process, or a recorded and
 * an observed start id that disagree, prove the holder gone. Every unknown
 * reads as alive, so a doubtful lease refuses rather than letting a second
 * attempt run the effect again.
 *
 * @param lease - The lease read from the run row.
 * @param identity - Start-identity source; defaults to the process-wide one.
 * @returns The lease's condition.
 */
export function classifyExecutionLease(
  lease: ExecutionLease,
  identity: ProcessIdentity = sharedProcessIdentity(),
): ExecutionCondition {
  return isOwnerAlive(identity, lease.pid, lease.startId)
    ? { kind: 'in_progress', lease }
    : { kind: 'interrupted', lease };
}

/**
 * The owner's decisions about a run, as the lease rule sees them.
 *
 * `pass` and `complete` would treat an Interrupted effect as having
 * succeeded; `fail`, `goto` and `stop` are the explicit decisions that clear
 * it.
 */
export type LeaseDecision = 'pass' | 'complete' | 'fail' | 'goto' | 'stop';

/** Refusal: a live attempt holds the lease. Nothing was written. */
export interface ExecutionInProgressRefusal {
  readonly kind: 'execution_in_progress';
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
 * Render the step a run rests on, as the refusal names it.
 *
 * @param state - The run's step cursor.
 * @param state.step - Current top-level step.
 * @param state.substep - Current substep, when inside one.
 * @returns `step` or `step.substep`.
 */
function stepLabel(state: { readonly step: string; readonly substep?: string }): string {
  return state.substep === undefined ? state.step : `${state.step}.${state.substep}`;
}

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
  const step = stepLabel(cursor);
  const { lease } = condition;
  if (condition.kind === 'in_progress') {
    return {
      kind: 'execution_in_progress',
      runId,
      step,
      lease,
      message: `Step ${step} of run ${runId} is In Progress: its command started at ${lease.startedAt} in process ${String(lease.pid)} and is still running. Nothing was written. Wait for it to finish, then re-read the run.`,
    };
  }
  return {
    kind: 'execution_interrupted',
    runId,
    step,
    lease,
    message: `Step ${step} of run ${runId} is Interrupted: the process ${String(lease.pid)} that started its command at ${lease.startedAt} is gone, so the command's outcome is unknown. Rundown never repeats it. Decide explicitly: \`rundown fail --step ${step}\` (the step's FAIL handler, including an authored RETRY), \`rundown goto <step>\`, or \`rundown stop\`.`,
  };
}

/**
 * Apply the lease rule to an owner's decision.
 *
 * - No lease: the decision proceeds.
 * - In Progress: every decision is refused.
 * - Interrupted: `pass` and `complete` are refused; `fail`, `goto` and `stop`
 *   proceed, and their state write clears the lease.
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
  const condition = classifyExecutionLease(lease, identity);
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
 * @returns True for `fail`, `goto` and `stop`.
 * @throws {Error} When an unhandled decision is supplied.
 */
function clearsInterruption(decision: LeaseDecision): boolean {
  switch (decision) {
    case 'fail':
    case 'goto':
    case 'stop':
      return true;
    case 'pass':
    case 'complete':
      return false;
    default: {
      const _exhaustive: never = decision;
      throw new Error(`Unsupported lease decision: ${String(_exhaustive)}`);
    }
  }
}
