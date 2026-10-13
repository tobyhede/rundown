/**
 * Which runs a prune deletes, and why it keeps the rest (#906, ADR 0005).
 *
 * One rule for every pruning caller, decided here so a front end only renders
 * it:
 *
 * - **A Current Child is protected.** A Child Run its running parent still
 *   counts — an Inline Child the parent's cursor rests on, or a Delegation the
 *   parent would still Collect — is never deleted on its own, whatever its
 *   lifecycle. A terminal one holds a Child Result the parent has not read;
 *   deleting it would lose that result, and for a Delegation would free the
 *   reserved id so its Claim Ticket could claim a second child. A running one
 *   is still doing the parent's work. Protection ends when the parent durably
 *   Collects the child, when Cancellation (`retry`, the owner's own decision
 *   on the substep, a re-entry) makes the result unnecessary, when the parent
 *   reaches a terminal, or when the parent is pruned. Ending it deletes
 *   nothing: the child becomes eligible for an ordinary prune.
 * - **A running run needs its Owner Token or a human's confirmation.** A run
 *   selected by filter is deleted only when a human at an interactive
 *   terminal confirms it ({@link PrunePlanInput.confirmRunning}); otherwise it
 *   is retained. An Inline Child has no token of its own, so a running one
 *   goes only with its root.
 * - **The execution lease.** A delete removes its root's Inline Children too
 *   (`run-deletion.ts`), so an attempt In Progress anywhere in the chain keeps
 *   the whole delete.
 *
 * Protection is decided on one listing and never comes back once it ends: a
 * Collected, cancelled or stale reservation is never counted again, and a
 * finished or pruned parent never runs again. So a delete planned here is
 * never wrong by the time it lands; any write to a run since the listing is
 * refused by the delete's own conditional check on the version read.
 *
 * @module runbook/run-pruning
 */

import type { ResolvedStep } from '@rundown-org/parser';
import { delegationStanding } from './delegation-child.js';
import type { ExecutionLeaseRefusal } from './execution-lease.js';
import { currentInlineReservation } from './inline-child.js';
import type { ProcessIdentity } from './process-identity.js';
import type { RunId } from './run-id.js';
import { planRunDeletions, refuseDeletionUnderLease, type RunDeletion } from './run-deletion.js';
import type { VersionedRunState } from './storage/runbook-store.js';
import type { Lifecycle, RunbookState } from './types.js';

/** Code of {@link CurrentChildProtectedRefusal}. */
export const CURRENT_CHILD_PROTECTED_CODE = 'CURRENT_CHILD_PROTECTED';

/**
 * Why a selected run was kept rather than deleted.
 *
 * - `token required` — a running run, with no Owner Token naming it and no
 *   human at a terminal to confirm it.
 * - `not confirmed` — a running run the human declined to delete.
 * - `uncollected` — a terminal Current Child whose result its running parent
 *   has not Collected.
 * - `current child` — a running Current Child: its parent still counts it.
 * - `execution in progress` — a live attempt holds a run the delete removes.
 */
export type PruneRetentionReason =
  | 'token required'
  | 'not confirmed'
  | 'uncollected'
  | 'current child'
  | 'execution in progress';

/** A selected run the prune keeps, with its reason. */
export interface RetainedRun {
  /** The run as listed. */
  readonly run: VersionedRunState;
  /** Why it is kept. */
  readonly reason: PruneRetentionReason;
}

/** Refusal: the run `--token` names is a Current Child its parent still counts. */
export interface CurrentChildProtectedRefusal {
  readonly kind: 'current_child_protected';
  /** The symbolic refusal code. */
  readonly code: typeof CURRENT_CHILD_PROTECTED_CODE;
  /** The protected child. */
  readonly runId: RunId;
  /** The parent that counts it. */
  readonly parentRunId: RunId;
  /** The parent unit the child runs for. */
  readonly parentStep: string;
  /** Operator-facing message. Carries no secret. */
  readonly message: string;
}

/** Which lifecycles a prune selects by filter. */
export type PruneSelection = Readonly<Record<Lifecycle, boolean>>;

/** Input to {@link planPrune}. */
export interface PrunePlanInput {
  /** One listing of the store (`RunbookStateManager.listWithVersion`). */
  readonly runs: readonly VersionedRunState[];
  /** The lifecycles the prune's filter selects. */
  readonly select: PruneSelection;
  /** The run `--token` names, if any: deleted whatever its lifecycle, unless refused. */
  readonly owned: VersionedRunState | null;
  /**
   * Ask the human at an interactive terminal whether to delete a running run
   * no token names. Absent when there is no such human — a pipe, an agent's
   * shell, an MCP call, or `--dry-run` — and every such run is then retained
   * `token required`. Called only for a run that would otherwise be deleted.
   */
  readonly confirmRunning?: (run: VersionedRunState) => Promise<boolean>;
  /** Parse a run's graph from its state: a Delegation's standing needs its parent's. */
  readonly loadSteps: (
    state: RunbookState,
  ) => readonly ResolvedStep[] | Promise<readonly ResolvedStep[]>;
  /** Start-identity source for the lease rule; defaults to the process-wide one. */
  readonly processIdentity?: ProcessIdentity;
}

/** Outcome of {@link planPrune}. */
export type PrunePlan =
  | {
      readonly kind: 'planned';
      /** The deletes to make, the owned run's first. */
      readonly deletions: readonly RunDeletion[];
      /** Every selected run kept, with its reason. */
      readonly retained: readonly RetainedRun[];
    }
  | {
      /** The run `--token` names may not be deleted: nothing is. */
      readonly kind: 'refused';
      readonly refusal: ExecutionLeaseRefusal | CurrentChildProtectedRefusal;
    };

/**
 * The running parent that still counts `run` as its Current Child, or
 * `undefined` when nothing protects it.
 *
 * An Inline Child is counted while its parent's cursor rests on the
 * reservation that names it; a Delegation while its parent would still
 * Collect it (`delegationStanding`). A top-level run, an orphaned Delegation,
 * and a child whose parent finished or is not listed are not protected.
 *
 * @param run - The run to test.
 * @param runs - One listing of the store, which `run` is drawn from.
 * @param loadSteps - Parse a run's graph from its state.
 * @returns The protecting parent, or `undefined`.
 */
export async function protectingParentOf(
  run: VersionedRunState,
  runs: readonly VersionedRunState[],
  loadSteps: PrunePlanInput['loadSteps'],
): Promise<VersionedRunState | undefined> {
  const linkage = run.linkage;
  if (linkage === null || linkage.kind === 'orphaned_delegation') return undefined;
  const parent = runs.find((listed) => listed.state.id === linkage.parentRunId);
  if (parent === undefined || (parent.state.lifecycle ?? 'running') !== 'running') {
    return undefined;
  }
  switch (linkage.kind) {
    case 'inline':
      return currentInlineReservation(parent.state)?.runId === run.state.id ? parent : undefined;
    case 'delegation': {
      const steps = await loadSteps(parent.state);
      const standing = delegationStanding(linkage, run.state.id, parent.state, steps);
      return standing.kind === 'current' ? parent : undefined;
    }
    default: {
      const _exhaustive: never = linkage;
      throw new Error(`Unhandled child linkage: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * The reason a protected Current Child is retained.
 *
 * @param run - The protected child.
 * @returns `current child` while it runs, `uncollected` once terminal.
 */
function protectionReason(run: VersionedRunState): PruneRetentionReason {
  return (run.state.lifecycle ?? 'running') === 'running' ? 'current child' : 'uncollected';
}

/**
 * The refusal for `--token` naming a protected Current Child.
 *
 * @param run - The child the token names.
 * @param parent - The parent that counts it.
 * @returns The refusal.
 */
function protectedRefusal(
  run: VersionedRunState,
  parent: VersionedRunState,
): CurrentChildProtectedRefusal {
  const parentStep = run.linkage?.parentStep ?? '';
  const why =
    (run.state.lifecycle ?? 'running') === 'running'
      ? 'is still running for it'
      : 'holds a result it has not collected';
  return {
    kind: 'current_child_protected',
    code: CURRENT_CHILD_PROTECTED_CODE,
    runId: run.state.id,
    parentRunId: parent.state.id,
    parentStep,
    message: `Run ${run.state.id} is the current child of run ${parent.state.id} at ${parentStep} and ${why}, so nothing was deleted. It becomes prunable once the parent collects it, cancels it with \`rundown retry\`, finishes, or is pruned.`,
  };
}

/**
 * Decide what a prune deletes and what it keeps.
 *
 * In order: refuse the owned run when it is a protected Current Child; keep
 * every selected Current Child its parent still counts; keep a running run no
 * token names unless the human confirms it (asked only after the lease rule
 * passes its chain); then plan the deletes and apply the lease rule to each.
 * A refusal of the owned run's delete refuses the whole prune; any other
 * delete the lease refuses is kept. A run a planned delete removes with its
 * root is reported with that delete, never as retained: protection ends when
 * the parent is pruned.
 *
 * @param input - The listing, selection, owned run and frontend callables.
 * @returns The deletes and retained runs, or the refusal of the owned run.
 */
export async function planPrune(input: PrunePlanInput): Promise<PrunePlan> {
  const { runs, owned } = input;
  if (owned !== null) {
    const parent = await protectingParentOf(owned, runs, input.loadSteps);
    if (parent !== undefined) return { kind: 'refused', refusal: protectedRefusal(owned, parent) };
  }

  const finished: VersionedRunState[] = [];
  const confirmable: VersionedRunState[] = [];
  const retained: RetainedRun[] = [];
  for (const run of runs) {
    if (run.state.id === owned?.state.id) continue;
    const lifecycle = run.state.lifecycle ?? 'running';
    if (!input.select[lifecycle]) continue;
    if ((await protectingParentOf(run, runs, input.loadSteps)) !== undefined) {
      retained.push({ run, reason: protectionReason(run) });
    } else if (lifecycle !== 'running') {
      finished.push(run);
    } else if (run.linkage?.kind === 'inline' || input.confirmRunning === undefined) {
      // An Inline Child runs on its root's token and goes only with its root.
      retained.push({ run, reason: 'token required' });
    } else {
      confirmable.push(run);
    }
  }

  const identity = input.processIdentity;
  const confirmed: VersionedRunState[] = [];
  for (const run of confirmable) {
    const leased = planRunDeletions([run], runs).some(
      (deletion) => refuseDeletionUnderLease(deletion, identity) !== undefined,
    );
    if (leased) {
      retained.push({ run, reason: 'execution in progress' });
    } else if (await input.confirmRunning?.(run)) {
      confirmed.push(run);
    } else {
      retained.push({ run, reason: 'not confirmed' });
    }
  }

  const deletions: RunDeletion[] = [];
  const selected = [...(owned === null ? [] : [owned]), ...finished, ...confirmed];
  for (const deletion of planRunDeletions(selected, runs)) {
    const refusal = refuseDeletionUnderLease(deletion, identity);
    if (refusal === undefined) {
      deletions.push(deletion);
    } else if (deletion.root.state.id === owned?.state.id) {
      return { kind: 'refused', refusal };
    } else {
      retained.push({ run: deletion.root, reason: 'execution in progress' });
    }
  }

  const deleted = new Set<RunId>(
    deletions.flatMap((deletion) =>
      [deletion.root, ...deletion.inlineDescendants].map((run) => run.state.id),
    ),
  );
  return {
    kind: 'planned',
    deletions,
    retained: retained.filter(({ run }) => !deleted.has(run.state.id)),
  };
}
