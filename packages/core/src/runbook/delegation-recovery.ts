/**
 * Recovering a Delegation (#905, ADR 0005): `rundown retry` by the parent's
 * owner, and `rundown release` by the agent that claimed the child.
 *
 * - {@link retryDelegation} — the parent owner cancels the Current Child of
 *   one delegated substep and reserves a fresh one in its place, issued a new
 *   Claim Ticket, through the machine (`RETRY_DELEGATION`) in one conditional
 *   save. The new ticket is returned once, to be printed once; only its hash
 *   is stored. A lost ticket, an unclaimed child, or a child whose Owner Token
 *   its sub-agent lost is recovered this way — there is no re-claim and no
 *   re-reveal. The cancelled child's commands and its ticket are refused
 *   `DELEGATION_CANCELLED`; the parent never writes the child.
 * - {@link releaseDelegation} — a sub-agent that cannot finish its child ends
 *   it `abandoned`, through the machine (`ABANDON`) in one conditional save of
 *   the child's own row. Its authority is the agent id `rundown claim`
 *   recorded (both absent match), never an Owner Token, and it grants nothing
 *   else: it never touches the parent, whose Collect reads an abandoned child
 *   as a fail.
 *
 * @module runbook/delegation-recovery
 */

import type { StepEnteredChild } from '../events/types.js';
import {
  activeEntryDelegations,
  delegatedRunbookOf,
  retryableDelegation,
} from './delegation-child.js';
import type { DelegationDeps, DelegationRefusal } from './delegation-progression.js';
import { refuseUnderLease, type ExecutionLeaseRefusal } from './execution-lease.js';
import type { ProcessIdentity } from './process-identity.js';
import type { FinishedLifecycle, OwnedRun } from './run-authority.js';
import type { RunId } from './run-id.js';
import { generateClaimTicket, hashRunSecret, type ClaimTicket } from './run-secrets.js';
import {
  resolveRetryTarget,
  type ExplicitTransitionTarget,
  type InvalidStepTargetRefusal,
} from './transition-cursor.js';

/** `retry` named a substep with no Delegation its parent still counts. */
export const NOTHING_TO_RETRY_CODE = 'NOTHING_TO_RETRY';
/** `release` by an agent other than the one recorded at claim. */
export const AGENT_MISMATCH_CODE = 'AGENT_MISMATCH';
/** `release` of a run that is not a Delegation. */
export const NOT_A_DELEGATION_CODE = 'NOT_A_DELEGATION';
/** `release` of a run id no run carries. */
export const RUN_TARGET_UNAVAILABLE_CODE = 'RUN_TARGET_UNAVAILABLE';

/** Services Delegation recovery drives. */
export type DelegationRecoveryDeps = DelegationDeps & {
  /** Start-identity source for classifying a held execution lease. */
  readonly processIdentity?: ProcessIdentity;
};

/** Refusal: the row moved between this command's read and its save. Never retried. */
export interface RecoveryConcurrentModification {
  readonly kind: 'concurrent_modification';
  /** The run whose save was refused. */
  readonly runId: RunId;
  /** Operator-facing message. */
  readonly message: string;
}

/** The fresh child a retry reserved, with the Claim Ticket printed once. */
export interface RetriedChild extends StepEnteredChild {
  /** The new Claim Ticket. Never stored; printed once, by the retry. */
  readonly ticket: ClaimTicket;
}

/** Outcome of {@link retryDelegation}. */
export type RetryDelegationOutcome =
  | ExecutionLeaseRefusal
  | InvalidStepTargetRefusal
  | DelegationRefusal
  | RecoveryConcurrentModification
  | {
      /** The run was pruned between token resolution and the save. */
      readonly kind: 'unknown_token';
    }
  | {
      readonly kind: 'retried';
      /** The run retried in: the parent. */
      readonly runId: RunId;
      /** The child the retry cancelled. */
      readonly cancelledRunId: RunId;
      /** The fresh child, with its new ticket. */
      readonly child: RetriedChild;
    };

/**
 * Cancel the Current Child of one delegated substep and reserve a fresh one.
 *
 * In order: refuse under a live or Interrupted execution lease; confirm
 * `--step` / `--index` names a substep of the current step at the current
 * iteration; refuse a substep that delegates nothing, or whose Delegation the
 * parent no longer counts (Collected, or decided); then send
 * `RETRY_DELEGATION` with the new ticket's hash and commit it with one
 * conditional save at the version the run was read at. A version that moved
 * is refused, never retried, and the minted ticket is discarded unprinted.
 *
 * @param deps - Store, actor service, graph loader and process identity.
 * @param run - The run resolved from the owner's token, with its version.
 * @param target - The raw `--step` / `--index`, or `undefined` without `--step`.
 * @returns The fresh child with its ticket, or a refusal. Nothing is written
 *   on a refusal.
 * @throws {Error} When the committed state does not carry the fresh
 *   reservation — the machine's guard refused what this module derived from
 *   the same state, which is a defect, not a race.
 */
export async function retryDelegation(
  deps: DelegationRecoveryDeps,
  run: OwnedRun,
  target: ExplicitTransitionTarget | undefined,
): Promise<RetryDelegationOutcome> {
  const { state } = run;
  const leased = refuseUnderLease(state.id, state, run.lease, 'retry', deps.processIdentity);
  if (leased) return leased;
  const steps = await deps.loadSteps(state);
  const resolved = resolveRetryTarget(steps, state, target);
  if (resolved.kind !== 'resolved') return resolved;
  const { substep } = resolved;
  const at = `${state.step}.${substep}`;
  const step = steps.find((candidate) => candidate.name === state.step);
  if (step === undefined || delegatedRunbookOf(step, substep) === undefined) {
    return {
      kind: 'refused',
      code: NOTHING_TO_RETRY_CODE,
      message: `Substep ${at} of run ${state.id} delegates nothing, so there is no child to retry; nothing was written.`,
    };
  }
  const cancelled = retryableDelegation(state, step, state.substep, substep);
  if (cancelled === undefined) {
    return {
      kind: 'refused',
      code: NOTHING_TO_RETRY_CODE,
      message: `Run ${state.id} no longer counts a delegation at ${at}: its result was collected or the substep was decided. Nothing was written.`,
    };
  }

  const ticket = generateClaimTicket();
  const ticketHash = hashRunSecret(ticket);
  const prepared = await deps.actorService.prepareActorMutation(state.id, state, steps, {
    type: 'RETRY_DELEGATION',
    substepId: substep,
    ticketHash,
  });
  const saved = await deps.manager.save(prepared.nextState, run.stateVersion);
  if (saved.kind === 'missing') return { kind: 'unknown_token' };
  if (saved.kind === 'concurrent_modification') {
    return {
      kind: 'concurrent_modification',
      runId: state.id,
      message: `Run ${state.id} was modified by another writer since it was read; nothing was cancelled and no ticket was issued. Re-read the run and re-issue the command.`,
    };
  }
  const fresh = activeEntryDelegations(saved.state).find(
    (candidate) => candidate.substepId === substep,
  );
  if (fresh?.reservation.ticketHash !== ticketHash) {
    throw new Error(`Run ${state.id} did not record the delegation it retried at ${at}`);
  }
  const index = fresh.reservation.contextSnapshot.index;
  return {
    kind: 'retried',
    runId: state.id,
    cancelledRunId: cancelled.reservation.runId,
    child: {
      step: at,
      ...(index !== undefined ? { index } : {}),
      runId: fresh.reservation.runId,
      runbook: fresh.reservation.runbook,
      ticket,
    },
  };
}

/** Outcome of {@link releaseDelegation}. */
export type ReleaseDelegationOutcome =
  | DelegationRefusal
  | ExecutionLeaseRefusal
  | RecoveryConcurrentModification
  | {
      /** The child already finished; it is told how, as an owner's command would be. */
      readonly kind: 'run_finished';
      readonly runId: RunId;
      readonly lifecycle: FinishedLifecycle;
    }
  | {
      readonly kind: 'released';
      /** The abandoned child. */
      readonly runId: RunId;
      /** The parent unit it ran for, while the parent exists. */
      readonly parent?: { readonly runId: RunId; readonly step: string };
    };

/**
 * End a Delegation `abandoned` on behalf of the agent that claimed it.
 *
 * The one write not authorized by an Owner Token, so its authority is exact:
 * the run must be a Delegation (its parent may have been pruned), and
 * `agentId` must equal the agent id recorded at claim — both absent is a
 * match, one absent is not. It refuses a run that finished, or whose live
 * command holds the execution lease; an Interrupted one it clears, as `stop`
 * does. The child's machine takes `ABANDON`, committed by one conditional
 * save of the child's own row. The parent is never read for writing and never
 * written.
 *
 * @param deps - Store, actor service, graph loader and process identity.
 * @param input - The child run id and the releasing agent.
 * @param input.runId - The child to release.
 * @param input.agentId - The releasing agent's id, if any.
 * @returns `released`, or a refusal. Nothing is written on a refusal.
 * @throws {Error} When the committed child is not `abandoned` — the machine
 *   ignored `ABANDON` on a running run, which is a defect.
 */
export async function releaseDelegation(
  deps: DelegationRecoveryDeps,
  input: { readonly runId: RunId; readonly agentId?: string },
): Promise<ReleaseDelegationOutcome> {
  const child = await deps.manager.loadWithVersion(input.runId);
  if (child === null) {
    return {
      kind: 'refused',
      code: RUN_TARGET_UNAVAILABLE_CODE,
      message: `Run ${input.runId} not found; nothing was written.`,
    };
  }
  const { state, linkage } = child;
  if (linkage?.kind !== 'delegation' && linkage?.kind !== 'orphaned_delegation') {
    return {
      kind: 'refused',
      code: NOT_A_DELEGATION_CODE,
      message: `Run ${state.id} is not a delegation; only a claimed delegation can be released. Nothing was written.`,
    };
  }
  if (linkage.claimedBy !== input.agentId) {
    return {
      kind: 'refused',
      code: AGENT_MISMATCH_CODE,
      message: `Run ${state.id} was not claimed by this agent: release is authorized only for the agent id its claim recorded. Nothing was written.`,
    };
  }
  const lifecycle = state.lifecycle ?? 'running';
  if (lifecycle !== 'running') return { kind: 'run_finished', runId: state.id, lifecycle };
  const leased = refuseUnderLease(state.id, state, child.lease, 'release', deps.processIdentity);
  if (leased) return leased;

  const steps = await deps.loadSteps(state);
  const prepared = await deps.actorService.prepareActorMutation(state.id, state, steps, {
    type: 'ABANDON',
  });
  const saved = await deps.manager.save(prepared.nextState, child.stateVersion);
  if (saved.kind === 'missing') {
    return {
      kind: 'refused',
      code: RUN_TARGET_UNAVAILABLE_CODE,
      message: `Run ${state.id} was pruned while it was released; nothing was written.`,
    };
  }
  if (saved.kind === 'concurrent_modification') {
    return {
      kind: 'concurrent_modification',
      runId: state.id,
      message: `Run ${state.id} was modified by another writer since it was read; nothing was written. Re-read the run and re-issue the command.`,
    };
  }
  if (saved.state.lifecycle !== 'abandoned') {
    throw new Error(`Run ${state.id} was not abandoned by its release`);
  }
  return {
    kind: 'released',
    runId: state.id,
    ...(linkage.kind === 'delegation'
      ? { parent: { runId: linkage.parentRunId, step: linkage.parentStep } }
      : {}),
  };
}
