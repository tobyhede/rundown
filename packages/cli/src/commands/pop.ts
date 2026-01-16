// packages/cli/src/commands/pop.ts

import * as fs from 'fs/promises';
import type { Command } from 'commander';
import {
  RunbookStateManager,
  parseRunbook,
  printMetadata,
  printActionBlock,
  printStepBlock,
  type ActionBlockData,
} from '@rundown/core';
import { getCwd, findRunbookFile } from '../helpers/context.js';
import {
  getStepRetryMax,
  buildMetadata,
} from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';

/**
 * Registers the 'pop' command for resuming stashed runbooks.
 * @param program - Commander program instance to register the command on
 */
export function registerPopCommand(program: Command): void {
  program
    .command('pop')
    .description('Resume enforcement from stashed runbook')
    .option('--agent <agentId>', 'Pop runbook to agent-specific stack')
    .action(async (options: { agent?: string }) => {
      await withErrorHandling(async () => {
        const cwd = getCwd();
        const manager = new RunbookStateManager(cwd);

        const state = await manager.pop(options.agent);

        if (!state) {
          console.log('No stashed runbook to restore.');
          return;
        }

        const runbookPath = await findRunbookFile(cwd, state.runbook);
        if (!runbookPath) {
          throw new Error(`Runbook file ${state.runbook} not found`);
        }
        const content = await fs.readFile(runbookPath, 'utf8');
        const steps = parseRunbook(content);
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
