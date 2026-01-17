// packages/cli/src/commands/prune.ts

import type { Command } from 'commander';
import { RunbookStateManager } from '@rundown/core';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputManager } from '../services/output-manager.js';
import { getStatus } from '../helpers/status.js';

interface PruneOptions {
  dryRun?: boolean;
  completed?: boolean;
  active?: boolean;
  inactive?: boolean;
  all?: boolean;
  json?: boolean;
}

/**
 * Registers the 'prune' command for removing runbook state.
 * @param program - Commander program instance to register the command on
 */
export function registerPruneCommand(program: Command): void {
  program
    .command('prune')
    .description('Remove runbook state (does not delete runbook files)')
    .option('--dry-run', 'Show what would be removed without deleting')
    .option('--completed', 'Prune completed runbook state')
    .option('--active', 'Prune active runbook state')
    .option('--inactive', 'Prune inactive runbook state')
    .option('--all', 'Prune all runbook state')
    .option('--json', 'Output as JSON')
    .action(async (options: PruneOptions) => {
      await withErrorHandling(async () => {
        const cwd = getCwd();
        const output = new OutputManager({ json: options.json });
        const writer = output.getWriter();

        const manager = new RunbookStateManager(cwd);
        const states = await manager.list();
        const activeState = await manager.getActive();
        const stashedId = await manager.getStashedRunbookId();

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

        // Enrich items with status string for display
        const enrichedItems = toDelete.map(state => ({
          ...state,
          _status: getStatus(state, activeState, stashedId)
        }));

        if (toDelete.length === 0) {
          if (output.isJson()) {
            writer.writeJson([]);
          } else {
            writer.writeLine('No runbook state to prune.');
          }
          return;
        }

        if (options.dryRun) {
          if (!output.isJson()) {
            writer.writeLine('Would remove state for:');
          }
          
          output.list(enrichedItems, [
            { header: 'ID', key: 'id' },
            { header: 'STATUS', get: (item) => item._status },
            { header: 'RUNBOOK', key: 'runbook' },
            { header: 'TITLE', get: (item) => item.title ? `[${item.title}]` : '' }
          ], {
            // For JSON, clean up internal fields
            jsonMapper: (item) => {
              const { _status: _, ...rest } = item;
              return { ...rest, status: item._status };
            }
          });
          return;
        }

        if (!output.isJson()) {
          writer.writeLine('Pruned state for:');
        }

        // Perform deletion
        for (const state of toDelete) {
           await manager.delete(state.id);
        }

        output.list(enrichedItems, [
            { header: 'ID', key: 'id' },
            { header: 'STATUS', get: (item) => item._status },
            { header: 'RUNBOOK', key: 'runbook' },
            { header: 'TITLE', get: (item) => item.title ? `[${item.title}]` : '' }
          ], {
            jsonMapper: (item) => {
              const { _status: _, ...rest } = item;
              return { ...rest, status: item._status };
            }
        });

        if (!output.isJson()) {
          writer.writeLine(`\nTotal: ${String(toDelete.length)} runbook(s).`);
        }
      });
    });
}
