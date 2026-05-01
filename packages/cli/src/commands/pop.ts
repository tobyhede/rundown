// packages/cli/src/commands/pop.ts

import type { Command } from 'commander';
import {
  RunbookStateManager,
  SessionService,
  countNumberedSteps,
  type ActionBlockData,
} from '@rundown-org/core';
import { getCwd } from '../helpers/context.js';
import { getStepRetryMax, buildMetadata, formatActionForDisplay } from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { getRunbookFromState } from '../helpers/runbook-loader.js';
import { parseClaimIdOption } from '../helpers/claim-id-option.js';

/**
 * Registers the 'pop' command for resuming stashed runbooks.
 * @param program - Commander program instance to register the command on
 * @throws {Error} When the stashed runbook file cannot be found
 */
export function registerPopCommand(program: Command): void {
  program
    .command('pop')
    .description('Resume enforcement from stashed runbook')
    .option('--claim-id <claimId>', 'Target a claimed delegated child runbook')
    .option('--text', 'Output as human-readable text')
    .action(async (options: { claimId?: string; text?: boolean }) => {
      await withErrorHandling(
        async () => {
          const cwd = getCwd();
          const output = new OutputEmitter({ text: options.text });
          const manager = new RunbookStateManager(cwd);
          const sessionService = new SessionService(manager);
          const claimTarget = parseClaimIdOption(options.claimId, output);
          if (!claimTarget.ok) return;

          let state: Awaited<ReturnType<typeof sessionService.unstash>>;
          if (claimTarget.claimId !== undefined) {
            state = await sessionService.unstashForClaimId(claimTarget.claimId);
            if (!state) {
              output.error(
                `No stashed runbook is available for claim id ${claimTarget.claimId}.`,
                'CLAIMED_RUNBOOK_UNAVAILABLE',
              );
              output.flush();
              process.exitCode = 1;
              return;
            }
          } else {
            state = await sessionService.unstash();
          }

          if (!state) {
            output.error('No stashed runbook to restore', 'NO_STASHED_RUNBOOK');
            output.flush();
            process.exitCode = 1;
            return;
          }

          const steps = getRunbookFromState(state, cwd);
          const currentStepIndex = steps.findIndex((s) => s.name === state.step);
          const currentStep = currentStepIndex >= 0 ? steps[currentStepIndex] : undefined;
          const totalSteps = countNumberedSteps(steps);

          // Build action block data if lastAction exists
          let actionBlockData: ActionBlockData | undefined;
          if (state.lastAction) {
            const retryMaxForAction = currentStep ? getStepRetryMax(currentStep) : 0;
            const actionStr = formatActionForDisplay(
              state.lastAction,
              state.retryCount,
              retryMaxForAction,
            );
            actionBlockData = { action: actionStr };
            if (state.lastResult) {
              actionBlockData.result = state.lastResult === 'pass' ? 'PASS' : 'FAIL';
            }
          }

          // Emit structured output
          output.metadata(buildMetadata(state));
          if (actionBlockData) {
            output.action(actionBlockData);
          }

          if (!currentStep) {
            output.error(`Step "${state.step}" not found in runbook`, 'STEP_NOT_FOUND', {
              restoredId: state.id,
            });
            output.flush();
            process.exitCode = 1;
            return;
          }

          // Emit status with step data for both modes
          // TextRenderer handles rendering the step block for text output
          output.status('pop', 'Runbook restored', {
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
        { text: options.text },
      );
    });
}
