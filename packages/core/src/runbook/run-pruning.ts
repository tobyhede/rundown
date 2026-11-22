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
 *   reaches a terminal, or when the parent is pruned — this prune included: a
 *   terminal child the prune's selection picks is deleted after the parent it
 *   protected. A running one never is. Whether a running parent still counts
 *   a Delegation needs the parent's graph; a parent whose runbook cannot be
 *   parsed keeps its Delegations protected (`parent unreadable`) rather than
 *   aborting the prune.
 * - **A running run needs its Owner Token or a human's confirmation.** A
 *   top-level run selected by filter is deleted only when a human at an
 *   interactive terminal confirms it ({@link PrunePlanInput.confirmRunning}),
 *   and the delete then carries the human's audit; otherwise it is retained.
 *   A running Child Run is never offered: an Inline Child runs on its root's
 *   token and goes with its root, and a Delegation is ended by its own token,
 *   its claiming agent's `release`, or its parent's owner — the same
 *   restriction as the human escape hatch (`human-stop.ts`). It is retained as
 *   `child run`, with the recoveries that reach it.
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
import { getErrorMessage } from '../errors.js';
import { delegationStanding } from './delegation-child.js';
import type { ExecutionLeaseRefusal } from './execution-lease.js';
import { childRunRemedy, type RunLookup } from './human-stop.js';
import { currentInlineReservation } from './inline-child.js';
import type { ProcessIdentity } from './process-identity.js';
import type { RunId } from './run-id.js';
import {
  inlineDescendantsOf,
  planRunDeletions,
  refuseDeletionUnderLease,
  type RunDeletion,
} from './run-deletion.js';
import type { VersionedRunState } from './storage/runbook-store.js';
import type { HumanConfirmationAudit, Lifecycle, RunbookState } from './types.js';

/** Code of {@link CurrentChildProtectedRefusal}. */
export const CURRENT_CHILD_PROTECTED_CODE = 'CURRENT_CHILD_PROTECTED';

/**
 * Why a selected run was kept rather than deleted.
 *
 * - `token required` — a running top-level run, with no Owner Token naming it
 *   and no human at a terminal to confirm it.
 * - `not confirmed` — a running top-level run the human declined to delete.
 * - `child run` — a running Child Run, which is never deleted without its own
 *   token or its root's.
 * - `uncollected` — a terminal Current Child whose result its running parent
 *   has not Collected.
 * - `current child` — a running Current Child: its parent still counts it.
 * - `parent unreadable` — a Delegation whose running parent's runbook could
 *   not be parsed, so whether it still counts the child is unknown.
 * - `execution in progress` — a live attempt holds a run the delete removes.
 */
export type PruneRetentionReason =
  | 'token required'
  | 'not confirmed'
  | 'child run'
  | 'uncollected'
  | 'current child'
  | 'parent unreadable'
  | 'execution in progress';

/** A selected run the prune keeps, with its reason. */
export type RetainedRun =
  | {
      /** The run as listed. */
      readonly run: VersionedRunState;
      /** Why it is kept. */
      readonly reason: Exclude<PruneRetentionReason, 'child run' | 'parent unreadable'>;
    }
  | {
      /** The run as listed. */
      readonly run: VersionedRunState;
      /** Why it is kept. */
      readonly reason: 'child run' | 'parent unreadable';
      /** What to do instead (`child run`), or why the parent could not be read. */
      readonly detail: string;
    };

/** A delete the prune makes. */
export interface PlannedDeletion extends RunDeletion {
  /**
   * The human who confirmed deleting this running run without its Owner
   * Token. The row is deleted, so the front end reports it with the delete.
   */
  readonly confirmedBy?: HumanConfirmationAudit;
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

/** Parse a run's graph from its state. */
export type LoadSteps = (
  state: RunbookState,
) => readonly ResolvedStep[] | Promise<readonly ResolvedStep[]>;

/** Input to {@link planPrune}. */
export interface PrunePlanInput {
  /** One listing of the store (`RunbookStateManager.listWithVersion`). */
  readonly runs: readonly VersionedRunState[];
  /** The lifecycles the prune's filter selects. */
  readonly select: PruneSelection;
  /** The run `--token` names, if any: deleted whatever its lifecycle, unless refused. */
  readonly owned: VersionedRunState | null;
  /**
   * Ask the human at an interactive terminal whether to make a delete of a
   * running top-level run no token names, resolving to who confirmed it and
   * when, or `undefined` for anything but yes. Absent when there is no such
   * human — a pipe, an agent's shell, an MCP call, or `--dry-run` — and every
   * such run is then retained `token required`. Called only for a delete the
   * lease rule allows.
   */
  readonly confirmRunning?: (deletion: RunDeletion) => Promise<HumanConfirmationAudit | undefined>;
  /** Parse a run's graph from its state: a Delegation's standing needs its parent's. */
  readonly loadSteps: LoadSteps;
  /** Start-identity source for the lease rule; defaults to the process-wide one. */
  readonly processIdentity?: ProcessIdentity;
}

/** Outcome of {@link planPrune}. */
export type PrunePlan =
  | {
      readonly kind: 'planned';
      /** The deletes to make, in order: the owned run's first, each parent before its children. */
      readonly deletions: readonly PlannedDeletion[];
      /** Every selected run kept, with its reason, in listing order. */
      readonly retained: readonly RetainedRun[];
    }
  | {
      /** The run `--token` names may not be deleted: nothing is. */
      readonly kind: 'refused';
      readonly refusal: ExecutionLeaseRefusal | CurrentChildProtectedRefusal;
    };

/** Whether a running parent still counts a run as its Current Child. */
export type ChildProtection =
  | {
      /** A top-level run, or a child nothing counts. */
      readonly kind: 'unprotected';
    }
  | {
      readonly kind: 'protected';
      /** The running parent that counts it. */
      readonly parent: VersionedRunState;
    }
  | {
      /** The parent's runbook could not be parsed: treated as protected. */
      readonly kind: 'undetermined';
      readonly parent: VersionedRunState;
      /** Why the parent's graph could not be read. */
      readonly reason: string;
    };

/** A parent's graph, read once per listing. */
type ParentSteps =
  | { readonly kind: 'read'; readonly steps: readonly ResolvedStep[] }
  | { readonly kind: 'unreadable'; readonly reason: string };

/**
 * Decide, over one listing, which running parent still counts each run as its
 * Current Child.
 *
 * An Inline Child is counted while its parent's cursor rests on the
 * reservation that names it; a Delegation while its parent would still
 * Collect it (`delegationStanding`). A top-level run, an orphaned Delegation,
 * and a child whose parent finished or is not listed are not protected. Each
 * parent's runbook is parsed at most once; a parse that fails leaves that
 * parent's Delegations `undetermined`, never aborting the caller.
 *
 * @param runs - One listing of the store.
 * @param loadSteps - Parse a run's graph from its state.
 * @returns The protection of a run drawn from `runs`.
 * @throws {Error} From the returned function, when a run's linkage kind is
 *   unhandled — a defect, not an operator condition.
 */
export function childProtection(
  runs: readonly VersionedRunState[],
  loadSteps: LoadSteps,
): (run: VersionedRunState) => Promise<ChildProtection> {
  const byId = new Map<RunId, VersionedRunState>(runs.map((run) => [run.state.id, run]));
  const graphs = new Map<RunId, Promise<ParentSteps>>();
  const stepsOf = (parent: VersionedRunState): Promise<ParentSteps> => {
    let graph = graphs.get(parent.state.id);
    if (graph === undefined) {
      graph = (async (): Promise<ParentSteps> => {
        try {
          return { kind: 'read', steps: await loadSteps(parent.state) };
        } catch (error) {
          return { kind: 'unreadable', reason: getErrorMessage(error) };
        }
      })();
      graphs.set(parent.state.id, graph);
    }
    return graph;
  };
  return async (run) => {
    const linkage = run.linkage;
    if (linkage === null || linkage.kind === 'orphaned_delegation') return { kind: 'unprotected' };
    const parent = byId.get(linkage.parentRunId);
    if (parent === undefined || (parent.state.lifecycle ?? 'running') !== 'running') {
      return { kind: 'unprotected' };
    }
    switch (linkage.kind) {
      case 'inline':
        return currentInlineReservation(parent.state)?.runId === run.state.id
          ? { kind: 'protected', parent }
          : { kind: 'unprotected' };
      case 'delegation': {
        const graph = await stepsOf(parent);
        if (graph.kind === 'unreadable') {
          return { kind: 'undetermined', parent, reason: graph.reason };
        }
        const standing = delegationStanding(linkage, run.state.id, parent.state, graph.steps);
        return standing.kind === 'current'
          ? { kind: 'protected', parent }
          : { kind: 'unprotected' };
      }
      default: {
        const _exhaustive: never = linkage;
        throw new Error(`Unhandled child linkage: ${JSON.stringify(_exhaustive)}`);
      }
    }
  };
}

/**
 * The reason a protected Current Child is retained.
 *
 * @param run - The protected child.
 * @returns `current child` while it runs, `uncollected` once terminal.
 */
function protectionReason(run: VersionedRunState): 'current child' | 'uncollected' {
  return (run.state.lifecycle ?? 'running') === 'running' ? 'current child' : 'uncollected';
}

/**
 * Why a Delegation is kept when its parent's runbook cannot be parsed.
 *
 * @param run - The Delegation.
 * @param protection - Its undetermined protection.
 * @returns The explanation.
 */
function unreadableDetail(
  run: VersionedRunState,
  protection: Extract<ChildProtection, { readonly kind: 'undetermined' }>,
): string {
  return `Whether run ${protection.parent.state.id} still counts its delegation ${run.state.id} is unknown: its runbook ${protection.parent.state.runbook.path} could not be parsed (${protection.reason}), so the delegation is kept as if it does.`;
}

/**
 * The refusal for `--token` naming a protected Current Child.
 *
 * @param run - The child the token names.
 * @param protection - Its protection: protected or undetermined.
 * @returns The refusal.
 */
function protectedRefusal(
  run: VersionedRunState,
  protection: Exclude<ChildProtection, { readonly kind: 'unprotected' }>,
): CurrentChildProtectedRefusal {
  const parent = protection.parent;
  const parentStep = run.linkage?.parentStep ?? '';
  const fields = {
    kind: 'current_child_protected',
    code: CURRENT_CHILD_PROTECTED_CODE,
    runId: run.state.id,
    parentRunId: parent.state.id,
    parentStep,
  } as const;
  if (protection.kind === 'undetermined') {
    return {
      ...fields,
      message: `${unreadableDetail(run, protection)} Nothing was deleted. It becomes prunable once the parent's runbook parses again and the parent no longer counts it, or the parent finishes or is pruned.`,
    };
  }
  const why =
    (run.state.lifecycle ?? 'running') === 'running'
      ? 'is still running for it'
      : 'holds a result it has not collected';
  return {
    ...fields,
    message: `Run ${run.state.id} is the current child of run ${parent.state.id} at ${parentStep} and ${why}, so nothing was deleted. It becomes prunable once the parent collects it, cancels it with \`rundown retry\`, finishes, or is pruned.`,
  };
}

/**
 * Decide what a prune deletes and what it keeps.
 *
 * In order: refuse the owned run when it is a protected Current Child, or its
 * delete under the lease rule; sort the selected runs into deletable finished
 * runs, running top-level runs to confirm, and runs kept (protected,
 * undetermined, a running Child Run, or no human to ask); ask the human about
 * each running top-level run whose delete the lease rule allows; plan the
 * finished runs' deletes. Each delete is planned and checked against the
 * lease once. Then protection ends for every Current Child whose parent a
 * planned delete removes: a terminal one is deleted after its parent (if the
 * lease allows), a running one is kept as a `child run`. A run a planned
 * delete removes with its root is reported with that delete, never as
 * retained.
 *
 * @param input - The listing, selection, owned run and frontend callables.
 * @returns The deletes and retained runs, or the refusal of the owned run.
 * @throws {Error} When a run's linkage kind is unhandled, or an inline chain
 *   is deeper than any run can compose — defects, not operator conditions —
 *   or when `confirmRunning` rejects.
 */
export async function planPrune(input: PrunePlanInput): Promise<PrunePlan> {
  const { runs, owned } = input;
  const identity = input.processIdentity;
  const protectionOf = childProtection(runs, input.loadSteps);
  const byId = new Map<RunId, VersionedRunState>(runs.map((run) => [run.state.id, run]));
  const lookup: RunLookup = (runId) => byId.get(runId);
  const remedy = async (run: VersionedRunState, parentDeleted: boolean): Promise<string> => {
    const clause = await childRunRemedy(run, {
      lookup,
      counted: async (delegation) =>
        !parentDeleted && (await protectionOf(delegation)).kind === 'protected',
    });
    return `Run ${run.state.id} is a running child run, which prune deletes only with its own token or its root; ${clause}.`;
  };

  const deletions: PlannedDeletion[] = [];
  const deleted = new Set<RunId>();
  const plan = (deletion: PlannedDeletion): void => {
    deletions.push(deletion);
    for (const run of [deletion.root, ...deletion.inlineDescendants]) deleted.add(run.state.id);
  };
  // The one delete that removes `run`, as its root.
  const deletionOf = (run: VersionedRunState): RunDeletion => ({
    root: run,
    inlineDescendants: inlineDescendantsOf(run.state.id, runs),
  });

  if (owned !== null) {
    const protection = await protectionOf(owned);
    if (protection.kind !== 'unprotected') {
      return { kind: 'refused', refusal: protectedRefusal(owned, protection) };
    }
    const deletion = deletionOf(owned);
    const refusal = refuseDeletionUnderLease(deletion, identity);
    if (refusal !== undefined) return { kind: 'refused', refusal };
    plan(deletion);
  }

  const finished: VersionedRunState[] = [];
  const confirmable: VersionedRunState[] = [];
  const protectedChildren: { readonly run: VersionedRunState; readonly parentId: RunId }[] = [];
  const retained: RetainedRun[] = [];
  for (const run of runs) {
    if (run.state.id === owned?.state.id) continue;
    const lifecycle = run.state.lifecycle ?? 'running';
    if (!input.select[lifecycle]) continue;
    const protection = await protectionOf(run);
    if (protection.kind === 'protected') {
      protectedChildren.push({ run, parentId: protection.parent.state.id });
    } else if (protection.kind === 'undetermined') {
      retained.push({
        run,
        reason: 'parent unreadable',
        detail: unreadableDetail(run, protection),
      });
    } else if (lifecycle !== 'running') {
      finished.push(run);
    } else if (run.linkage !== null) {
      // Confirmation is for a top-level run, as the escape hatch is.
      retained.push({ run, reason: 'child run', detail: await remedy(run, false) });
    } else if (input.confirmRunning === undefined) {
      retained.push({ run, reason: 'token required' });
    } else {
      confirmable.push(run);
    }
  }

  const confirmed: PlannedDeletion[] = [];
  for (const run of confirmable) {
    const deletion = deletionOf(run);
    if (refuseDeletionUnderLease(deletion, identity) !== undefined) {
      retained.push({ run, reason: 'execution in progress' });
      continue;
    }
    const confirmedBy = await input.confirmRunning?.(deletion);
    if (confirmedBy === undefined) {
      retained.push({ run, reason: 'not confirmed' });
    } else {
      confirmed.push({ ...deletion, confirmedBy });
    }
  }

  const coveredByConfirmed = new Set<RunId>(
    confirmed.flatMap((deletion) => deletion.inlineDescendants.map((run) => run.state.id)),
  );
  const unplanned = finished.filter(
    (run) => !deleted.has(run.state.id) && !coveredByConfirmed.has(run.state.id),
  );
  for (const deletion of planRunDeletions(unplanned, runs)) {
    if (refuseDeletionUnderLease(deletion, identity) === undefined) {
      plan(deletion);
    } else {
      retained.push({ run: deletion.root, reason: 'execution in progress' });
    }
  }
  for (const deletion of confirmed) plan(deletion);

  // Protection ends with the parent's delete: settle children level by level,
  // so a child's own children see its delete.
  let pending = protectedChildren;
  for (let settled = true; settled; ) {
    settled = false;
    const waiting: typeof pending = [];
    for (const child of pending) {
      if (deleted.has(child.run.state.id)) continue;
      if (!deleted.has(child.parentId)) {
        waiting.push(child);
        continue;
      }
      settled = true;
      const { run } = child;
      if ((run.state.lifecycle ?? 'running') === 'running') {
        retained.push({ run, reason: 'child run', detail: await remedy(run, true) });
        continue;
      }
      const deletion = deletionOf(run);
      if (refuseDeletionUnderLease(deletion, identity) === undefined) {
        plan(deletion);
      } else {
        retained.push({ run, reason: 'execution in progress' });
      }
    }
    pending = waiting;
  }
  for (const { run } of pending) retained.push({ run, reason: protectionReason(run) });

  const order = new Map<RunId, number>(runs.map((run, index) => [run.state.id, index]));
  return {
    kind: 'planned',
    deletions,
    retained: retained
      .filter(({ run }) => !deleted.has(run.state.id))
      .sort(
        (left, right) => (order.get(left.run.state.id) ?? 0) - (order.get(right.run.state.id) ?? 0),
      ),
  };
}
