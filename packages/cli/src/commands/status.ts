// packages/cli/src/commands/status.ts

import * as fs from 'fs/promises';
import type { Command } from 'commander';
import {
  RunbookStateManager,
  parseRunbook,
  stepIdToString,
  printMetadata,
  printActionBlock,
  printStepBlock,
  printRunbookStashed,
  printNoActiveRunbook,
  type ActionBlockData,
} from '@rundown/core';
import { getCwd, getStepTotal, findRunbookFile } from '../helpers/context.js';
import {
  getStepRetryMax,
  buildMetadata,
} from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';

/**
 * Registers the 'status' command for displaying runbook state.
 * @param program - Commander program instance to register the command on
 */
export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show current runbook state')
    .option('--agent <agentId>', 'Show status for agent-specific runbook')
    .action(async (options: { agent?: string }) => {
      await withErrorHandling(async () => {
        const cwd = getCwd();
        const manager = new RunbookStateManager(cwd);
        const state = await manager.getActive(options.agent);
        const stashedId = await manager.getStashedRunbookId();

        if (!state && !stashedId) {
          printNoActiveRunbook();
          return;
        }

        if (stashedId && !state) {
          const stashed = await manager.load(stashedId);
          if (stashed) {
            printMetadata(buildMetadata(stashed));
            const totalSteps = await getStepTotal(cwd, stashed.runbook);
            printRunbookStashed({ current: stashed.step, total: totalSteps, substep: stashed.substep });
          }
          return;
        }

        if (!state) return;

        const runbookPath = await findRunbookFile(cwd, state.runbook);
        if (!runbookPath) {
          throw new Error(`Runbook file ${state.runbook} not found`);
        }
        const content = await fs.readFile(runbookPath, 'utf8');
        const steps = parseRunbook(content);
        const isDynamic = steps.length > 0 && steps[0].isDynamic;
        // For dynamic runbooks, find step by checking if it's the dynamic template
        const currentStepIndex = isDynamic ? 0 : steps.findIndex(s => s.name === state.step);
        const currentStep = currentStepIndex >= 0 ? steps[currentStepIndex] : undefined;
        // '{N}' indicates dynamic runbook with unbounded iterations
        const totalSteps: number | string = isDynamic ? '{N}' : steps.length;
        // Use state.instance for dynamic runbooks, state.step for static
        const displayStep = isDynamic && state.instance !== undefined
          ? String(state.instance)
          : state.step;

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
          // For status, from would be the step before current... but we don't track that
          // Just show action without from for now
          printActionBlock(actionBlockData);
        }

        // Print step block
        // currentStep is guaranteed to exist from array index

        if (currentStep) {
          printStepBlock({ current: displayStep, total: totalSteps, substep: state.substep }, currentStep);
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
