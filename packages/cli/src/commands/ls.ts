// packages/cli/src/commands/ls.ts

import type { Command } from 'commander';
import {
  WorkflowStateManager,
  printNoWorkflows,
} from '@rundown/core';
import { discoverRunbooks } from '../services/discovery.js';
import { getCwd, getStepTotal } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { printTable } from '../helpers/table-formatter.js';

/**
 * Registers the 'ls' command for listing workflows.
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
        // MODE 1: List available workflows (--all)
        if (options.all) {
            let runbooks = await discoverRunbooks(cwd);

            // Filter by tags
            if (options.tags) {
              const filterTags = options.tags.split(',').map((t) => t.trim().toLowerCase());
              runbooks = runbooks.filter((w) =>
                w.tags?.some((tag) => filterTags.includes(tag.toLowerCase()))
              );
            }

            if (runbooks.length === 0) {
              if (options.json) {
                 console.log('[]');
              } else {
                 console.log('No runbooks found.');
              }
              return;
            }

            if (options.json) {
              const output = runbooks.map((w) => ({
                name: w.name,
                source: w.source,
                description: w.description,
                tags: w.tags,
                path: w.path,
              }));
              console.log(JSON.stringify(output, null, 2));
              return;
            }

            const rows = runbooks.map((w) => ({
              name: w.source === 'plugin' ? `${w.name} [${w.source}]` : w.name,
              description: w.description ?? '',
              tags: w.tags?.join(', ') ?? '',
            }));

            printTable(rows, [
              { header: 'NAME', key: 'name' },
              { header: 'DESCRIPTION', key: 'description' },
              { header: 'TAGS', key: 'tags' },
            ]);
            return;
        }

        // MODE 2: List active workflows (default)
        const manager = new WorkflowStateManager(cwd);
        const states = await manager.list();
        const active = await manager.getActive();
        const stashedId = await manager.getStashedWorkflowId();

        if (states.length === 0) {
          if (options.json) {
            console.log('[]');
          } else {
            printNoWorkflows();
          }
          return;
        }

        if (options.json) {
           console.log(JSON.stringify(states, null, 2));
           return;
        }

        // Build rows
        const rows = await Promise.all(
          states.map(async (state) => {
            let status: string;
            if (active?.id === state.id) {
              status = 'active';
            } else if (state.id === stashedId) {
              status = 'stashed';
            } else if (state.variables.completed) {
              status = 'complete';
            } else if (state.variables.stopped) {
              status = 'stopped';
            } else {
              status = 'inactive';
            }

            const totalSteps = await getStepTotal(cwd, state.workflow);
            // Use state.instance for dynamic workflows
            const displayStep = state.instance !== undefined
              ? String(state.instance)
              : state.step;
            return {
              id: state.id.slice(0, 8),
              status,
              step: `${displayStep}/${String(totalSteps)}`,
              workflow: state.workflow,
              title: state.title ?? '',
            };
          })
        );

        printTable(rows, [
          { header: 'ID', key: 'id' },
          { header: 'STATUS', key: 'status' },
          { header: 'STEP', key: 'step' },
          { header: 'RUNBOOK', key: 'workflow' },
          { header: 'TITLE', key: 'title' },
        ]);
      });
    });
}