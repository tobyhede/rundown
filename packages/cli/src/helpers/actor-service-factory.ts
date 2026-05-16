import {
  RunbookActorService,
  type CommandExecutionServices,
  type RunbookStateManager,
} from '@rundown-org/core';
import { buildRunbookRef, resolveRunbookFile } from './resolve-runbook.js';
import { getHelperRegistry } from '../services/helper-registry.js';

/**
 * Create the CLI-configured runbook actor service.
 *
 * Supplies runtime runbook resolution as a DI callable for machine-owned
 * delegation issuance. The callable is captured by compiler invoke-input
 * closures and is never stored in persisted runbook context or snapshots.
 *
 * @param manager - State manager for the current project.
 * @param commandServices - Optional CLI command execution callables.
 * @returns Runbook actor service configured with CLI runbook discovery.
 */
export function createCliRunbookActorService(
  manager: RunbookStateManager,
  commandServices?: CommandExecutionServices,
): RunbookActorService {
  return new RunbookActorService(manager, {
    commandServices,
    helpers: getHelperRegistry(),
    resolveDelegationRunbook: async (runbookRef) => {
      const resolved = await resolveRunbookFile(manager.cwd, runbookRef);
      if (!resolved) return null;
      return {
        path: resolved.path,
        runbookRef,
        childRunbookRef: await buildRunbookRef(resolved),
      };
    },
  });
}
