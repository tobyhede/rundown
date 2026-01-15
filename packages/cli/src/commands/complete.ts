// packages/cli/src/commands/complete.ts

import * as fs from 'fs/promises';
import type { Command } from 'commander';
import {
  WorkflowStateManager,
  parseWorkflow,
  printMetadata,
  printWorkflowComplete,
  printNoActiveWorkflow,
} from '@rundown/core';
import { getCwd } from '../helpers/context.js';
import { resolveWorkflowFile } from '../helpers/resolve-workflow.js';
import { buildMetadata } from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';

/**
 * Registers the 'complete' command for marking workflows as complete.
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
        const manager = new WorkflowStateManager(cwd);
        const state = await manager.getActive(options.agent);

        if (!state) {
          printNoActiveWorkflow();
          return;
        }

        // Print metadata
        printMetadata(buildMetadata(state));

        const workflowPath = await resolveWorkflowFile(cwd, state.workflow);
        if (!workflowPath) {
          throw new Error(`Workflow file ${state.workflow} not found`);
        }
        const content = await fs.readFile(workflowPath, 'utf8');
        const steps = parseWorkflow(content);
        await manager.update(state.id, {
          step: steps[steps.length - 1].name,
          variables: { ...state.variables, completed: true }
        });
        await manager.popWorkflow(options.agent);
        printWorkflowComplete(message);
      });
    });
}
