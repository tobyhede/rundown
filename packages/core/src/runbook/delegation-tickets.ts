/**
 * Claim Ticket issuance for a Delegation's step entry (#904, ADR 0005).
 *
 * The machine reserves a Delegation's Current Children on entry; Run
 * Progression then issues each a Claim Ticket in the turn that announces the
 * entry. A ticket is minted here, its hash alone is committed into the
 * parent's record through the machine (`ISSUE_CLAIM_TICKETS`, one conditional
 * save), and the plaintext rides the `step_entered` event that turn emits —
 * once, and nowhere else. Nothing persists the plaintext, so a ticket lost
 * after it was printed is recovered by `retry` (#905), never re-revealed.
 *
 * @module runbook/delegation-tickets
 */

import type { ExecutionObservationEffect } from '../events/execution-observation.js';
import type { StepEnteredChild } from '../events/types.js';
import type { RunbookActorService } from './actor-service.js';
import type { CurrentDelegation } from './delegation-child.js';
import { generateClaimTicket, hashRunSecret, type ClaimTicket } from './run-secrets.js';
import type { RunId } from './run-id.js';
import type { RunbookStateManager } from './state.js';
import type { VersionedRunState } from './storage/runbook-store.js';
import type { ResolvedStep } from './types.js';

/** Services ticket issuance needs. */
export interface ClaimTicketIssuanceDeps {
  /** State manager whose conditional save commits the hashes. */
  readonly manager: RunbookStateManager;
  /** Actor service deriving the machine transition. */
  readonly actorService: RunbookActorService;
}

/** Outcome of {@link issueClaimTickets}. */
export type ClaimTicketIssuance =
  | {
      /** Every counted Delegation has a ticket; `children` lists them for the entry. */
      readonly kind: 'issued';
      /** The parent at the version issuance left it (unchanged when nothing was issued). */
      readonly run: VersionedRunState;
      /** The step entry's children, carrying each ticket issued in this turn. */
      readonly children: readonly StepEnteredChild[];
    }
  | {
      /** Another of the owner's commands moved the parent; nothing was written. */
      readonly kind: 'concurrent_modification';
    }
  | {
      /** The parent no longer exists; nothing was written. */
      readonly kind: 'missing';
    };

/**
 * Issue a Claim Ticket for every counted Delegation of the entry that has
 * none, and list the entry's children.
 *
 * One conditional save, at the version the parent was read at, records every
 * new hash; a version that moved is refused, never retried, and the minted
 * tickets are discarded unprinted. A Delegation already issued a ticket — by
 * an earlier announcement of the same entry — is listed without one.
 *
 * @param args - The issuance.
 * @param args.deps - Store and actor service.
 * @param args.run - The parent, at the version this turn read.
 * @param args.steps - The parent's parsed graph.
 * @param args.delegations - The Delegations the parent counts at the entry.
 * @returns The listed children with their new tickets, or why none were issued.
 * @throws {Error} When the committed state does not carry every issued hash —
 *   the machine's guard refused tickets this module derived from the same
 *   state, which is a defect, not a race.
 */
export async function issueClaimTickets(args: {
  readonly deps: ClaimTicketIssuanceDeps;
  readonly run: VersionedRunState;
  readonly steps: readonly ResolvedStep[];
  readonly delegations: readonly CurrentDelegation[];
}): Promise<ClaimTicketIssuance> {
  const { deps, run, steps, delegations } = args;
  const minted = new Map<RunId, ClaimTicket>();
  for (const { reservation } of delegations) {
    if (reservation.ticketHash === null) minted.set(reservation.runId, generateClaimTicket());
  }
  const children = (): readonly StepEnteredChild[] =>
    delegations.map(({ substepId, reservation }) => {
      const ticket = minted.get(reservation.runId);
      const index = reservation.contextSnapshot.index;
      return {
        step: `${run.state.step}.${substepId}`,
        ...(index !== undefined ? { index } : {}),
        runId: reservation.runId,
        runbook: reservation.runbook,
        ...(ticket !== undefined ? { ticket } : {}),
      };
    });
  if (minted.size === 0) return { kind: 'issued', run, children: children() };

  const prepared = await deps.actorService.prepareActorMutation(run.state.id, run.state, steps, {
    type: 'ISSUE_CLAIM_TICKETS',
    tickets: [...minted].map(([childRunId, ticket]) => ({
      childRunId,
      ticketHash: hashRunSecret(ticket),
    })),
  });
  const saved = await deps.manager.save(prepared.nextState, run.stateVersion);
  if (saved.kind !== 'committed') return { kind: saved.kind };
  const issued = new Set(
    (saved.state.substepStates ?? []).flatMap((substepState) =>
      substepState.child?.kind === 'delegation' && substepState.child.ticketHash !== null
        ? [substepState.child.runId]
        : [],
    ),
  );
  if (![...minted.keys()].every((runId) => issued.has(runId))) {
    throw new Error(`Run ${run.state.id} did not record the Claim Tickets it was issued`);
  }
  const reread = await deps.manager.loadWithVersion(run.state.id);
  if (reread === null) return { kind: 'missing' };
  return { kind: 'issued', run: reread, children: children() };
}

/**
 * The entry's observations with its Delegations listed on `step_entered`.
 *
 * @param effects - The unit entry's observations.
 * @param children - The children to list.
 * @returns The observations, `step_entered` carrying `children`.
 */
export function withEnteredChildren(
  effects: readonly ExecutionObservationEffect[],
  children: readonly StepEnteredChild[],
): readonly ExecutionObservationEffect[] {
  return effects.map((effect) =>
    effect.event.type === 'STEP_ENTERED'
      ? { ...effect, event: { ...effect.event, payload: { ...effect.event.payload, children } } }
      : effect,
  );
}
