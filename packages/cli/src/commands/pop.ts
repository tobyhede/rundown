// packages/cli/src/commands/pop.ts

import type { Command } from 'commander';
import {
  type AgentOwnerIdentity,
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
import { type CallerIdentityResult, resolveCallerIdentity } from '../helpers/caller-identity.js';

type PopErrorCode = 'INVALID_CALLER_IDENTITY' | 'NO_STASHED_RUNBOOK' | 'OWNED_RUNBOOK_UNAVAILABLE';

type StashTargetResolution =
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'owned'; readonly identity: AgentOwnerIdentity }
  | { readonly kind: 'error'; readonly message: string; readonly code: PopErrorCode };

async function resolveStashTarget(
  manager: RunbookStateManager,
  sessionService: SessionService,
  caller: CallerIdentityResult,
): Promise<StashTargetResolution> {
  if (caller.kind === 'invalid') {
    return { kind: 'error', message: caller.message, code: 'INVALID_CALLER_IDENTITY' };
  }

  const stashedId = await sessionService.getStashedRunbookId();
  if (!stashedId) {
    return { kind: 'error', message: 'No stashed runbook to restore', code: 'NO_STASHED_RUNBOOK' };
  }

  const stashedOwnership = await sessionService.getStashedRunbookOwnership();
  if (caller.kind === 'anonymous') {
    if (stashedOwnership) {
      return {
        kind: 'error',
        message: `Stashed runbook ${stashedId} is owned by an agent; set RD_AGENT_ID to restore it.`,
        code: 'OWNED_RUNBOOK_UNAVAILABLE',
      };
    }
    return { kind: 'anonymous' };
  }

  if (stashedOwnership?.ownerKey !== buildAgentOwnerKey(caller.identity)) {
    return {
      kind: 'error',
      message: stashedOwnership
        ? `Stashed runbook ${stashedId} is owned by a different caller.`
        : `Stashed runbook ${stashedId} has no agent ownership; restore as anonymous (unset RD_AGENT_ID) or claim a delegation token.`,
      code: 'OWNED_RUNBOOK_UNAVAILABLE',
    };
  }

  const parentState = await manager.load(stashedOwnership.parentRunId);
  if (
    !parentState ||
    parentState.lifecycle === 'completed' ||
    parentState.lifecycle === 'stopped'
  ) {
    const parentLifecycle = parentState?.lifecycle ?? 'unknown';
    const reason = parentState
      ? `parent runbook is ${parentLifecycle}`
      : 'parent runbook state is missing';
    return {
      kind: 'error',
      message: `Cannot restore stashed runbook ${stashedId}: ${reason}.`,
      code: 'OWNED_RUNBOOK_UNAVAILABLE',
    };
  }

  return { kind: 'owned', identity: caller.identity };
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
          const target = await resolveStashTarget(manager, sessionService, caller);
          switch (target.kind) {
            case 'anonymous':
              state = await sessionService.unstash();
              break;
            case 'owned':
              state = await sessionService.unstashForOwner(target.identity);
              break;
            case 'error':
              output.error(target.message, target.code);
              output.flush();
              process.exitCode = 1;
              return;
            default: {
              const _exhaustive: never = target;
              return _exhaustive;
            }
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
