// packages/cli/src/helpers/active-runbook-cleanup.ts
//
// Category-A recovery guard for the terminal (`complete` / `stop`) commands:
// verifies the top default-stack entry is actually unusable before removing it
// (#518). Architectural debt note: this session/state hygiene is arguably
// Category B (machine-owned logic living in the CLI); relocation into core is
// deliberately deferred to R5 per the delegation-lifecycle roadmap.

import {
  type RunbookState,
  type RunbookStateManager,
  type RunId,
  type SessionService,
  InvalidRunbookStateError,
  isError,
} from '@rundown-org/core';

/**
 * Determine whether an active-runbook load failure can be treated as invalid local state.
 *
 * @param error - Error thrown while resolving or loading the active default-stack runbook
 * @returns True when cleanup commands may safely remove the default-stack entry
 */
export function isRecoverableActiveStackError(error: Error): boolean {
  return (
    error instanceof InvalidRunbookStateError ||
    error.message.includes('dynamic-step snapshots') ||
    (isError(error) && error.name === 'SyntaxError')
  );
}

/**
 * Typed outcome of an orphaned-active-stack cleanup attempt.
 *
 * - `removed` — the top entry was verified unusable and deleted.
 * - `empty-stack` — nothing to clean; the default stack is empty.
 * - `healthy-top` — the top entry loads cleanly; it is NOT the orphan and
 *   nothing was deleted. Callers must surface their original error instead.
 */
export type OrphanCleanupResult =
  | { readonly kind: 'removed'; readonly runId: RunId }
  | { readonly kind: 'empty-stack' }
  | { readonly kind: 'healthy-top'; readonly runId: RunId };

/**
 * Remove the top default-stack entry only after verifying it is unusable (#518).
 *
 * Loads the top entry first: a clean load means the top is a valid run —
 * possibly with a corrupt inline ancestor deeper in the stack — and deleting
 * it would destroy live state, so the function returns `healthy-top` without
 * deleting. Only a missing state file or a recoverable snapshot failure
 * (invalid schema, corrupt JSON, legacy dynamic-step snapshot) authorizes
 * deletion. Deletions leave a debug-level `lifecycle-write` trail via
 * `RunbookStateManager.delete`. Healthy-top soundness relies on the atomic
 * temp-file+rename write invariant of writeJsonFileAtomic: a concurrent save
 * can never expose a torn state file to this probe.
 *
 * @param manager - State manager used to load the session and delete state files
 * @param sessionService - Session service used to release session references
 * @returns Typed cleanup outcome
 * @throws {unknown} Rethrows non-recoverable load errors (permissions, IO)
 */
export async function cleanupOrphanedActiveStack(
  manager: RunbookStateManager,
  sessionService: SessionService,
): Promise<OrphanCleanupResult> {
  const session = await manager.loadSession();
  const topId = session.defaultStack[session.defaultStack.length - 1];
  if (!topId) {
    return { kind: 'empty-stack' };
  }

  let topState: RunbookState | null;
  try {
    topState = await manager.load(topId);
  } catch (error) {
    if (isError(error) && isRecoverableActiveStackError(error)) {
      topState = null; // verified unusable — safe to remove
    } else {
      throw error;
    }
  }
  if (topState !== null) {
    return { kind: 'healthy-top', runId: topId };
  }

  await manager.delete(topId);
  await sessionService.releaseRunbook(topId);
  return { kind: 'removed', runId: topId };
}
