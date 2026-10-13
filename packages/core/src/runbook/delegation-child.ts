/**
 * A Delegation's Current Children (#904, ADR 0005), as pure computation over
 * run state.
 *
 * A runbook-list substep marked `DELEGATE` runs its runbook as a Delegation: a
 * Child Run owned by whichever agent claims it. When the cursor enters a
 * delegated substep, the compiled machine reserves that substep's child and
 * the child of every later delegated substep of the step, in the parent's own
 * record, for the frame entry — so a fan-out's children can all be claimed at
 * once ({@link reserveDelegationChildren}). Run Progression then issues each
 * reservation a Claim Ticket; `rundown claim` inserts the child row under the
 * preallocated id; the parent owner's `rundown collect` reads each terminal
 * child's result into the parent. The child never writes its parent.
 *
 * Which reservations the parent still counts is decided here, once, for every
 * reader: the machine's Collect guards, `collect`, `claim`, the child-command
 * standing check and `status`.
 *
 * @module runbook/delegation-child
 */

import { resolvedStepHasSubsteps } from '@rundown-org/parser';
import type { ChildLinkage } from './child-linkage.js';
import type { RunId } from './run-id.js';
import type { SecretHash } from './run-secrets.js';
import { findSubstepState, upsertSubstepStateChild, type FrameKey } from './targeting.js';
import type {
  ContextSnapshot,
  DelegationChildReservation,
  ResolvedStep,
  RunbookState,
  SubstepState,
} from './types.js';

/**
 * The one runbook a delegated substep runs, or `undefined` when the substep is
 * not a single-runbook `DELEGATE` substep.
 *
 * A delegated substep listing more than one runbook is refused at run
 * creation (`findUnsupportedComposition`), so it never reaches the machine.
 *
 * @param step - The step owning the substep.
 * @param substepId - The substep id.
 * @returns The authored (resolved) runbook reference, or `undefined`.
 */
export function delegatedRunbookOf(step: ResolvedStep, substepId: string): string | undefined {
  if (!resolvedStepHasSubsteps(step)) return undefined;
  const substep = step.substeps.find((candidate) => candidate.id === substepId);
  if (substep?.delegate !== true) return undefined;
  const runbooks = substep.runbooks ?? [];
  return runbooks.length === 1 ? runbooks[0] : undefined;
}

/** Input to {@link reserveDelegationChildren}. Plain data from the machine's context. */
export interface ReserveDelegationChildrenInput {
  /** The parent's substep states before the reservation. */
  readonly substepStates: readonly SubstepState[];
  /** The step owning the delegated substep. */
  readonly step: ResolvedStep;
  /** The delegated substep the cursor entered. */
  readonly substepId: string;
  /** The frame being entered. */
  readonly frameKey: FrameKey;
  /** That frame's entry, as the leaf's frame-entry sync made it current. */
  readonly entry: number;
  /** Mints one preallocated child run id. */
  readonly mintRunId: () => RunId;
  /** The context a child reserved for `substepId` inherits. */
  readonly contextFor: (substepId: string) => ContextSnapshot;
}

/**
 * Reserve the Delegations of one frame entry, from the entered substep on.
 *
 * Reserves the entered delegated substep and every later delegated substep of
 * the step that has no reservation at this entry yet. On a fresh entry into
 * the step that is every one of them; moving on to the next delegated substep
 * within the same entry finds them all reserved and changes nothing; a GOTO
 * or RETRY into the middle of the step reserves from there on. A reservation
 * from an earlier entry is replaced: it is stale the moment the frame is
 * entered again, so its child is never collected.
 *
 * @param input - The machine context the reservations are built from.
 * @returns The substep states with the reservations recorded.
 */
export function reserveDelegationChildren(
  input: ReserveDelegationChildrenInput,
): readonly SubstepState[] {
  const { step } = input;
  if (!resolvedStepHasSubsteps(step)) return input.substepStates;
  const from = step.substeps.findIndex((substep) => substep.id === input.substepId);
  let substepStates = input.substepStates;
  for (const substep of step.substeps.slice(Math.max(from, 0))) {
    const runbook = delegatedRunbookOf(step, substep.id);
    if (runbook === undefined) continue;
    const existing = findSubstepState(substepStates, substep.id, input.frameKey)?.child;
    if (existing?.kind === 'delegation' && existing.entry === input.entry) continue;
    const child: DelegationChildReservation = {
      kind: 'delegation',
      runId: input.mintRunId(),
      entry: input.entry,
      runbook,
      contextSnapshot: input.contextFor(substep.id),
      ticketHash: null,
    };
    substepStates = upsertSubstepStateChild(substepStates, substep.id, input.frameKey, child);
  }
  return substepStates;
}

/** The frame-entry coordinates and substep states a Current-Children read needs. */
export interface DelegationFrameView {
  /** The parent's substep states. */
  readonly substepStates?: readonly SubstepState[];
  /** The frame the parent's cursor occupies. */
  readonly activeFrameKey?: FrameKey;
  /** That frame's active entry. */
  readonly activeEntry?: number;
}

/** One Delegation reserved at the parent's active frame entry. */
export interface CurrentDelegation {
  /** The delegated substep id. */
  readonly substepId: string;
  /** The reservation. */
  readonly reservation: DelegationChildReservation;
}

/**
 * The Delegations reserved at the parent's active frame entry, in reservation
 * (document) order.
 *
 * Every reservation of an earlier entry, or of a frame the cursor has left, is
 * stale and absent here.
 *
 * @param view - The parent's frame-entry coordinates and substep states.
 * @returns The active entry's Delegations.
 */
export function activeEntryDelegations(view: DelegationFrameView): readonly CurrentDelegation[] {
  const { activeFrameKey, activeEntry } = view;
  if (activeFrameKey === undefined || activeEntry === undefined) return [];
  const delegations: CurrentDelegation[] = [];
  for (const substepState of view.substepStates ?? []) {
    const child = substepState.child;
    if (
      substepState.frameKey === activeFrameKey &&
      child?.kind === 'delegation' &&
      child.entry === activeEntry
    ) {
      delegations.push({ substepId: substepState.id, reservation: child });
    }
  }
  return delegations;
}

/**
 * Whether `substepId` comes after the cursor's substep in the step's document
 * order. A substep at or before the cursor has been decided — by its Collect,
 * or by the owner's own `pass` / `fail` — so only a later one can still take a
 * result out of order.
 *
 * @param step - The step owning both substeps.
 * @param cursorSubstep - The substep the cursor rests on, if any.
 * @param substepId - The substep in question.
 * @returns True when `substepId` is strictly after the cursor's substep.
 */
export function isAfterCursor(
  step: ResolvedStep,
  cursorSubstep: string | undefined,
  substepId: string,
): boolean {
  if (!resolvedStepHasSubsteps(step) || cursorSubstep === undefined) return false;
  const ids = step.substeps.map((substep) => substep.id);
  const cursor = ids.indexOf(cursorSubstep);
  const index = ids.indexOf(substepId);
  return cursor !== -1 && index > cursor;
}

/**
 * Whether the parent still counts a reservation's child: reserved at the
 * active frame entry, not yet Collected, and for a substep the cursor has not
 * passed (the cursor's own, or a later one).
 *
 * A Delegation the parent no longer counts is cancelled: its owner's next
 * command is refused, and Collect never reads it.
 *
 * @param state - The parent run.
 * @param step - The parent's current step.
 * @param delegation - One of {@link activeEntryDelegations}.
 * @returns True while the parent counts the child.
 */
export function countsDelegation(
  state: Pick<RunbookState, 'substep'>,
  step: ResolvedStep,
  delegation: CurrentDelegation,
): boolean {
  if (delegation.reservation.collected !== undefined) return false;
  return (
    delegation.substepId === state.substep ||
    isAfterCursor(step, state.substep, delegation.substepId)
  );
}

/** Where a Delegation stands with its parent, as its owner's commands see it. */
export type DelegationStanding =
  | { readonly kind: 'current' }
  | {
      /** The parent no longer counts this child; Collect will never read it. */
      readonly kind: 'cancelled';
      readonly parentRunId: RunId;
      readonly parentStep: string;
    }
  | {
      /** The parent reached a terminal (or was pruned) and can Collect nothing. */
      readonly kind: 'parent_finished';
      readonly parentRunId: RunId;
    };

/**
 * Decide whether a Delegation is still its parent's Current Child.
 *
 * The child's own read of its parent: it may race the parent's next write,
 * which is harmless — Collect decides what counts, and a child the parent no
 * longer counts is never collected (ADR 0005).
 *
 * @param linkage - The child row's linkage; its `kind` is `delegation`.
 * @param childRunId - The child.
 * @param parent - The parent run, or `null` when it was pruned.
 * @param parentSteps - The parent's parsed graph, or `null` with no parent.
 * @returns The child's standing.
 */
export function delegationStanding(
  linkage: ChildLinkage,
  childRunId: RunId,
  parent: RunbookState | null,
  parentSteps: readonly ResolvedStep[] | null,
): DelegationStanding {
  if (parent === null || parentSteps === null || (parent.lifecycle ?? 'running') !== 'running') {
    return { kind: 'parent_finished', parentRunId: linkage.parentRunId };
  }
  const cancelled: DelegationStanding = {
    kind: 'cancelled',
    parentRunId: linkage.parentRunId,
    parentStep: linkage.parentStep,
  };
  const step = parentSteps.find((candidate) => candidate.name === parent.step);
  const delegation = activeEntryDelegations(parent).find(
    (candidate) => candidate.reservation.runId === childRunId,
  );
  if (step === undefined || delegation === undefined) return cancelled;
  return countsDelegation(parent, step, delegation) ? { kind: 'current' } : cancelled;
}

/**
 * Find the reservation a Claim Ticket's hash names on one run.
 *
 * Searches every frame and entry, not only the active one, so a ticket from a
 * stale reservation is told it was cancelled rather than that it is unknown.
 *
 * @param state - A run that may have issued the ticket.
 * @param ticketHash - Hash of the presented Claim Ticket.
 * @returns The substep state carrying the reservation, or `undefined`.
 */
export function findTicketReservation(
  state: Pick<RunbookState, 'substepStates'>,
  ticketHash: SecretHash,
): (SubstepState & { readonly child: DelegationChildReservation }) | undefined {
  for (const substepState of state.substepStates ?? []) {
    const child = substepState.child;
    if (child?.kind === 'delegation' && child.ticketHash === ticketHash) {
      return { ...substepState, child };
    }
  }
  return undefined;
}

/** One issued Claim Ticket, as the machine records it: its hash only. */
export interface IssuedClaimTicket {
  /** The reserved child the ticket claims. */
  readonly childRunId: RunId;
  /** The ticket's hash. */
  readonly ticketHash: SecretHash;
}

/**
 * Record issued Claim Tickets on the active entry's Delegations.
 *
 * All or nothing: every ticket must name a Delegation reserved at the active
 * frame entry that has no ticket yet, so a ticket is issued once per
 * reservation and a stale issuance changes nothing.
 *
 * @param view - The parent's frame-entry coordinates and substep states.
 * @param tickets - The tickets to record.
 * @returns The substep states with every hash recorded, or `undefined` when
 *   any ticket names no unissued Delegation of the active entry.
 */
export function recordClaimTickets(
  view: DelegationFrameView,
  tickets: readonly IssuedClaimTicket[],
): readonly SubstepState[] | undefined {
  const delegations = activeEntryDelegations(view);
  const unissued = new Map(
    delegations
      .filter((delegation) => delegation.reservation.ticketHash === null)
      .map((delegation) => [delegation.reservation.runId, delegation]),
  );
  if (tickets.length === 0 || !tickets.every((ticket) => unissued.has(ticket.childRunId))) {
    return undefined;
  }
  const hashes = new Map(tickets.map((ticket) => [ticket.childRunId, ticket.ticketHash]));
  return (view.substepStates ?? []).map((substepState) => {
    const child = substepState.child;
    if (child?.kind !== 'delegation' || substepState.frameKey !== view.activeFrameKey) {
      return substepState;
    }
    const ticketHash = hashes.get(child.runId);
    return ticketHash === undefined || !unissued.has(child.runId)
      ? substepState
      : { ...substepState, child: { ...child, ticketHash } };
  });
}
