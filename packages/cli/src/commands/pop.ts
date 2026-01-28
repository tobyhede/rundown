// packages/cli/src/commands/pop.ts

import * as fs from 'fs/promises';
import type { Command } from 'commander';
import {
  RunbookStateManager,
  parseRunbook,
  printStepBlock,
  countNumberedSteps,
  type ActionBlockData,
} from '@rundown-org/core';
import { getCwd, findRunbookFile } from '../helpers/context.js';
import {
  getStepRetryMax,
  buildMetadata,
} from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';

/**
 * Registers the 'pop' command for resuming stashed runbooks.
 * @param program - Commander program instance to register the command on
 */
export function registerPopCommand(program: Command): void {
  program
    .command('pop')
    .description('Resume enforcement from stashed runbook')
    .option('--agent <agentId>', 'Pop runbook to agent-specific stack')
    .option('--json', 'Output as JSON for programmatic use')
    .action(async (options: { agent?: string; json?: boolean }) => {
      await withErrorHandling(
        async () => {
          const cwd = getCwd();
          const output = new OutputEmitter({ json: options.json });
          const manager = new RunbookStateManager(cwd);

          const state = await manager.pop(options.agent);

          if (!state) {
            output.status(false, 'pop', 'No stashed runbook to restore');
            output.flush();
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
          const totalSteps = countNumberedSteps(steps);

          // Build action block data if lastAction exists
          let actionBlockData: ActionBlockData | undefined;
          if (state.lastAction) {
            const retryMaxForAction = currentStep ? getStepRetryMax(currentStep) : 0;
            actionBlockData = {
              action: state.lastAction === 'GOTO' ? `GOTO ${state.step}` :
                      state.lastAction === 'RETRY' ? `RETRY (${String(state.retryCount)}/${String(retryMaxForAction)})` :
                      state.lastAction,
            };
            if (state.lastResult) {
              actionBlockData.result = state.lastResult === 'pass';
            }
          }

          // Emit structured output
          output.metadata(buildMetadata(state));
          if (actionBlockData) {
            output.action(actionBlockData);
          }

          if (output.isJson()) {
            // JSON mode: include step data in status
            output.status(true, 'pop', 'Runbook restored', {
              position: {
                current: state.step,
                total: totalSteps,
                ...(state.substep && { substep: state.substep }),
              },
              step: currentStep ? {
                name: currentStep.name,
                description: currentStep.description,
                prompted: !!state.prompted,
              } : undefined,
            });
            output.flush();
          } else {
            // Text mode: use printStepBlock for step rendering (requires Step object)
            if (currentStep) {
              printStepBlock(
                { current: state.step, total: totalSteps, substep: state.substep },
                currentStep,
                !!state.prompted,
                output.getWriter()
              );
            }
            output.flush();
          }
        },
        { json: options.json }
      );
    });
}
