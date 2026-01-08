// packages/cli/src/commands/status.ts

import * as fs from 'fs/promises';
import type { Command } from 'commander';
import {
  WorkflowStateManager,
  parseWorkflow,
  stepIdToString,
  printMetadata,
  printActionBlock,
  printStepBlock,
  printWorkflowStashed,
  printNoActiveWorkflow,
  type ActionBlockData,
} from '@rundown/core';
import { getCwd, getStepCount, findWorkflowFile } from '../helpers/context.js';
import {
  getStepRetryMax,
  buildMetadata,
} from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show current workflow state')
    .option('--agent <agentId>', 'Show status for agent-specific workflow')
    .action(async (options: { agent?: string }) => {
      await withErrorHandling(async () => {
        const cwd = getCwd();
        const manager = new WorkflowStateManager(cwd);
        const state = await manager.getActive(options.agent);
        const stashedId = await manager.getStashedWorkflowId();

        if (!state && !stashedId) {
          printNoActiveWorkflow();
          return;
        }

        if (stashedId && !state) {
          const stashed = await manager.load(stashedId);
          if (stashed) {
            printMetadata(buildMetadata(stashed));
            const totalSteps = await getStepCount(cwd, stashed.workflow);
            printWorkflowStashed({ current: stashed.step, total: totalSteps, substep: stashed.substep });
          }
          return;
        }

        if (!state) return;

        const workflowPath = await findWorkflowFile(cwd, state.workflow);
        if (!workflowPath) {
          throw new Error(`Workflow file ${state.workflow} not found`);
        }
        const content = await fs.readFile(workflowPath, 'utf8');
        const steps = parseWorkflow(content);
        const currentStep = steps[state.step - 1];
        const totalSteps = steps.length;

        // Print metadata
        printMetadata(buildMetadata(state));

        // Print action block if lastAction exists
        if (state.lastAction) {
          const actionBlockData: ActionBlockData = {
            action: state.lastAction === 'GOTO' ? `GOTO ${String(state.step)}` :
                    state.lastAction === 'RETRY' ? `RETRY (${String(state.retryCount)}/${String(getStepRetryMax(currentStep))})` :
                    state.lastAction,
          };
          if (state.lastResult) {
            actionBlockData.result = state.lastResult === 'pass' ? 'PASS' : 'FAIL';
          }
          // For status, from would be the step before current... but we don't track that
          // Just show action without from for now
          printActionBlock(actionBlockData);
        }

        // Print step block
        // currentStep is guaranteed to exist from array index
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (currentStep) {
          printStepBlock({ current: state.step, total: totalSteps, substep: state.substep }, currentStep);
        }

        // Show pending steps and agent bindings
        if (state.pendingSteps.length > 0) {
          console.log(`\nPending: ${state.pendingSteps.map((p) => stepIdToString(p.stepId)).join(', ')}`);
        }

        if (Object.keys(state.agentBindings).length > 0) {
          console.log('\nAgents:');
          for (const [agentId, binding] of Object.entries(state.agentBindings)) {
            const stepStr = stepIdToString(binding.stepId);
            const resultStr = binding.result ? ` (${binding.result})` : '';
            console.log(`  ${agentId}: ${stepStr} [${binding.status}]${resultStr}`);
          }
        }
      });
    });
}
