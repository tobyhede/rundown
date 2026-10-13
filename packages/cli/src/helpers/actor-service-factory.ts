import {
  RunbookActorService,
  type CommandExecutionServices,
  type RunbookStateManager,
} from '@rundown-org/core';
import { getBundledRunbooksPath } from './bundled-runbooks.js';
import { getHelperRegistry } from '../services/helper-registry.js';
import { getPluginRoot } from './plugin-root.js';
import { getPolicyEvaluator } from '../services/policy-context.js';

/**
 * Create the CLI-configured runbook actor service.
 *
 * Supplies the CLI's Category-A/C callables — command execution, the helper
 * registry, file-artifact search roots and the read-policy check — as DI
 * options. Each is captured by compiler invoke-input closures and is never
 * stored in persisted runbook context or snapshots.
 *
 * @param manager - State manager for the current project.
 * @param commandServices - Optional CLI command execution callables.
 * @returns Runbook actor service configured for this CLI process.
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
  });
}
