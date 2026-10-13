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
 *   it `abandoned`, through the machine (`ABANDON`), in one conditional write
 *   of the child's own row and of the running Inline Children it composes,
 *   which share its authority. Its authority is the agent id `rundown claim`
 *   recorded (both absent match), never an Owner Token, and it grants nothing
 *   else: it never touches the parent, whose Collect reads an abandoned child
 *   as a fail while it still counts it.
 * - {@link delegationsHeldBy} — the plugin's SubagentStop gate (#907) asks
 *   which children still hold a stopping sub-agent: the running Delegations
 *   its claim recorded whose parent still counts them. The gate blocks while
 *   any is held, with the finish-or-release instruction, and keeps no record.
 *
 * @module runbook/delegation-recovery
 */

import type { AbandonedDelegationParent, StepEnteredChild } from '../events/types.js';
import type { RunLinkage } from './child-linkage.js';
import {
  activeEntryDelegations,
  delegatedRunbookOf,
  retryableDelegation,
} from './delegation-child.js';
import {
  delegationStandingOf,
  type DelegationDeps,
  type DelegationRefusal,
} from './delegation-progression.js';
import { refuseUnderLease, type ExecutionLeaseRefusal } from './execution-lease.js';
import { currentInlineReservation } from './inline-child.js';
import { MAX_INLINE_CHILD_DEPTH } from './inline-progression.js';
import type { ConcurrentModificationRefusal } from './lifecycle-command-service.js';
import type { ProcessIdentity } from './process-identity.js';
import type { FinishedLifecycle, OwnedRun } from './run-authority.js';
import type { RunId } from './run-id.js';
import type { RunWriteAtVersion, VersionedRunState } from './storage/runbook-store.js';
import type { RunbookState } from './types.js';
import { generateClaimTicket, hashRunSecret, type ClaimTicket } from './run-secrets.js';
import { recordedAgentId, type DelegationAgent } from './delegation-agent.js';
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
  | ConcurrentModificationRefusal
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
  | ConcurrentModificationRefusal
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
      /** The child as the release committed it. */
      readonly state: RunbookState;
      /** The parent unit it ran for, and whether the parent still counts it. */
      readonly parent: AbandonedDelegationParent;
      /** The running Inline Children it composed, abandoned in the same write. */
      readonly abandonedInline: readonly RunId[];
    };

/**
 * End a Delegation `abandoned` on behalf of the agent that claimed it.
 *
 * The one write not authorized by an Owner Token, so its authority is exact:
 * the run must be a Delegation (its parent may have been pruned), and
 * the releasing agent's id must equal the agent id recorded at claim — both absent is a
 * match, one absent is not. It refuses a run that finished, or whose live
 * command holds the execution lease; an Interrupted one it clears, as `stop`
 * does.
 *
 * The running Inline Children the child composes — its Current Inline Child,
 * transitively — end with it: they have no Owner Token of their own, the
 * child's token was their only authority, and once the child is abandoned
 * nothing could reach them. The same lease rule applies to each. Every one of
 * those machines takes `ABANDON`, and one conditional write commits them all
 * at the versions they were read at, or none. The parent is never read for
 * writing and never written; it is read once more after the commit, only to
 * say whether it still counts the child.
 *
 * @param deps - Store, actor service, graph loader and process identity.
 * @param input - The child run id and the releasing agent.
 * @param input.runId - The child to release.
 * @param input.agent - The releasing agent. An anonymous one matches only a
 *   claim that recorded no agent.
 * @returns `released` with the committed child, or a refusal. Nothing is
 *   written on a refusal.
 * @throws {Error} When a committed run is not `abandoned` — the machine
 *   ignored `ABANDON` on a running run, which is a defect.
 */
export async function releaseDelegation(
  deps: DelegationRecoveryDeps,
  input: { readonly runId: RunId; readonly agent: DelegationAgent },
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
  if (linkage.claimedBy !== recordedAgentId(input.agent)) {
    return {
      kind: 'refused',
      code: AGENT_MISMATCH_CODE,
      message: `Run ${state.id} was not claimed by this agent: release is authorized only for the agent id its claim recorded. Nothing was written.`,
    };
  }
  const lifecycle = state.lifecycle ?? 'running';
  if (lifecycle !== 'running') return { kind: 'run_finished', runId: state.id, lifecycle };
  const inline = await runningInlineChain(deps, child.state);
  for (const run of [child, ...inline]) {
    const leased = refuseUnderLease(
      run.state.id,
      run.state,
      run.lease,
      'release',
      deps.processIdentity,
    );
    if (leased) return leased;
  }

  const writes: RunWriteAtVersion[] = [];
  for (const run of [child, ...inline]) {
    const prepared = await deps.actorService.prepareActorMutation(
      run.state.id,
      run.state,
      await deps.loadSteps(run.state),
      { type: 'ABANDON' },
    );
    writes.push({ state: prepared.nextState, expectedVersion: run.stateVersion });
  }
  const saved = await deps.manager.saveRuns(writes);
  if (saved.kind === 'missing') {
    return {
      kind: 'refused',
      code: RUN_TARGET_UNAVAILABLE_CODE,
      message: `Run ${saved.runId} was pruned while run ${state.id} was released; nothing was written.`,
    };
  }
  if (saved.kind === 'concurrent_modification') {
    return {
      kind: 'concurrent_modification',
      runId: saved.runId,
      message: `Run ${saved.runId} was modified by another writer since it was read; nothing was written. Re-read the run and re-issue the command.`,
    };
  }
  for (const committed of saved.runs) {
    if (committed.state.lifecycle !== 'abandoned') {
      throw new Error(`Run ${committed.state.id} was not abandoned by the release of ${state.id}`);
    }
  }
  const [released] = saved.runs;
  return {
    kind: 'released',
    runId: state.id,
    state: released.state,
    parent: await abandonedParent(deps, released.state, linkage),
    abandonedInline: inline.map((run) => run.state.id),
  };
}

/**
 * The running Inline Children a run composes: its Current Inline Child, that
 * child's, and so on, while each is running. These are exactly the runs the
 * run's Owner Token reaches below it, which a decision ending the run without
 * that token — `release` (#905), the human escape hatch (#906) — ends with it.
 *
 * @param deps - Store.
 * @param state - The run to start from.
 * @returns The running chain, nearest first, each at the version it was read at.
 * @throws {Error} When the chain is deeper than any run can drive.
 */
export async function runningInlineChain(
  deps: Pick<DelegationRecoveryDeps, 'manager'>,
  state: RunbookState,
): Promise<readonly VersionedRunState[]> {
  const chain: VersionedRunState[] = [];
  let current = state;
  for (let level = 0; level <= MAX_INLINE_CHILD_DEPTH; level++) {
    const reservation = currentInlineReservation(current);
    if (reservation === undefined) return chain;
    const inline = await deps.manager.loadWithVersion(reservation.runId);
    if (inline === null || (inline.state.lifecycle ?? 'running') !== 'running') return chain;
    chain.push(inline);
    current = inline.state;
  }
  throw new Error(
    `Inline chain below run ${state.id} is deeper than ${String(MAX_INLINE_CHILD_DEPTH)}`,
  );
}

/**
 * Where a released Delegation stands with its parent, read after the release
 * committed: whether the parent's Collect will still read it as a fail.
 *
 * @param deps - Store and graph loader.
 * @param state - The abandoned child, as committed.
 * @param linkage - The child's linkage: a Delegation's, live or orphaned.
 * @returns The parent unit and the child's standing with it.
 */
async function abandonedParent(
  deps: DelegationRecoveryDeps,
  state: RunbookState,
  linkage: RunLinkage,
): Promise<AbandonedDelegationParent> {
  if (linkage.kind === 'orphaned_delegation') {
    return { standing: 'parent_pruned', step: linkage.parentStep };
  }
  const standing = await delegationStandingOf(deps, { state, linkage });
  return standing.kind === 'parent_pruned'
    ? { standing: 'parent_pruned', step: linkage.parentStep }
    : { standing: standing.kind, runId: linkage.parentRunId, step: linkage.parentStep };
}

/** A running Delegation that still holds the agent that claimed it (#907). */
export interface HeldDelegation {
  /** The child run. */
  readonly runId: RunId;
  /** The child's runbook, as its run records it. */
  readonly runbook: string;
  /** The parent run that still counts it. */
  readonly parentRunId: RunId;
  /** The parent unit (`step.substep`) the child runs for. */
  readonly step: string;
}

/**
 * The Delegations an agent must finish or release before it stops: every
 * running Delegation whose claim recorded `agentId` and whose parent still
 * counts it (standing `current`). A finished, abandoned or cancelled child,
 * one whose parent finished or was pruned, and another agent's child hold
 * nothing.
 *
 * Read-only; it writes nothing and records nothing about the asking agent.
 *
 * @param deps - Store and graph loader.
 * @param agentId - The agent id the claims recorded.
 * @returns The held Delegations, in run id order.
 * @throws {Error} Whatever reading the runs' persisted state throws.
 */
export async function delegationsHeldBy(
  deps: Pick<DelegationDeps, 'manager' | 'loadSteps'>,
  agentId: string,
): Promise<readonly HeldDelegation[]> {
  const held: HeldDelegation[] = [];
  for (const child of await deps.manager.findRunningDelegationsClaimedBy(agentId)) {
    const { linkage } = child;
    if (linkage?.kind !== 'delegation') continue;
    if ((await delegationStandingOf(deps, child)).kind !== 'current') continue;
    held.push({
      runId: child.state.id,
      runbook: child.state.runbook.path,
      parentRunId: linkage.parentRunId,
      step: linkage.parentStep,
    });
  }
  return held;
}
