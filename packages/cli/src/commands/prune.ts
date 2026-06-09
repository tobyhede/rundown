// packages/cli/src/commands/prune.ts

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command } from 'commander';
import { RunbookStateManager, SessionService } from '@rundown-org/core';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { getStatus } from '../helpers/status.js';

async function listAllRunIds(cwd: string): Promise<string[]> {
  try {
    const runsDir = join(cwd, '.rundown', 'runs');
    const files = await readdir(runsDir);
    return files.filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
  } catch {
    return [];
  }
}

interface PruneOptions {
  dryRun?: boolean;
  completed?: boolean;
  stopped?: boolean;
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
    .option('--completed', 'Prune successfully completed runbook state')
    .option('--stopped', 'Prune stopped (aborted/failed) runbook state')
    .option('--active', 'Prune active runbook state')
    .option('--inactive', 'Prune inactive (orphaned) runbook state')
    .option('--all', 'Prune all runbook state')
    .option('--text', 'Output as human-readable text')
    .action(async (options: PruneOptions) => {
      await withErrorHandling(
        async () => {
          const cwd = getCwd();
          const output = new OutputEmitter({ text: options.text, command: 'prune' });

          const manager = new RunbookStateManager(cwd);
          const sessionService = new SessionService(manager);
          const states = await manager.list();
          const allIds = await listAllRunIds(cwd);
          let activeState: Awaited<ReturnType<typeof sessionService.getActive>>;
          try {
            activeState = await sessionService.getActive();
          } catch {
            activeState = null;
          }
          const stashedId = await sessionService.getStashedRunbookId();

          // Default to --completed --stopped (all terminal runs) if no filter flags provided
          const hasFilter =
            options.completed ??
            options.stopped ??
            options.active ??
            options.inactive ??
            options.all;
          const pruneCompleted = options.all ?? options.completed ?? !hasFilter;
          const pruneStopped = options.all ?? options.stopped ?? !hasFilter;
          const pruneActive = options.all ?? options.active;
          const pruneInactive = options.all ?? options.inactive;

          const toDelete = states.filter((state) => {
            const isActive = activeState?.id === state.id;
            const isStashed = state.id === stashedId;
            const isCompleted = state.lifecycle === 'completed';
            const isStopped = state.lifecycle === 'stopped';
            const isInactive = !isActive && !isStashed && !isCompleted && !isStopped;

            if (pruneCompleted && isCompleted) return true;
            if (pruneStopped && isStopped) return true;
            if (pruneActive && isActive) return true;
            if (pruneInactive && isInactive) return true;
            return false;
          });

          // Invalid files (skipped by list() due to schema version mismatch) are invisible to
          // list() but can still be deleted. Treat them as inactive: prune with
          // --inactive or --all.
          const loadedIds = new Set<string>(states.map((s) => s.id));
          const invalidIds = allIds.filter((id) => !loadedIds.has(id));
          const invalidToDelete = (pruneInactive ?? options.all) ? invalidIds : [];

          // Enrich items with status string for display
          const enrichedItems = toDelete.map((state) => ({
            ...state,
            runbook: state.runbook.path,
            _status: getStatus(state, activeState, stashedId),
          }));

          type LoadedRow = (typeof enrichedItems)[0];
          type InvalidRow = {
            id: string;
            runbook: string;
            title: string | undefined;
            _status: string;
          };
          type PruneRow = LoadedRow | InvalidRow;

          // Invalid items carry only the fields needed for display and JSON output
          const invalidEnrichedItems: InvalidRow[] = invalidToDelete.map((id) => ({
            id,
            runbook: '(invalid)',
            title: undefined,
            _status: 'invalid',
          }));

          const allItems: PruneRow[] = [...enrichedItems, ...invalidEnrichedItems];

          // Define columns once for reuse
          const columns = [
            { header: 'ID', key: 'id' as const },
            { header: 'STATUS', key: (item: PruneRow) => item._status },
            { header: 'RUNBOOK', key: 'runbook' as const },
            { header: 'TITLE', key: (item: PruneRow) => (item.title ? `[${item.title}]` : '') },
          ];

          // Emit only the documented ActiveRunbookEntry fields
          // (PruneResponseSchema = ActiveRunbookListSchema). Spreading the
          // enriched row would leak internal RunbookState fields into JSON.
          // `step`/`total` are intentionally omitted: prune rows are not
          // enriched with step counts (unlike `ls`); both are optional in
          // ActiveRunbookEntrySchema.
          const jsonMapper = (item: PruneRow): Record<string, unknown> => ({
            id: item.id,
            runbook: item.runbook,
            status: item._status,
            title: item.title,
          });

          if (allItems.length === 0) {
            // Use output.list() for consistency - outputs raw array in JSON mode
            output.list([], columns, {
              emptyMessage: 'No runbook state to prune.',
              jsonMapper,
            });
            output.flush();
            return;
          }

          if (options.dryRun) {
            output.list(allItems, columns, {
              jsonMapper,
            });
            output.flush();
            return;
          }

          // Perform deletion
          const deletedRunIds = toDelete.map((state) => state.id);
          for (const id of deletedRunIds) {
            await manager.delete(id);
          }
          for (const id of invalidToDelete) {
            await manager.delete(id);
          }
          // Fold tombstone GC: drop claim records pointing at deleted children.
          await sessionService.pruneClaimsForChildren([...deletedRunIds, ...invalidToDelete]);

          output.list(allItems, columns, { jsonMapper });
          output.flush();
        },
        { text: options.text },
      );
    });
}
