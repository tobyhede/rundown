// packages/cli/src/commands/complete.ts

import * as fs from 'fs/promises';
import type { Command } from 'commander';
import {
  WorkflowStateManager,
  parseWorkflow,
  printMetadata,
  printWorkflowComplete,
  printWorkflowStoppedAtStep,
  printNoActiveWorkflow,
} from '@rundown/core';
import { getCwd, getStepCount } from '../helpers/context.js';
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
    .description('Mark current workflow as complete')
    .option('--status <status>', 'Completion status (ok|stopped)', 'ok')
    .option('--agent <agentId>', 'Complete workflow in agent-specific stack')
    .action(async (options: { status: string; agent?: string }) => {
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

        if (options.status === 'stopped') {
          const totalSteps = await getStepCount(cwd, state.workflow);
          await manager.update(state.id, {
            variables: { ...state.variables, stopped: true }
          });
          printWorkflowStoppedAtStep({ current: state.step, total: totalSteps, substep: state.substep });
        } else {
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
          printWorkflowComplete();
        }
      });
    });
}
