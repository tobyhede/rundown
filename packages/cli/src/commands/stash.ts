// packages/cli/src/commands/stash.ts

import type { Command } from 'commander';
import {
  RunbookStateManager,
  printMetadata,
  printRunbookStashed,
  printNoActiveRunbook,
} from '@rundown/core';
import { getCwd, getStepTotal } from '../helpers/context.js';
import { buildMetadata } from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';

/**
 * Registers the 'stash' command for pausing runbook enforcement.
 * @param program - Commander program instance to register the command on
 */
export function registerStashCommand(program: Command): void {
  program
    .command('stash')
    .description('Pause runbook enforcement, preserve state')
    .option('--agent <agentId>', 'Stash runbook from agent-specific stack')
    .action(async (options: { agent?: string }) => {
      await withErrorHandling(async () => {
        const cwd = getCwd();
        const manager = new RunbookStateManager(cwd);
        const state = await manager.getActive(options.agent);

        if (!state) {
          printNoActiveRunbook();
          return;
        }

        const totalSteps = await getStepTotal(cwd, state.runbook);

        // Print metadata
        printMetadata(buildMetadata(state));

        // Stash
        await manager.stash(options.agent);

        // Print step position and message
        printRunbookStashed({ current: state.step, total: totalSteps });
      });
    });
}
