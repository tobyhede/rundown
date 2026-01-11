// packages/cli/src/commands/pop.ts

import * as fs from 'fs/promises';
import type { Command } from 'commander';
import {
  WorkflowStateManager,
  parseWorkflow,
  printMetadata,
  printActionBlock,
  printStepBlock,
  type ActionBlockData,
} from '@rundown/core';
import { getCwd, findWorkflowFile } from '../helpers/context.js';
import {
  getStepRetryMax,
  buildMetadata,
} from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';

export function registerPopCommand(program: Command): void {
  program
    .command('pop')
    .description('Resume enforcement from stashed workflow')
    .option('--agent <agentId>', 'Pop workflow to agent-specific stack')
    .action(async (options: { agent?: string }) => {
      await withErrorHandling(async () => {
        const cwd = getCwd();
        const manager = new WorkflowStateManager(cwd);

        const state = await manager.pop(options.agent);

        if (!state) {
          console.log('No stashed workflow to restore.');
          return;
        }

        const workflowPath = await findWorkflowFile(cwd, state.workflow);
        if (!workflowPath) {
          throw new Error(`Workflow file ${state.workflow} not found`);
        }
        const content = await fs.readFile(workflowPath, 'utf8');
        const steps = parseWorkflow(content);
        const currentStepIndex = steps.findIndex(s => s.name === state.step);
        const currentStep = currentStepIndex >= 0 ? steps[currentStepIndex] : undefined;
        const totalSteps = steps.length;

        // Print metadata
        printMetadata(buildMetadata(state));

        // Print action block if lastAction exists
        if (state.lastAction) {
          const retryMaxForAction = currentStep ? getStepRetryMax(currentStep) : 0;
          const actionBlockData: ActionBlockData = {
            action: state.lastAction === 'GOTO' ? `GOTO ${state.step}` :
                    state.lastAction === 'RETRY' ? `RETRY (${String(state.retryCount)}/${String(retryMaxForAction)})` :
                    state.lastAction,
          };
          if (state.lastResult) {
            actionBlockData.result = state.lastResult === 'pass' ? 'PASS' : 'FAIL';
          }
          printActionBlock(actionBlockData);
        }

        // Print step block
        // currentStep is guaranteed to exist from array index
         
        if (currentStep) {
          printStepBlock({ current: state.step, total: totalSteps, substep: state.substep }, currentStep);
        }
      });
    });
}
