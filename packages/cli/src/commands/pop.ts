// packages/cli/src/commands/pop.ts

import type { Command } from 'commander';
import {
  RunbookStateManager,
  SessionService,
  countNumberedSteps,
  describeSupersededClaim,
  redactClaimId,
  type ActionBlockData,
  type ClaimId,
  type RunbookState,
  type StaleClaimRefusalCode,
  type UnstashForClaimIdResult,
} from '@rundown-org/core';
import { getCwd } from '../helpers/context.js';
import { getStepRetryMax, buildMetadata, formatActionForDisplay } from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { getRunbookFromState } from '../helpers/runbook-loader.js';
import { parseClaimIdOption } from '../helpers/claim-id-option.js';
import { renderSessionMutationRefusal } from '../helpers/session-mutation-result.js';

function claimPopRefusal(
  claimId: ClaimId,
  result: Exclude<UnstashForClaimIdResult, { status: 'restored' }>,
): { readonly message: string; readonly code: StaleClaimRefusalCode } {
  // User- and log-facing refusal: identify the claim by its non-secret lookup
  // key, never the bearer `claimId` (which carries the live secret segment).
  const claimKey = redactClaimId(claimId);
  const unavailable = (message: string) =>
    ({ message, code: 'CLAIMED_RUNBOOK_UNAVAILABLE' }) as const;
  switch (result.status) {
    case 'missing-claim':
      return unavailable(`Claim id ${claimKey} does not exist.`);
    case 'missing-child':
      return unavailable(
        `Claim id ${claimKey} no longer has readable child runbook state. Recover with \`rundown prune\` and restart from source.`,
      );
    case 'not-stashed':
      return unavailable(`Claim id ${claimKey} is not currently stashed.`);
    case 'terminal-child':
      return unavailable(`Claim id ${claimKey} points at a ${result.lifecycle} child runbook.`);
    case 'child-linkage-mismatch':
      return unavailable(`Claim id ${claimKey} is no longer linked to its child runbook.`);
    case 'parent-missing':
      return unavailable(`Claim id ${claimKey} parent runbook is missing.`);
    case 'superseded':
      // Core owns this wording and code, shared with the pass/fail/goto seam:
      // `rd pop` refusing a superseded bearer must carry the same RD-825
      // no-retry signal, not a generic unavailable envelope.
      return describeSupersededClaim(claimKey, result.reason);
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}

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
          const output = new OutputEmitter({ text: options.text, command: 'pop' });
          const manager = new RunbookStateManager(cwd);
          const sessionService = new SessionService(manager);
          const claimTarget = parseClaimIdOption(options.claimId, output);
          if (!claimTarget.ok) return;

          let state: RunbookState | null;
          if (claimTarget.claimId !== undefined) {
            const restoreResult = await sessionService.unstashForClaimId(claimTarget.claimId);
            if (restoreResult.kind !== 'committed') {
              renderSessionMutationRefusal(output, restoreResult);
              output.flush();
              process.exitCode = 1;
              return;
            }
            const restored = restoreResult.value;
            if (restored.status !== 'restored') {
              const refusal = claimPopRefusal(claimTarget.claimId, restored);
              output.error(refusal.message, refusal.code);
              output.flush();
              process.exitCode = 1;
              return;
            }
            state = restored.state;
          } else {
            const restoreResult = await sessionService.unstash();
            if (restoreResult.kind !== 'committed') {
              renderSessionMutationRefusal(output, restoreResult);
              output.flush();
              process.exitCode = 1;
              return;
            }
            state = restoreResult.value;
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
