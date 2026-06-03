import {
  RunbookActorService,
  type CommandExecutionServices,
  type RunbookStateManager,
  generateRunId,
} from '@rundown-org/core';
import { getBundledRunbooksPath } from './bundled-runbooks.js';
import { buildRunbookRef, resolveRunbookFile } from './resolve-runbook.js';
import { getHelperRegistry } from '../services/helper-registry.js';
import { getPluginRoot } from './plugin-root.js';
import { getPolicyEvaluator } from '../services/policy-context.js';

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
  const pluginRoot = getPluginRoot();
  const fileArtifactSearchRoots = [...(pluginRoot ? [pluginRoot] : []), getBundledRunbooksPath()];
  const evaluator = getPolicyEvaluator();

  return new RunbookActorService(manager, {
    commandServices,
    helpers: getHelperRegistry(),
    fileArtifactSearchRoots,
    allowFileArtifactRead: (filePath) => evaluator.checkPath(filePath, 'read').allowed,
    resolveDelegationRunbook: async (runbookRef) => {
      const resolved = await resolveRunbookFile(manager.cwd, runbookRef);
      if (!resolved) return null;
      return {
        path: resolved.path,
        runbookRef,
        childRunbookRef: await buildRunbookRef(resolved),
      };
    },
    resolveInlineRunbook: async (runbookRef) => {
      const resolved = await resolveRunbookFile(manager.cwd, runbookRef);
      if (!resolved) return null;
      return {
        path: resolved.path,
        runbookRef,
        childRunbookRef: await buildRunbookRef(resolved),
      };
    },
    generateInlineChildRunId: generateRunId,
    inlineLaunchNow: () => new Date().toISOString(),
  });
}
