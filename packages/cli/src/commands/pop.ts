// packages/cli/src/commands/pop.ts

import type { Command } from 'commander';
import {
  buildAgentOwnerKey,
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
import { resolveCallerIdentity } from '../helpers/caller-identity.js';

/**
 * Registers the 'pop' command for resuming stashed runbooks.
 * @param program - Commander program instance to register the command on
 * @throws {Error} When the stashed runbook file cannot be found
 */
export function registerPopCommand(program: Command): void {
  program
    .command('pop')
    .description('Resume enforcement from stashed runbook')
    .option('--text', 'Output as human-readable text')
    .action(async (options: { text?: boolean }) => {
      await withErrorHandling(
        async () => {
          const cwd = getCwd();
          const output = new OutputEmitter({ text: options.text });
          const manager = new RunbookStateManager(cwd);
          const sessionService = new SessionService(manager);
          const caller = resolveCallerIdentity();

          let state: Awaited<ReturnType<typeof sessionService.unstash>>;
          if (caller.kind === 'invalid') {
            output.error(caller.message, 'OWNED_RUNBOOK_UNAVAILABLE');
            output.flush();
            process.exitCode = 1;
            return;
          }

          if (caller.kind === 'identified') {
            const stashedId = await sessionService.getStashedRunbookId();
            if (!stashedId) {
              state = null;
            } else {
              const stashedOwnership = await sessionService.getStashedRunbookOwnership();
              if (
                stashedOwnership &&
                stashedOwnership.ownerKey !== buildAgentOwnerKey(caller.identity)
              ) {
                output.error(
                  `Stashed runbook ${stashedId} is owned by a different caller.`,
                  'OWNED_RUNBOOK_UNAVAILABLE',
                );
                output.flush();
                process.exitCode = 1;
                return;
              }
              const stashedState = await manager.load(stashedId);
              const linkage = stashedState?.parentLinkage;
              if (stashedOwnership && linkage?.kind !== 'delegation') {
                output.error(
                  `Owned runbook ${stashedId} cannot be restored: stash has linkage kind '${linkage?.kind ?? 'none'}', expected 'delegation'.`,
                  'OWNED_RUNBOOK_UNAVAILABLE',
                );
                output.flush();
                process.exitCode = 1;
                return;
              }
              if (stashedState && linkage?.kind === 'delegation') {
                const parentState = await manager.load(linkage.parentRunId);
                if (!parentState) {
                  output.error(
                    `Owned runbook ${stashedId} cannot be restored because parent ${linkage.parentRunId} is unavailable.`,
                    'OWNED_RUNBOOK_UNAVAILABLE',
                  );
                  output.flush();
                  process.exitCode = 1;
                  return;
                }
                state = await sessionService.unstashForOwner(caller.identity, linkage);
              } else {
                state = await sessionService.unstash();
              }
            }
          } else {
            const stashedId = await sessionService.getStashedRunbookId();
            const stashedOwnership = await sessionService.getStashedRunbookOwnership();
            if (stashedId && stashedOwnership) {
              output.error(
                `Stashed runbook ${stashedId} is owned by an agent; set RD_AGENT_ID to restore it.`,
                'OWNED_RUNBOOK_UNAVAILABLE',
              );
              output.flush();
              process.exitCode = 1;
              return;
            }
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
