// packages/cli/src/commands/complete.ts

import * as fs from 'fs/promises';
import type { Command } from 'commander';
import {
  RunbookStateManager,
  parseRunbook,
  printMetadata,
  printRunbookComplete,
  printNoActiveRunbook,
} from '@rundown/core';
import { getCwd } from '../helpers/context.js';
import { resolveRunbookFile } from '../helpers/resolve-runbook.js';
import { buildMetadata } from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';

/**
 * Registers the 'complete' command for marking runbooks as complete.
 * @param program - Commander program instance to register the command on
 */
export function registerCompleteCommand(program: Command): void {
  program
    .command('complete')
    .description('Mark current runbook as complete')
    .argument('[message]', 'Completion message')
    .option('--agent <agentId>', 'Complete runbook in agent-specific stack')
    .action(async (message: string | undefined, options: { agent?: string }) => {
      await withErrorHandling(async () => {
        const cwd = getCwd();
        const manager = new RunbookStateManager(cwd);
        const state = await manager.getActive(options.agent);

        if (!state) {
          printNoActiveRunbook();
          return;
        }

        // Print metadata
        printMetadata(buildMetadata(state));

        const runbookPath = await resolveRunbookFile(cwd, state.runbook);
        if (!runbookPath) {
          throw new Error(`Runbook file ${state.runbook} not found`);
        }
        const content = await fs.readFile(runbookPath, 'utf8');
        const steps = parseRunbook(content);
        await manager.update(state.id, {
          step: steps[steps.length - 1].name,
          variables: { ...state.variables, completed: true }
        });
        await manager.popRunbook(options.agent);
        printRunbookComplete(message);
      });
    });
}
