/**
 * Delegation's commands (#904, ADR 0005): claim, a child's standing, and
 * Collect.
 *
 * - {@link claimDelegation} — `rundown claim <ticket>`. Locates the
 *   reservation by the ticket's hash (one read of the runs recording it, never
 *   a scan that validates every run), prepares the child runbook (the
 *   frontend's service), and in ONE transaction verifies the reservation is
 *   still the parent's Current Child and inserts the child row under the
 *   preallocated id with a fresh Owner Token of its own. The primary key
 *   refuses a second claim. The parent is read, never written.
 * - {@link delegationStandingOf} — every command on a Delegation first checks
 *   the child is still its parent's Current Child and the parent is running.
 *   That read may race the parent's next write; Collect decides what counts.
 * - {@link collectDelegations} — `rundown collect --token`, the parent owner's
 *   read of its Current Children: each terminal child not yet applied is sent
 *   into the parent's machine as one `CHILD_RESULT` commit, conditional on
 *   the version it read; the rest are reported. It is the only way a
 *   Delegation's result reaches the parent.
 *
 * @module runbook/delegation-progression
 */

import {
  deriveTransitionObservation,
  reconcileFencedTerminalObservation,
  type TransitionObservationEvent,
} from '../events/transition-observation.js';
import type { CollectedChild } from '../events/types.js';
import { getErrorMessage } from '../errors.js';
import type { RunbookActorService } from './actor-service.js';
import type { PrepareChildRun } from './child-preparation.js';
import type { ChildLinkage } from './child-linkage.js';
import { recordedAgentId, type DelegationAgent } from './delegation-agent.js';
import {
  activeEntryDelegations,
  countsDelegation,
  delegationStanding,
  findReplacedTicket,
  findTicketReservation,
  owesClaimTickets,
  type CurrentDelegation,
  type DelegationStanding,
} from './delegation-child.js';
import { refuseUnderLease, type ExecutionLeaseRefusal } from './execution-lease.js';
import type { ConcurrentModificationRefusal } from './lifecycle-command-service.js';
import { childResultEvent } from './inline-progression.js';
import { childResultOf } from './inline-child.js';
import type { ProcessIdentity } from './process-identity.js';
import type { OwnedRun } from './run-authority.js';
import { RunbookCompositionUnsupportedError } from './run-authority.js';
import type { RunId } from './run-id.js';
import {
  progressionDirectiveForStartedRun,
  type RunProgressionDirective,
} from './run-progression.js';
import { mintRunProgressionAuthority } from './run-progression-authority.js';
import {
  generateOwnerToken,
  hashRunSecret,
  type ClaimTicket,
  type OwnerToken,
} from './run-secrets.js';
import type { RunbookStateManager } from './state.js';
import type { ClaimDelegationChildResult, VersionedRunState } from './storage/runbook-store.js';
import { frameKeyStep } from './targeting.js';
import type { ActionType } from './transition-kernel.js';
import type { ResolvedStep, RunbookState } from './types.js';

/** A Claim Ticket no reservation carries. */
export const UNKNOWN_TICKET_CODE = 'UNKNOWN_TICKET';
/** A second claim of a reservation that already has its child. */
export const ALREADY_CLAIMED_CODE = 'ALREADY_CLAIMED';
/** The parent no longer counts the Delegation. */
export const DELEGATION_CANCELLED_CODE = 'DELEGATION_CANCELLED';
/** The parent reached a terminal, or was pruned. */
export const PARENT_RUN_FINISHED_CODE = 'PARENT_RUN_FINISHED';
/** `collect` on a run whose active entry reserved no Delegation. */
export const NOTHING_TO_COLLECT_CODE = 'NOTHING_TO_COLLECT';
/** The claimed child's machine could not be initialised. */
export const CHILD_INIT_FAILED_CODE = 'ENGINE_INIT_FAILED';

/** Services a Delegation's commands drive. */
export interface DelegationDeps {
  /** State manager for the project. */
  readonly manager: RunbookStateManager;
  /** Actor service deriving machine transitions. */
  readonly actorService: RunbookActorService;
  /** Parse a run's graph from its state. */
  readonly loadSteps: (
    state: RunbookState,
  ) => readonly ResolvedStep[] | Promise<readonly ResolvedStep[]>;
}

/** A refused Delegation command: nothing was written. */
export interface DelegationRefusal {
  readonly kind: 'refused';
  /** Stable diagnostic code. */
  readonly code: string;
  /** Operator-facing message. Never carries a secret. */
  readonly message: string;
}

/** Outcome of {@link claimDelegation}. */
export type ClaimDelegationOutcome =
  | {
      readonly kind: 'claimed';
      /** The child row as inserted. */
      readonly child: VersionedRunState;
      /** The child's Owner Token, to be printed once on its `runbook_started`. */
      readonly ownerToken: OwnerToken;
      /** The child's parsed graph. */
      readonly steps: readonly ResolvedStep[];
      /** The child's first Run Progression activation. */
      readonly progression: Extract<RunProgressionDirective, { readonly kind: 'activate' }>;
    }
  | DelegationRefusal;

/** The reason a reservation cannot be claimed, decided on the parent. */
type ClaimRefusal = 'parent_finished' | 'cancelled';

/**
 * Decide whether a parent still lets its reservation be claimed.
 *
 * @param parent - The parent as read, or null when pruned.
 * @param steps - The parent's parsed graph.
 * @param linkage - The child's linkage, naming the reservation.
 * @param childRunId - The reserved child id.
 * @returns The refusal, or `undefined` when the claim may proceed.
 */
function claimRefusal(
  parent: RunbookState | null,
  steps: readonly ResolvedStep[],
  linkage: ChildLinkage,
  childRunId: RunId,
): ClaimRefusal | undefined {
  const standing = delegationStanding(linkage, childRunId, parent, steps);
  switch (standing.kind) {
    case 'current':
      return undefined;
    case 'cancelled':
      return 'cancelled';
    case 'parent_finished':
    case 'parent_pruned':
      return 'parent_finished';
    default: {
      const _exhaustive: never = standing;
      return _exhaustive;
    }
  }
}

/**
 * The refusal envelope for a reservation that cannot be claimed.
 *
 * @param refusal - Why.
 * @param parentRunId - The parent.
 * @param step - The parent unit.
 * @returns The refusal.
 */
function claimRefused(refusal: ClaimRefusal, parentRunId: RunId, step: string): DelegationRefusal {
  return refusal === 'parent_finished'
    ? {
        kind: 'refused',
        code: PARENT_RUN_FINISHED_CODE,
        message: `Run ${parentRunId} has finished, so its delegation at ${step} can no longer be claimed; nothing was written.`,
      }
    : {
        kind: 'refused',
        code: DELEGATION_CANCELLED_CODE,
        message: `Run ${parentRunId} no longer counts this delegation at ${step} (the substep was decided, retried or entered again); nothing was written. Ask the parent's owner for the current ticket.`,
      };
}

/**
 * Claim the Delegation a Claim Ticket names.
 *
 * @param deps - Store, actor service, graph loader and the frontend's preparer.
 * @param input - The ticket and the claiming agent.
 * @param input.ticket - The presented Claim Ticket, already parsed.
 * @param input.agent - The claiming agent; an identified agent's id is
 *   recorded on the child row.
 * @returns The claimed child with its Owner Token, or a refusal. Nothing is
 *   written on a refusal.
 * @throws {Error} Whatever reading the issuing run's persisted state throws.
 */
export async function claimDelegation(
  deps: DelegationDeps & { readonly prepareChildRun: PrepareChildRun },
  input: { readonly ticket: ClaimTicket; readonly agent: DelegationAgent },
): Promise<ClaimDelegationOutcome> {
  const claimedBy = recordedAgentId(input.agent);
  const ticketHash = hashRunSecret(input.ticket);
  let found:
    | {
        readonly parent: VersionedRunState;
        readonly substepState: NonNullable<ReturnType<typeof findTicketReservation>>;
      }
    | undefined;
  for (const run of await deps.manager.findByTicketHash(ticketHash)) {
    const substepState = findTicketReservation(run.state, ticketHash);
    if (substepState !== undefined) {
      found = { parent: run, substepState };
      break;
    }
    // A ticket whose child the parent replaced (`retry`, or a re-entry) is
    // told the parent no longer counts it: the owner holds the current ticket
    // (#905).
    const replaced = findReplacedTicket(run.state, ticketHash);
    if (replaced !== undefined) {
      return claimRefused(
        'cancelled',
        run.state.id,
        `${frameKeyStep(replaced.frameKey)}.${replaced.id}`,
      );
    }
  }
  if (found === undefined) {
    return {
      kind: 'refused',
      code: UNKNOWN_TICKET_CODE,
      message:
        'No delegation matches this ticket. Copy the ticket from the children of the step_entered event that issued it.',
    };
  }
  const { parent, substepState } = found;
  const reservation = substepState.child;
  const linkage: ChildLinkage = {
    kind: 'delegation',
    parentRunId: parent.state.id,
    parentStep: `${reservation.contextSnapshot.step ?? parent.state.step}.${substepState.id}`,
    parentFrameKey: substepState.frameKey,
    parentEntry: reservation.entry,
    ...(claimedBy !== undefined ? { claimedBy } : {}),
  };
  const parentSteps = await deps.loadSteps(parent.state);
  const early = claimRefusal(parent.state, parentSteps, linkage, reservation.runId);
  if (early !== undefined) return claimRefused(early, parent.state.id, linkage.parentStep);
  if ((await deps.manager.loadWithVersion(reservation.runId)) !== null) {
    return alreadyClaimed(reservation.runId, linkage.parentStep);
  }

  const prepared = await deps.prepareChildRun({
    parent: parent.state,
    reservation,
    contextSnapshot: reservation.contextSnapshot,
  });
  if (prepared.kind === 'refused') {
    return {
      kind: 'refused',
      code: prepared.code,
      message: `Delegation ${reservation.runbook} at ${linkage.parentStep} could not be claimed: ${prepared.message}`,
    };
  }

  const ownerToken = generateOwnerToken();
  let claimed: ClaimDelegationChildResult<ClaimRefusal>;
  try {
    claimed = await deps.manager.claimDelegationChild(
      prepared.runbookRef,
      prepared.runbook,
      {
        runId: reservation.runId,
        linkage,
        ownerTokenHash: hashRunSecret(ownerToken),
        prompted: parent.state.prompted,
        // The child's commands run where its parent's do.
        launchDir: parent.state.launchDir,
        runbookPath: prepared.runbookPath,
        runbookSrc: prepared.runbookSrc,
        templateVars: prepared.templateVars,
        initialVariables: prepared.initialVariables,
        frontmatterOutputs: prepared.frontmatterOutputs,
      },
      async (draft) => {
        try {
          return await deps.actorService.deriveInitialState(draft, prepared.runbook.steps);
        } catch (error: unknown) {
          throw new ChildInitializationError(error);
        }
      },
      (read) => claimRefusal(read?.state ?? null, parentSteps, linkage, reservation.runId),
    );
  } catch (error: unknown) {
    if (error instanceof RunbookCompositionUnsupportedError) {
      return {
        kind: 'refused',
        code: 'RUNBOOK_COMPOSITION_UNSUPPORTED',
        message: `Delegation ${reservation.runbook} at ${linkage.parentStep} could not be claimed: ${error.message}`,
      };
    }
    if (error instanceof ChildInitializationError) {
      return {
        kind: 'refused',
        code: CHILD_INIT_FAILED_CODE,
        message: `Delegation ${reservation.runId} at ${linkage.parentStep} could not be initialised: ${getErrorMessage(error.cause)}; nothing was written`,
      };
    }
    throw error;
  }
  switch (claimed.kind) {
    case 'already_claimed':
      return alreadyClaimed(reservation.runId, linkage.parentStep);
    case 'refused':
      return claimRefused(claimed.refusal, parent.state.id, linkage.parentStep);
    case 'claimed':
      break;
    default: {
      const _exhaustive: never = claimed;
      return _exhaustive;
    }
  }
  const child = await deps.manager.loadWithVersion(reservation.runId);
  if (child === null) throw new Error(`Delegation ${reservation.runId} vanished during its claim`);
  const steps = prepared.runbook.steps;
  return {
    kind: 'claimed',
    child,
    ownerToken,
    steps,
    progression: progressionDirectiveForStartedRun(child.state, steps),
  };
}

/** A claimed child's machine could not be initialised; carries the cause. */
class ChildInitializationError extends Error {
  /**
   * Wrap what initializing the child's machine threw.
   *
   * @param cause - What initializing the child's machine threw.
   */
  constructor(cause: unknown) {
    super(`Delegation could not be initialised: ${getErrorMessage(cause)}`, { cause });
    this.name = 'ChildInitializationError';
  }
}

/**
 * The `ALREADY_CLAIMED` refusal.
 *
 * @param childRunId - The reserved child.
 * @param step - The parent unit.
 * @returns The refusal.
 */
function alreadyClaimed(childRunId: RunId, step: string): DelegationRefusal {
  return {
    kind: 'refused',
    code: ALREADY_CLAIMED_CODE,
    message: `The delegation at ${step} was already claimed as run ${childRunId}; a ticket claims its child once. Nothing was written.`,
  };
}

/**
 * Where a run stands as a Delegation, for its owner's next command.
 *
 * @param deps - Store and graph loader.
 * @param run - The run the command's token resolved to.
 * @returns `current` for any run that is not a Delegation, `parent_pruned` for
 *   a Delegation whose parent was pruned, else its standing.
 */
export async function delegationStandingOf(
  deps: Pick<DelegationDeps, 'manager' | 'loadSteps'>,
  run: Pick<OwnedRun, 'state' | 'linkage'>,
): Promise<DelegationStanding> {
  const linkage = run.linkage;
  if (linkage?.kind === 'orphaned_delegation') {
    return { kind: 'parent_pruned', parentStep: linkage.parentStep };
  }
  if (linkage?.kind !== 'delegation') return { kind: 'current' };
  const parent = await deps.manager.loadWithVersion(linkage.parentRunId);
  const steps = parent === null ? null : await deps.loadSteps(parent.state);
  return delegationStanding(linkage, run.state.id, parent?.state ?? null, steps);
}

/** Outcome of {@link collectDelegations}. */
export type CollectDelegationsOutcome =
  | ExecutionLeaseRefusal
  | DelegationRefusal
  // The row moved between a read and a Collect commit; nothing more was written.
  | ConcurrentModificationRefusal
  | { readonly kind: 'unknown_token' }
  | {
      readonly kind: 'collected';
      /** The run Collected into. */
      readonly runId: RunId;
      /** Every Delegation of the active entry, as Collect found it. */
      readonly children: readonly CollectedChild[];
      /** Transition observations of each Collect that moved the cursor. */
      readonly events: readonly TransitionObservationEvent[];
      /**
       * Whether Run Progression continues: `activate` when a Collect moved the
       * cursor (it may have entered the next unit, finished the run, or
       * finished an Inline Child its parent now Collects), or when the run
       * rests on a delegated unit whose entry never committed its Claim
       * Tickets (the activation issues and prints them); `none` otherwise.
       */
      readonly progression: RunProgressionDirective;
    };

/**
 * The report entry for one Delegation, read against the parent as this
 * Collect has left it so far.
 *
 * Whether the child is applied is decided on the fresh parent, never on the
 * reservation as the Collect first read it: an earlier Collect of the same
 * pass may have finished the parent, moved it out of the step, or advanced a
 * FOR loop to a new frame, and a child the parent no longer counts is
 * reported `cancelled` with nothing applied.
 *
 * @param state - The parent as this Collect has left it.
 * @param stepName - The step the Delegation was reserved for.
 * @param step - The parent's current step.
 * @param delegation - The Delegation as the Collect first read it.
 * @param child - The child row, or null when unclaimed.
 * @returns The report entry, and the live Delegation to apply when the parent
 *   still counts a terminal child.
 */
function standingOf(
  state: RunbookState,
  stepName: string,
  step: ResolvedStep | undefined,
  delegation: CurrentDelegation,
  child: VersionedRunState | null,
): { readonly report: CollectedChild; readonly apply: CurrentDelegation | undefined } {
  const { reservation } = delegation;
  const base = {
    step: `${stepName}.${delegation.substepId}`,
    ...(reservation.contextSnapshot.index !== undefined
      ? { index: reservation.contextSnapshot.index }
      : {}),
    runId: reservation.runId,
  };
  if (reservation.collected !== undefined) {
    return {
      report: { ...base, status: 'already_collected', result: reservation.collected },
      apply: undefined,
    };
  }
  const result = childResultOf(child?.state.lifecycle);
  const withResult = result === undefined ? base : { ...base, result };
  const live = activeEntryDelegations(state).find(
    (candidate) => candidate.reservation.runId === reservation.runId,
  );
  if (
    (state.lifecycle ?? 'running') !== 'running' ||
    step === undefined ||
    live === undefined ||
    !countsDelegation(state, step, live)
  ) {
    return { report: { ...withResult, status: 'cancelled' }, apply: undefined };
  }
  if (child === null) return { report: { ...base, status: 'unclaimed' }, apply: undefined };
  if (result === undefined) return { report: { ...base, status: 'pending' }, apply: undefined };
  return { report: { ...withResult, status: 'collected' }, apply: live };
}

/**
 * Collect the owner's run's Current Children.
 *
 * Reads every Delegation reserved at the run's active frame entry, in
 * document order, and their child rows. Each terminal child the run still
 * counts — decided on the run as this Collect has left it, not as it was
 * first read — is sent into the machine as one `CHILD_RESULT`, committed by
 * one conditional save at the version the previous save of this Collect
 * produced; the machine applies the cursor's own result at once and holds a
 * later substep's until the cursor arrives. A save refused because the run
 * moved — including a write by another writer between two of this Collect's
 * saves — stops the Collect there, never retried: the commits before it
 * stand, and the next `collect` reads them as already collected. Running and
 * unclaimed children are reported, and nothing is applied for them; a child
 * the run stopped counting during this Collect (it finished, or left the
 * entry) is reported `cancelled`.
 *
 * @param deps - Store, actor service, graph loader and process identity.
 * @param run - The run resolved from the owner's token, with its version.
 * @param computeActionResult - Optional display-result policy for observations.
 * @returns The Collect report, or a refusal.
 * @throws {Error} When the run's cursor names a step the runbook does not
 *   define, or on an actor derivation failure.
 */
export async function collectDelegations(
  deps: DelegationDeps & { readonly processIdentity?: ProcessIdentity },
  run: OwnedRun,
  computeActionResult?: (actionType: ActionType) => boolean,
): Promise<CollectDelegationsOutcome> {
  const leased = refuseUnderLease(
    run.state.id,
    run.state,
    run.lease,
    'collect',
    deps.processIdentity,
  );
  if (leased) return leased;
  const steps = await deps.loadSteps(run.state);
  const delegations = activeEntryDelegations(run.state);
  if (delegations.length === 0) {
    return {
      kind: 'refused',
      code: NOTHING_TO_COLLECT_CODE,
      message: `Run ${run.state.id} has no delegation at its current step ${run.state.step}${run.state.substep === undefined ? '' : `.${run.state.substep}`}; nothing was written.`,
    };
  }
  const childRows = await Promise.all(
    delegations.map(({ reservation }) => deps.manager.loadWithVersion(reservation.runId)),
  );

  let current: VersionedRunState = run;
  // Every Delegation of the active entry belongs to the step the cursor rests
  // on now; a Collect below may move the cursor on, the reports do not.
  const reservedFor = run.state.step;
  const children: CollectedChild[] = [];
  const events: TransitionObservationEvent[] = [];
  let moved = false;
  for (const [position, delegation] of delegations.entries()) {
    const step = steps.find((candidate) => candidate.name === current.state.step);
    const child = childRows[position] ?? null;
    const { report, apply } = standingOf(current.state, reservedFor, step, delegation, child);
    if (apply === undefined || child === null || step === undefined) {
      children.push(report);
      continue;
    }
    const previous = current.state;
    const { event, result } = childResultEvent(child.state);
    const prepared = await deps.actorService.prepareActorMutation(
      previous.id,
      previous,
      steps,
      event,
    );
    const saved = await deps.manager.save(prepared.nextState, current.stateVersion);
    if (saved.kind === 'missing') return { kind: 'unknown_token' };
    if (saved.kind === 'concurrent_modification') {
      return {
        kind: 'concurrent_modification',
        runId: previous.id,
        message: `Run ${previous.id} was modified by another writer while it Collected ${child.state.id}; that result was not applied. Collects before it stand. Re-read the run and re-issue the command.`,
      };
    }
    children.push(report);
    if (apply.substepId === previous.substep) {
      moved = true;
      // The cursor's own result: a transition the owner observes.
      const observation = deriveTransitionObservation({
        steps,
        currentStep: step,
        previousState: previous,
        updatedState: saved.state,
        snapshot: prepared.snapshot,
        result,
        ...(computeActionResult ? { computeActionResult } : {}),
      });
      events.push(
        ...reconcileFencedTerminalObservation({
          observation,
          steps,
          currentStep: step,
          previousState: previous,
          updatedState: saved.state,
          snapshot: prepared.snapshot,
          result,
        }).events,
      );
    }
    // The next save expects the version this one produced: a write by anyone
    // else in between refuses it, rather than being absorbed by a re-read.
    current = { ...current, state: saved.state, stateVersion: saved.stateVersion, lease: null };
  }

  const lifecycle = current.state.lifecycle ?? 'running';
  if (lifecycle === 'abandoned') {
    // Only `release` writes `abandoned`, and only on a child's own row.
    throw new Error(`Run ${current.state.id} was abandoned while its owner Collected`);
  }
  const restingStep = steps.find((candidate) => candidate.name === current.state.step);
  return {
    kind: 'collected',
    runId: run.state.id,
    children,
    events,
    // A Collect that moved the cursor continues Run Progression; a result held
    // for a later substep leaves the parent resting where it was. A parent
    // resting on a delegated unit whose entry never committed its Claim
    // Tickets is activated on that unit, which issues and prints them.
    progression: moved
      ? {
          kind: 'activate',
          authority: mintRunProgressionAuthority({ runId: run.state.id }),
          runbook: run.state.runbook,
          steps,
          entryBoundary: {
            kind: 'after_observed_transition',
            lifecycle,
          },
        }
      : owesClaimTickets(current.state, restingStep)
        ? {
            kind: 'activate',
            authority: mintRunProgressionAuthority({ runId: run.state.id }),
            runbook: run.state.runbook,
            steps,
            entryBoundary: { kind: 'resume' },
          }
        : { kind: 'none' },
  };
}

/** One Delegation of a run's active entry as `rundown status` shows it. */
export interface DelegationChildStatus {
  /** The child run. */
  readonly runId: RunId;
  /** The parent unit the child runs for (`step.substep`). */
  readonly step: string;
  /** The FOR iteration the child was reserved in, inside a loop. */
  readonly index?: number;
  /** The child's lifecycle, or `reserved` before any agent claimed it. */
  readonly status: 'reserved' | NonNullable<RunbookState['lifecycle']>;
  /** The Child Result, once the child is terminal. */
  readonly result?: 'pass' | 'fail';
}

/**
 * The Delegations of a run's active entry, as status shows them: by id,
 * lifecycle and result only. Never a ticket — status grants nothing.
 *
 * @param manager - State manager.
 * @param state - The parent run.
 * @returns One entry per Delegation of the active entry, in document order.
 */
export async function delegationChildrenStatus(
  manager: RunbookStateManager,
  state: RunbookState,
): Promise<readonly DelegationChildStatus[]> {
  const delegations = activeEntryDelegations(state);
  const childRows = await Promise.all(
    delegations.map(({ reservation }) => manager.load(reservation.runId)),
  );
  return delegations.map(({ substepId, reservation }, position): DelegationChildStatus => {
    const child = childRows[position] ?? null;
    const result = childResultOf(child?.lifecycle);
    return {
      runId: reservation.runId,
      step: `${state.step}.${substepId}`,
      ...(reservation.contextSnapshot.index !== undefined
        ? { index: reservation.contextSnapshot.index }
        : {}),
      status: child === null ? 'reserved' : (child.lifecycle ?? 'running'),
      ...(result !== undefined ? { result } : {}),
    };
  });
}
