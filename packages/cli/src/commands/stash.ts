// packages/cli/src/commands/stash.ts

import type { Command } from 'commander';
import {
  WorkflowStateManager,
  printMetadata,
  printWorkflowStashed,
  printNoActiveWorkflow,
} from '@rundown/core';
import { getCwd, getStepTotal } from '../helpers/context.js';
import { buildMetadata } from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';

/**
 * Registers the 'stash' command for pausing workflow enforcement.
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
        const manager = new WorkflowStateManager(cwd);
        const state = await manager.getActive(options.agent);

        if (!state) {
          printNoActiveWorkflow();
          return;
        }

        const totalSteps = await getStepTotal(cwd, state.workflow);

        // Print metadata
        printMetadata(buildMetadata(state));

        // Stash
        await manager.stash(options.agent);

        // Print step position and message
        printWorkflowStashed({ current: state.step, total: totalSteps });
      });
    });
}
