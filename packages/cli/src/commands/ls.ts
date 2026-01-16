// packages/cli/src/commands/ls.ts

import type { Command } from 'commander';
import {
  RunbookStateManager,
} from '@rundown/core';
import { discoverRunbooks } from '../services/discovery.js';
import { getCwd, getStepTotal } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputManager } from '../services/output-manager.js';
import { getStatus } from '../helpers/status.js';

/**
 * Registers the 'ls' command for listing runbooks.
 * @param program - Commander program instance to register the command on
 */
export function registerLsCommand(program: Command): void {
  program
    .command('ls')
    .description('List runbooks (active by default, --all for available)')
    .option('-a, --all', 'List all available runbook files')
    .option('--json', 'Output as JSON for programmatic use')
    .option('--tags <tags>', 'Filter available runbooks by comma-separated tags')
    .action(async (options: { all?: boolean; json?: boolean; tags?: string }) => {
      await withErrorHandling(async () => {
        const cwd = getCwd();
        const output = new OutputManager({ json: options.json });

        // MODE 1: List available runbooks (--all)
        if (options.all) {
            let runbooks = await discoverRunbooks(cwd);

            // Filter by tags
            if (options.tags) {
              const filterTags = options.tags.split(',').map((t) => t.trim().toLowerCase());
              runbooks = runbooks.filter((w) =>
                w.tags?.some((tag) => filterTags.includes(tag.toLowerCase()))
              );
            }

            output.list(runbooks, [
              { 
                header: 'NAME', 
                get: (w) => w.source === 'plugin' ? `${w.name} [${w.source}]` : w.name 
              },
              { 
                header: 'DESCRIPTION', 
                get: (w) => w.description ?? '' 
              },
              { 
                header: 'TAGS', 
                get: (w) => w.tags?.join(', ') ?? '' 
              },
            ], {
              emptyMessage: 'No runbooks found.',
              jsonMapper: (w) => ({
                name: w.name,
                source: w.source,
                description: w.description,
                tags: w.tags,
                path: w.path,
              }),
            });
            return;
        }

        // MODE 2: List active runbooks (default)
        const manager = new RunbookStateManager(cwd);
        const states = await manager.list();
        const active = await manager.getActive();
        const stashedId = await manager.getStashedRunbookId();

        // Pre-calculate derived data for table display
        const enrichedStates = await Promise.all(
          states.map(async (state) => {
            const status = getStatus(state, active, stashedId);

            const totalSteps = await getStepTotal(cwd, state.runbook);
            // Use state.instance for dynamic runbooks
            const displayStep = state.instance !== undefined
              ? String(state.instance)
              : state.step;
            
            return {
              ...state,
              _status: status,
              _displayStep: `${displayStep}/${String(totalSteps)}`,
            };
          })
        );

        output.list(enrichedStates, [
          { header: 'ID', get: (s) => s.id.slice(0, 8) },
          { header: 'STATUS', get: (s) => s._status },
          { header: 'STEP', get: (s) => s._displayStep },
          { header: 'RUNBOOK', key: 'runbook' },
          { header: 'TITLE', get: (s) => s.title ?? '' },
        ], {
          emptyMessage: 'No active runbooks.\nRun "rundown ls --all" to see available runbooks.',
          // Strip internal display properties for JSON output
          jsonMapper: (s) => {
             // eslint-disable-next-line @typescript-eslint/no-unused-vars
             const { _status, _displayStep, ...original } = s;
             return original;
          }
        });
      });
    });
}