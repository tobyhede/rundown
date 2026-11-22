/**
 * Child linkage: the parent coordinate a Child Run records in its own row
 * (#903, ADR 0005).
 *
 * A child row names the parent run, the parent unit it runs for, and the frame
 * entry that reserved it. The linkage lives in the `runs.parent_*` columns,
 * nullable all-or-none, and is written once when the child row is inserted.
 * It never changes afterwards: a child never writes its parent, and its parent
 * never rewrites the child's linkage — a re-entry reserves a new child instead.
 *
 * @module runbook/child-linkage
 */

import type { RunId } from './run-id.js';
import type { FrameKey } from './targeting.js';

/**
 * How a Child Run is owned relative to its parent.
 *
 * - `inline` — the same agent owns both; the parent's Owner Token authorizes
 *   the child, which has no token of its own (#903).
 * - `delegation` — a different agent owns the child through its own token,
 *   inserted by `rundown claim` (#904).
 */
export type ChildKind = 'inline' | 'delegation';

/** The parent coordinate a child row records. */
export interface ChildLinkage {
  /** How the child is owned relative to its parent. */
  readonly kind: ChildKind;
  /** The parent run. */
  readonly parentRunId: RunId;
  /** The qualified parent unit the child runs for (`step.substep`). */
  readonly parentStep: string;
  /** The parent frame the reservation was made in. */
  readonly parentFrameKey: FrameKey;
  /** The parent frame entry the reservation was made at. */
  readonly parentEntry: number;
  /**
   * The agent id `rundown claim --agent-id` recorded for a Delegation (#904),
   * the identity a later `release` is matched against. Absent for an Inline
   * Child and for a claim made without one.
   */
  readonly claimedBy?: string;
}

/**
 * A Delegation whose parent run was pruned (#904). Its row keeps the parent
 * unit and frame entry it ran for, and that it was a Delegation, but no
 * longer names the parent: the run is gone, and the foreign key admits no
 * dangling reference. No one can Collect its result, so every command but
 * `stop` is refused `PARENT_RUN_FINISHED`.
 */
export interface OrphanedDelegationLinkage {
  /** Discriminant: a Delegation whose parent was pruned. */
  readonly kind: 'orphaned_delegation';
  /** The qualified parent unit the child ran for (`step.substep`). */
  readonly parentStep: string;
  /** The parent frame the reservation was made in. */
  readonly parentFrameKey: FrameKey;
  /** The parent frame entry the reservation was made at. */
  readonly parentEntry: number;
  /** The agent id `rundown claim --agent-id` recorded, if any. */
  readonly claimedBy?: string;
}

/**
 * The linkage a run row records, as read: a live parent coordinate, or a
 * Delegation whose parent was pruned. Written linkage is always a
 * {@link ChildLinkage}; only the `runs_unlink_children` trigger produces the
 * orphaned form.
 */
export type RunLinkage = ChildLinkage | OrphanedDelegationLinkage;
