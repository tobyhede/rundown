import {
  type RunbookStateManager,
  type RunId,
  type SessionService,
  StaleRunbookStateError,
  isError,
} from '@rundown-org/core';

/**
 * Determine whether an active-runbook load failure can be treated as stale local state.
 *
 * @param error - Error thrown while resolving or loading the active default-stack runbook
 * @returns True when cleanup commands may safely remove the default-stack entry
 */
export function isRecoverableActiveStackError(error: Error): boolean {
  return (
    error instanceof StaleRunbookStateError ||
    error.message.includes('dynamic-step snapshots') ||
    (isError(error) && error.name === 'SyntaxError')
  );
}

/**
 * Remove the current top default-stack entry and any matching session references.
 *
 * @param manager - State manager used to load the session and delete state files
 * @param sessionService - Session service used to release session references
 * @returns The removed runbook id, or null when the default stack is already empty
 */
export async function cleanupOrphanedActiveStack(
  manager: RunbookStateManager,
  sessionService: SessionService,
): Promise<RunId | null> {
  const session = await manager.loadSession();
  const orphanId = session.defaultStack[session.defaultStack.length - 1];
  if (!orphanId) {
    return null;
  }

  await manager.delete(orphanId);
  await sessionService.releaseRunbook(orphanId);
  return orphanId;
}
