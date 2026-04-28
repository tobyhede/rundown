import { mergeEffectiveVars } from './effective-vars.js';
import { SessionService } from './session-service.js';
import { RunbookStateManager } from './state.js';

/**
 * Minimal active run scope needed by helper CLIs.
 */
export interface ActiveRunScope {
  /** Active runbook WorkPath, when an active state provides one. */
  workPath?: string;
  /** Active runbook ContextId, when an active state provides one. */
  contextId?: string;
}

/**
 * Read the active runbook's path scope through the validated state loader.
 *
 * This is the narrow public surface for tools that only need active
 * `WorkPath` / `ContextId` and should not wire together state/session
 * internals themselves.
 *
 * @param cwd - Project root containing `.rundown/session.json`.
 * @returns Active run scope values, or an empty object when no runbook is active.
 * @throws {Error} If active runbook state exists but fails validation or cannot be read.
 */
export async function readActiveRunScope(cwd: string): Promise<ActiveRunScope> {
  const manager = new RunbookStateManager(cwd);
  const sessionService = new SessionService(manager);
  const state = await sessionService.getActive();
  if (!state) return {};

  const vars = mergeEffectiveVars(state);
  const workPath = vars.WorkPath;
  const contextId = vars.ContextId;
  const scope: ActiveRunScope = {};

  if (typeof workPath === 'string' || typeof workPath === 'number') {
    scope.workPath = String(workPath);
  }
  if (typeof contextId === 'string' || typeof contextId === 'number') {
    scope.contextId = String(contextId);
  }

  return scope;
}
