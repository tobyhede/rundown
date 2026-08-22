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
 *
 * Module-private on purpose. A caller that can read the disposition can re-derive
 * the policy, which is the defect the role vocabulary replaced.
 */
type ClaimDisposition = 'retain-as-terminal-evidence' | 'revoke';

/**
 * The whole claim-retention policy, in one place.
 *
 * Retention is the recoverable direction — a retained claim is garbage-collected
 * when its run is pruned, whereas a revocation cannot be reconstructed — and it
 * is also the majority case, so the fail-safe answer and the common answer
 * coincide.
 *
 * A `switch` evaluated per call rather than a module-level `Record` keyed by the
 * union. Both are exhaustive — the `never` arm below fails the type check when a
 * role is added, exactly as a missing `Record` key would — but a `Record`
 * initialiser runs ONCE at module load, before a mutation runner can switch a
 * mutant on, so every entry in it is reported as a surviving mutant no matter
 * what the tests assert. Measured: applying `collateral: 'revoke'` -> `''` by
 * hand fails three tests, while the same mutation through Stryker survived. The
 * policy has to be reachable at call time to be testable at all.
 *
 * The unknown-role arm throws rather than falling back. It is unreachable from
 * typed code, so the only way to arrive there is a cast or a JS caller — a
 * programmer error, and one that must not be answered by silently retaining a
 * claim the caller asked to revoke.
 *
 * @param role - Why the run is being released.
 * @returns What the release does to the claims that run controls.
 * @throws {Error} When `role` is not a {@link ReleaseRole}.
 */
function claimDisposition(role: ReleaseRole): ClaimDisposition {
  switch (role) {
    case 'addressed':
      // Stryker disable next-line StringLiteral: equivalent — the sole consumer
      // tests `=== 'revoke'`, so every other string retains exactly as this one
      // does. Killing it would need a second comparison against a state the
      // types already make unreachable.
      return 'retain-as-terminal-evidence';
    case 'collateral':
    case 'discarded':
      return 'revoke';
    // Stryker disable all: unreachable — the exhaustive `never` arm
    default: {
      const unknown: never = role;
      throw new Error(`Unknown release role: ${String(unknown)}`);
    }
    // Stryker restore all
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
 * Remove one run from every session structure that targets it, in place.
 *
 * A run's disposition depends only on its own role, never on ordering and never
 * on the other members of the batch. That invariant is what lets
 * {@link claimDisposition} widen to a per-claim decision later — when a
 * run-control claim and a delegated bearer over the same run want different
 * treatment — without touching a caller.
 *
 * @param session - Session snapshot, mutated in place.
 * @param release - The run to release, and why.
 */
function projectOne(session: SessionData, release: RunRelease): void {
  const { runId, role } = release;

  // Every occurrence, not the topmost: a duplicate stack entry is reachable, and
  // a release means the run is no longer a target at all.
  session.defaultStack = session.defaultStack.filter((id) => id !== runId);

  if (claimDisposition(role) === 'revoke') {
    for (const [claimKey, claim] of Object.entries(session.claims)) {
      if (claim.controlledRunId === runId) delete session.claims[claimKey];
    }
  }

  if (session.stashedRunbookId === runId) session.stashedRunbookId = undefined;
}

/**
 * Project a batch of releases onto an in-memory session snapshot, in place.
 *
 * Removes each run from the default stack (all occurrences), the stash slot, and
 * — when its role revokes — the claims it controls.
 *
 * **Synchronous and in-place** by requirement, not by preference. Several
 * dispositions reach this projection through a session callback that accepts a
 * synchronous in-place mutation and nothing else, so this must never become
 * async or start returning a new snapshot.
 *
 * **Idempotent in effect and returns nothing.** A run that is absent, or already
 * released, is a no-op; re-applying a batch reaches the same session. There is
 * no released/not-found payload because the question a caller actually asks is
 * answered at the claim-resolution seam, not here.
 *
 * The whole batch is validated before any member is applied, so a rejected batch
 * leaves the session untouched rather than half-projected.
 *
 * @param session - Session snapshot, mutated in place.
 * @param releases - The runs to release, each with the fact that explains it.
 * @throws {Error} When two releases name the same run. One run cannot be released
 *   for two reasons in one batch, and a caller that built such a batch derived
 *   at least one of the roles from something other than what it did.
 */
export function projectRunReleases(session: SessionData, releases: readonly RunRelease[]): void {
  const seen = new Set<RunId>();
  for (const { runId } of releases) {
    if (seen.has(runId)) {
      throw new Error(`Run release batch names ${runId} more than once.`);
    }
    seen.add(runId);
  }

  for (const release of releases) projectOne(session, release);
}
