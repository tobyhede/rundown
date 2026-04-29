// packages/cli/src/commands/complete.ts

import type { Command } from 'commander';
import { RunbookStateManager, SessionService, isError, type RunbookState } from '@rundown-org/core';
import { getCwd } from '../helpers/context.js';
import { buildMetadata } from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { getRunbookFromState } from '../helpers/runbook-loader.js';
import { resolveCallerIdentity } from '../helpers/caller-identity.js';
import { resolveActiveRunbook } from '../helpers/active-runbook-resolver.js';
import {
  cleanupOrphanedActiveStack,
  isRecoverableActiveStackError,
} from '../helpers/active-runbook-cleanup.js';

/**
 * Registers the 'complete' command for manually completing runbooks.
 *
 * Note: Runbooks auto-complete when the final step's PASS transition executes.
 * This command is for forcing early completion from any step, bypassing
 * remaining steps. Use cases include:
 * - Early exit when remaining steps are unnecessary
 * - Agent-driven completion where manual override is needed
 * - Testing/debugging runbook execution
 *
 * @param program - Commander program instance to register the command on
 */
export function registerCompleteCommand(program: Command): void {
  program
    .command('complete')
    .description('Force early completion of current runbook (runbooks auto-complete on final step)')
    .argument('[message]', 'Completion message')
    .option('--text', 'Output as human-readable text')
    .action(async (message: string | undefined, options: { text?: boolean }) => {
      await withErrorHandling(
        async () => {
          const output = new OutputEmitter({ text: options.text });
          const cwd = getCwd();
          const manager = new RunbookStateManager(cwd);
          const sessionService = new SessionService(manager);

          let state: RunbookState | null = null;
          let getActiveError: Error | undefined;
          let cleanedStaleOwnedRunbook = false;
          const caller = resolveCallerIdentity();
          try {
            const active = await resolveActiveRunbook(sessionService, caller);

            switch (active.kind) {
              case 'owned':
              case 'default':
                state = active.state;
                break;
              case 'none':
                if (caller.kind === 'identified') {
                  output.noActiveRunbook('complete');
                  output.flush();
                  return;
                }
                break;
              case 'stale_owner':
                await sessionService.releaseRunbook(active.ownership.childRunId);
                cleanedStaleOwnedRunbook = true;
                break;
              case 'invalid_identity':
                output.error(active.message, 'OWNED_RUNBOOK_UNAVAILABLE');
                output.flush();
                process.exitCode = 1;
                return;
              default: {
                const _exhaustive: never = active;
                return _exhaustive;
              }
            }
          } catch (error: unknown) {
            getActiveError = isError(error) ? error : new Error(String(error));
          }

          if (!state) {
            if (cleanedStaleOwnedRunbook) {
              output.complete('Removed unusable owned runbook state from session');
              output.flush();
              return;
            }
            if (getActiveError && !isRecoverableActiveStackError(getActiveError)) {
              throw getActiveError;
            }
            const orphanId = await cleanupOrphanedActiveStack(manager, sessionService);
            if (orphanId) {
              output.complete('Removed unusable runbook state from session');
              output.flush();
              return;
            }
            output.noActiveRunbook('complete');
            output.flush();
            return;
          }

          // Emit metadata
          output.metadata(buildMetadata(state));

          const steps = getRunbookFromState(state, cwd);
          await manager.update(state.id, {
            step: steps[steps.length - 1].name,
            lifecycle: 'completed',
          });
          await sessionService.releaseRunbook(state.id);

          // Emit completion
          output.complete(message ?? 'Runbook completed successfully');
          output.flush();
        },
        { text: options.text },
      );
    });
}
