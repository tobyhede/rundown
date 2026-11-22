/**
 * What deleting a run removes, and whether it may (#903).
 *
 * Deleting a run deletes its Inline Children with it, transitively: an Inline
 * Child carries no Owner Token of its own, so once the run whose token
 * authorized it is gone nothing can reach it (the `runs_unlink_children`
 * trigger in `storage/schema.ts`). A delete therefore decides about every run
 * it removes, not only the one it names: the execution-lease rule applies to
 * each, and the conditional delete names each at the version it was read at.
 *
 * Pure functions over one listing (`RunbookStateManager.listWithVersion`),
 * so a front end such as `rundown prune` derives the chain from storage linkage
 * rather than re-deriving it.
 *
 * @module runbook/run-deletion
 */

import type { RunId } from './run-id.js';
import type { VersionedRunState } from './storage/runbook-store.js';
import { refuseUnderLease, type ExecutionLeaseRefusal } from './execution-lease.js';
import { sharedProcessIdentity, type ProcessIdentity } from './process-identity.js';

/** One run a delete names, with every run the delete removes alongside it. */
export interface RunDeletion {
  /** The run the delete names. */
  readonly root: VersionedRunState;
  /** Its Inline Children, transitively, each at the version it was read at. */
  readonly inlineDescendants: readonly VersionedRunState[];
}

/**
 * The Inline Children of a run, transitively: exactly the rows a delete of it
 * removes with it.
 *
 * @param runId - The run whose inline descendants to collect.
 * @param runs - One listing of the store.
 * @returns The inline descendants, parents before their children.
 */
export function inlineDescendantsOf(
  runId: RunId,
  runs: readonly VersionedRunState[],
): VersionedRunState[] {
  const descendants: VersionedRunState[] = [];
  const parents = new Set<RunId>([runId]);
  let frontier: readonly RunId[] = [runId];
  while (frontier.length > 0) {
    const level = runs.filter(
      (run) =>
        run.linkage?.kind === 'inline' &&
        frontier.includes(run.linkage.parentRunId) &&
        !parents.has(run.state.id),
    );
    for (const run of level) parents.add(run.state.id);
    descendants.push(...level);
    frontier = level.map((run) => run.state.id);
  }
  return descendants;
}

/**
 * Whether a run is an Inline Child some running run above it in its inline
 * chain has not finished with.
 *
 * Such a child is never deleted on its own, whatever its lifecycle: the
 * running parent's reservation still names it, so deleting it would make the
 * parent's next progression launch it again from scratch, re-running its
 * commands and losing its result. It goes only with its root.
 *
 * @param run - The run to test.
 * @param runs - One listing of the store.
 * @returns True when an inline ancestor of `run` is running; false for a run
 *   that is not an Inline Child.
 */
export function hasRunningInlineAncestor(
  run: VersionedRunState,
  runs: readonly VersionedRunState[],
): boolean {
  const byId = new Map(runs.map((listed) => [listed.state.id, listed]));
  const seen = new Set<RunId>();
  let linkage = run.linkage;
  while (linkage?.kind === 'inline' && !seen.has(linkage.parentRunId)) {
    seen.add(linkage.parentRunId);
    const parent = byId.get(linkage.parentRunId);
    if (parent === undefined) return false;
    if ((parent.state.lifecycle ?? 'running') === 'running') return true;
    linkage = parent.linkage;
  }
  return false;
}

/**
 * Group the runs selected for deletion into the deletes that remove them.
 *
 * A selected run whose inline ancestor is also selected is removed by that
 * ancestor's delete, so it is not a delete of its own. Each delete carries
 * every inline descendant of its root — selected or not — because the
 * delete removes all of them.
 *
 * @param selected - The runs chosen for deletion.
 * @param runs - One listing of the store, which `selected` is drawn from.
 * @returns One deletion per root, in the order of `selected`.
 */
export function planRunDeletions(
  selected: readonly VersionedRunState[],
  runs: readonly VersionedRunState[],
): RunDeletion[] {
  const covered = new Set<RunId>();
  for (const run of selected) {
    for (const descendant of inlineDescendantsOf(run.state.id, runs)) {
      covered.add(descendant.state.id);
    }
  }
  return selected
    .filter((run) => !covered.has(run.state.id))
    .map((root) => ({ root, inlineDescendants: inlineDescendantsOf(root.state.id, runs) }));
}

/**
 * Apply the execution-lease rule for `prune` to every run a delete removes.
 *
 * An attempt In Progress anywhere in the chain refuses the delete; an
 * Interrupted one does not, since the delete removes its lease with its row.
 *
 * @param deletion - The delete to decide about.
 * @param identity - Start-identity source; defaults to the process-wide one.
 * @returns The first refusal, root first, or `undefined` when the delete may
 *   proceed.
 */
export function refuseDeletionUnderLease(
  deletion: RunDeletion,
  identity: ProcessIdentity = sharedProcessIdentity(),
): ExecutionLeaseRefusal | undefined {
  for (const run of [deletion.root, ...deletion.inlineDescendants]) {
    const refusal = refuseUnderLease(run.state.id, run.state, run.lease, 'prune', identity);
    if (refusal !== undefined) return refusal;
  }
  return undefined;
}
