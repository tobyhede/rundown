// packages/cli/src/commands/stop.ts

import type { Command } from 'commander';
import {
  RunbookStateManager,
  printMetadata,
  printRunbookStopped,
  printNoActiveRunbook,
} from '@rundown/core';
import { getCwd } from '../helpers/context.js';
import { buildMetadata } from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';

/**
 * Registers the 'stop' command for aborting runbooks.
 * @param program - Commander program instance to register the command on
 */
export function registerStopCommand(program: Command): void {
  program
    .command('stop')
    .description('Abort current runbook')
    .argument('[message]', 'Stop message')
    .option('--agent <agentId>', 'Stop runbook in agent-specific stack')
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

        // Delete and clear
        await manager.delete(state.id);
        await manager.popRunbook(options.agent);

        // Print terminal message
        printRunbookStopped(message);
      });
    });
}
