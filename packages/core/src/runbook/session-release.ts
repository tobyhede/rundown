import type { RunId } from './run-id.js';
import type { SessionData } from './state.js';

/**
 * Why a run is being released from the session.
 *
 * A **fact the caller holds**, not a policy it chooses. The caller knows which
 * run it acted on; converting that into "should this claim survive?" is domain
 * logic, and this module owns it. Sixteen call sites each performing that
 * conversion for themselves is what let one of them convert differently.
 *
 * - `addressed` — the caller acted on this run. It reached terminal, or was
 *   commanded terminal, and the release is the caller finishing with it.
 * - `collateral` — the run was swept up so that an addressed run could close.
 *   An inline descendant forced terminal under its root, for instance.
 * - `discarded` — the run is being destroyed. `prune` and the cleanup paths.
 *   Required as its own arm: spelling a destroy path `addressed` would retain
 *   claims over a run that is about to stop existing.
 */
export type ReleaseRole = 'addressed' | 'collateral' | 'discarded';

/**
 * Every {@link ReleaseRole}, for exhaustive iteration in tests and callers.
 *
 * Declared `as const` and typed by its own members, so adding an arm to
 * `ReleaseRole` without adding it here is a compile error rather than a silently
 * shorter loop.
 */
export const RELEASE_ROLES = [
  'addressed',
  'collateral',
  'discarded',
] as const satisfies readonly ReleaseRole[];

/**
 * What a release does to the claims a run controls.
 *
 * `retain-as-terminal-evidence` writes nothing: the claim record stays in the
 * session and its row stays active, so a holder presenting the bearer afterwards
 * resolves `terminal` and learns the run finished. `revoke` deletes the record,
 * and the store tombstones the row `superseded` — a holder presenting the bearer
 * is then told its authority was rotated.
 *
 * Deliberately not called `tombstone`. The tombstone is the artefact **revoking**
 * produces; naming the retained case after it is the collision this vocabulary
 * exists to remove.
 */
export type ClaimDisposition = 'retain-as-terminal-evidence' | 'revoke';

/**
 * Decide what a release does to one run's claims.
 *
 * The whole policy, in one place. Retention is the recoverable direction — a
 * retained claim is garbage-collected when its run is pruned, whereas a
 * revocation cannot be reconstructed — and it is also the majority case, so the
 * fail-safe answer and the common answer coincide.
 *
 * Takes the role alone. That a run's disposition depends only on its own role,
 * never on ordering and never on the other members of a batch, is the invariant
 * that lets this widen to `claimDisposition(role, claim)` later — when a
 * run-control claim and a delegated bearer over the same run want different
 * treatment — without touching a caller.
 *
 * @param role - Why the run is being released.
 * @returns What to do with the claims that run controls.
 */
export function claimDisposition(role: ReleaseRole): ClaimDisposition {
  switch (role) {
    case 'addressed':
      return 'retain-as-terminal-evidence';
    case 'collateral':
    case 'discarded':
      return 'revoke';
    // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable — exhaustive `never` arm
    default: {
      const _exhaustive: never = role;
      return _exhaustive;
    }
  }
}

/** One run's release, and the fact that explains it. */
export interface RunRelease {
  /** Run leaving the session's targeting structures. */
  readonly runId: RunId;
  /** Why, which decides the claim disposition. */
  readonly role: ReleaseRole;
}

/**
 * Project one release onto an in-memory session snapshot, in place.
 *
 * Removes the run from every session structure that targets it — the default
 * stack (all occurrences, since a duplicate entry is reachable), the stash slot,
 * and, when the role revokes, the claims it controls.
 *
 * **Synchronous and in-place** by requirement, not by preference. Several
 * dispositions reach this projection through a session callback that accepts a
 * synchronous in-place mutation and nothing else, so this must never become
 * async or start returning a new snapshot.
 *
 * @param session - Session snapshot, mutated in place.
 * @param release - The run to release, and why.
 * @returns Whether the run was present in any session structure. A retained
 *   claim counts as present, so re-applying an `addressed` release still
 *   reports `true` — it finds the claim it retained. Nothing in the tree
 *   branches on this beyond distinguishing "released" from "not found".
 */
export function projectRunRelease(session: SessionData, release: RunRelease): boolean {
  const { runId, role } = release;

  const stackLengthBefore = session.defaultStack.length;
  session.defaultStack = session.defaultStack.filter((id) => id !== runId);
  const removedFromDefaultStack = session.defaultStack.length !== stackLengthBefore;

  const revoking = claimDisposition(role) === 'revoke';
  let matchedClaim = false;
  for (const [claimKey, claim] of Object.entries(session.claims)) {
    if (claim.controlledRunId !== runId) continue;
    matchedClaim = true;
    if (revoking) delete session.claims[claimKey];
  }

  const removedFromStash = session.stashedRunbookId === runId;
  if (removedFromStash) session.stashedRunbookId = undefined;

  return removedFromDefaultStack || matchedClaim || removedFromStash;
}
