// packages/cli/src/commands/complete.ts

import type { Command } from 'commander';
import {
  WorkflowStateManager,
  printMetadata,
  printWorkflowComplete,
  printWorkflowStoppedAtStep,
  printNoActiveWorkflow,
  createStepNumber,
} from '@rundown/core';
import { getCwd, getStepCount } from '../helpers/context.js';
import { buildMetadata } from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';

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
          const totalSteps = await getStepCount(cwd, state.workflow);
          await manager.update(state.id, {
            step: createStepNumber(totalSteps) ?? state.step,
            variables: { ...state.variables, completed: true }
          });
          await manager.popWorkflow(options.agent);
          printWorkflowComplete();
        }
      });
    });
}
