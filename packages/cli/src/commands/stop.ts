// packages/cli/src/commands/stop.ts

import type { Command } from 'commander';
import {
  WorkflowStateManager,
  printMetadata,
  printWorkflowStopped,
  printNoActiveWorkflow,
} from '@rundown/core';
import { getCwd } from '../helpers/context.js';
import { buildMetadata } from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';

/**
 * Registers the 'stop' command for aborting workflows.
 * @param program - Commander program instance to register the command on
 */
export function registerStopCommand(program: Command): void {
  program
    .command('stop')
    .description('Abort current workflow')
    .option('--agent <agentId>', 'Stop workflow in agent-specific stack')
    .action(async (options: { agent?: string }) => {
      await withErrorHandling(async () => {
        const cwd = getCwd();
        const manager = new WorkflowStateManager(cwd);
        const state = await manager.getActive(options.agent);
        if (!state) {
          printNoActiveWorkflow();
          return;
        }

        // Print metadata
        printMetadata(buildMetadata(state));

        // Delete and clear
        await manager.delete(state.id);
        await manager.popWorkflow(options.agent);

        // Print terminal message
        printWorkflowStopped();
      });
    });
}
