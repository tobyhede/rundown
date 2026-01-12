// packages/cli/src/commands/prune.ts

import type { Command } from 'commander';
import { WorkflowStateManager } from '@rundown/core';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';

interface PruneOptions {
  dryRun?: boolean;
  completed?: boolean;
  active?: boolean;
  inactive?: boolean;
  all?: boolean;
}

/**
 * Registers the 'prune' command for removing workflow state.
 * @param program - Commander program instance to register the command on
 */
export function registerPruneCommand(program: Command): void {
  program
    .command('prune')
    .description('Remove workflow state (does not delete runbook files)')
    .option('--dry-run', 'Show what would be removed without deleting')
    .option('--completed', 'Prune completed workflow state')
    .option('--active', 'Prune active workflow state')
    .option('--inactive', 'Prune inactive workflow state')
    .option('--all', 'Prune all workflow state')
    .action(async (options: PruneOptions) => {
      await withErrorHandling(async () => {
        const cwd = getCwd();
        const manager = new WorkflowStateManager(cwd);
        const states = await manager.list();
        const activeState = await manager.getActive();
        const stashedId = await manager.getStashedWorkflowId();

        // Default to --completed if no filter flags provided
        const hasFilter = options.completed ?? options.active ?? options.inactive ?? options.all;
        const pruneCompleted = options.all ?? options.completed ?? !hasFilter;
        const pruneActive = options.all ?? options.active;
        const pruneInactive = options.all ?? options.inactive;

        const toDelete = states.filter((state) => {
          const isActive = activeState?.id === state.id;
          const isStashed = state.id === stashedId;
          const isCompleted = state.variables.completed === true;
          const isInactive = !isActive && !isStashed && !isCompleted;

          if (pruneCompleted && isCompleted) return true;
          if (pruneActive && isActive) return true;
          if (pruneInactive && isInactive) return true;
          return false;
        });

        if (toDelete.length === 0) {
          console.log('No workflow state to prune.');
          return;
        }

        if (options.dryRun) {
          console.log('Would remove state for:');
          for (const state of toDelete) {
            const status = getStatus(state, activeState, stashedId);
            const title = state.title ? `  [${state.title}]` : '';
            console.log(`  ${state.id}  ${status}  ${state.workflow}${title}`);
          }
          return;
        }

        console.log('Pruned state for:');
        for (const state of toDelete) {
          const status = getStatus(state, activeState, stashedId);
          const title = state.title ? `  [${state.title}]` : '';
          console.log(`  ${state.id}  ${status}  ${state.workflow}${title}`);
          await manager.delete(state.id);
        }
        console.log(`\nTotal: ${String(toDelete.length)} workflow(s).`);
      });
    });
}

function getStatus(
  state: { id: string; variables: { completed?: boolean } },
  activeState: { id: string } | null,
  stashedId: string | null
): string {
  if (activeState?.id === state.id) return 'active';
  if (state.id === stashedId) return 'stashed';
  if (state.variables.completed) return 'complete';
  return 'inactive';
}
