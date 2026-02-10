// packages/cli/src/commands/pop.ts

import type { Command } from 'commander';
import {
  RunbookStateManager,
  countNumberedSteps,
  type ActionBlockData,
} from '@rundown-org/core';
import { getCwd } from '../helpers/context.js';
import {
  getStepRetryMax,
  buildMetadata,
} from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { getRunbookFromState } from '../helpers/runbook-loader.js';

/**
 * Registers the 'pop' command for resuming stashed runbooks.
 * @param program - Commander program instance to register the command on
 * @throws Error when the stashed runbook file cannot be found
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

          const steps = getRunbookFromState(state, cwd);
          const currentStepIndex = steps.findIndex(s => s.name === state.step);
          const currentStep = currentStepIndex >= 0 ? steps[currentStepIndex] : undefined;
          const totalSteps = countNumberedSteps(steps);

          // Build action block data if lastAction exists
          let actionBlockData: ActionBlockData | undefined;
          if (state.lastAction) {
            const retryMaxForAction = currentStep ? getStepRetryMax(currentStep) : 0;
            let actionStr: string;
            switch (state.lastAction.type) {
              case 'GOTO': {
                const gotoBase = state.lastAction.substep
                  ? `GOTO ${state.lastAction.target}.${state.lastAction.substep}`
                  : `GOTO ${state.lastAction.target}`;
                actionStr = state.lastAction.at !== undefined
                  ? `${gotoBase} AT ${String(state.lastAction.at)}`
                  : gotoBase;
                break;
              }
              case 'RETRY':
                actionStr = `RETRY (${String(state.retryCount)}/${String(retryMaxForAction)})`;
                break;
              default:
                actionStr = state.lastAction.type;
            }
            actionBlockData = { action: actionStr };
            if (state.lastResult) {
              actionBlockData.result = state.lastResult === 'pass';
            }
          }

          // Emit structured output
          output.metadata(buildMetadata(state));
          if (actionBlockData) {
            output.action(actionBlockData);
          }

          if (!currentStep) {
            output.status(false, 'pop', `Step "${state.step}" not found in runbook`, {
              restoredId: state.id,
            });
            output.flush();
            return;
          }

          // Emit status with step data for both modes
          // TextRenderer handles rendering the step block for text output
          output.status(true, 'pop', 'Runbook restored', {
            position: {
              current: state.step,
              total: totalSteps,
              ...(state.substep && { substep: state.substep }),
            },
            step: {
              name: currentStep.name,
              description: currentStep.description,
              prompted: !!state.prompted,
            },
            restoredId: state.id,
          });
          output.flush();
        },
        { json: options.json }
      );
    });
}
