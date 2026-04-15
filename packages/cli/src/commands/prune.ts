// packages/cli/src/commands/prune.ts

import type { Command } from 'commander';
import { RunbookStateManager, SessionService } from '@rundown-org/core';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { getStatus } from '../helpers/status.js';

interface PruneOptions {
  dryRun?: boolean;
  completed?: boolean;
  active?: boolean;
  inactive?: boolean;
  all?: boolean;
  text?: boolean;
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
    .option('--text', 'Output as human-readable text')
    .action(async (options: PruneOptions) => {
      await withErrorHandling(
        async () => {
          const cwd = getCwd();
          const output = new OutputEmitter({ text: options.text });

          const manager = new RunbookStateManager(cwd);
          const sessionService = new SessionService(manager);
          const states = await manager.list();
          const activeState = await sessionService.getActive();
          const stashedId = await sessionService.getStashedRunbookId();

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
          const enrichedItems = toDelete.map((state) => ({
            ...state,
            _status: getStatus(state, activeState, stashedId),
          }));

          // Define columns once for reuse
          const columns = [
            { header: 'ID', key: 'id' as const },
            { header: 'STATUS', key: (item: (typeof enrichedItems)[0]) => item._status },
            { header: 'RUNBOOK', key: 'runbook' as const },
            {
              header: 'TITLE',
              key: (item: (typeof enrichedItems)[0]) => (item.title ? `[${item.title}]` : ''),
            },
          ];

          // JSON mapper to clean internal fields
          const jsonMapper = (item: (typeof enrichedItems)[0]): Record<string, unknown> => {
            const { _status: _, ...rest } = item;
            return { ...rest, status: item._status };
          };

          if (toDelete.length === 0) {
            // Use output.list() for consistency - outputs raw array in JSON mode
            output.list([], columns as Parameters<typeof output.list>[1], {
              emptyMessage: 'No runbook state to prune.',
              jsonMapper,
            });
            output.flush();
            return;
          }

          if (options.dryRun) {
            output.list(enrichedItems, columns as Parameters<typeof output.list>[1], {
              jsonMapper,
            });
            output.flush();
            return;
          }

          // Perform deletion
          for (const state of toDelete) {
            await manager.delete(state.id);
          }

          output.list(enrichedItems, columns as Parameters<typeof output.list>[1], { jsonMapper });
          output.flush();
        },
        { text: options.text },
      );
    });
}
