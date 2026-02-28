// packages/cli/src/commands/stop.ts

import type { Command } from 'commander';
import { RunbookStateManager, SessionService, type RunbookState } from '@rundown-org/core';
import { getCwd } from '../helpers/context.js';
import { buildMetadata } from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { handleDelegationCompletion } from '../helpers/delegation-completion.js';

/**
 * Registers the 'stop' command for aborting runbooks.
 * @param program - Commander program instance to register the command on
 */
export function registerStopCommand(program: Command): void {
  program
    .command('stop')
    .description('Abort current runbook')
    .argument('[message]', 'Stop message')
    .option('--json', 'Output as JSON for programmatic use')
    .action(async (message: string | undefined, options: { json?: boolean }) => {
      await withErrorHandling(
        async () => {
          const cwd = getCwd();
          const output = new OutputEmitter({ json: options.json });
          const manager = new RunbookStateManager(cwd);
          const sessionService = new SessionService(manager);
          const state = await sessionService.getActive();

          if (!state) {
            output.noActiveRunbook('stop');
            output.flush();
            return;
          }

          // Capture delegation linkage before delete
          const delegationLinkage = state.delegation;

          // Delete and clear
          await manager.delete(state.id);
          await sessionService.popRunbook();

          // Emit structured output - renderer decides format
          output.metadata(buildMetadata(state));
          output.stopped(message ?? 'Runbook stopped');

          // Propagate FAIL to parent if delegation exists.
          // The return value is intentionally ignored: a user-initiated stop
          // always succeeds (exit 0) even if the parent propagation itself stops.
          if (delegationLinkage) {
            const stoppedState: RunbookState = {
              ...state,
              variables: { ...state.variables, stopped: true },
            };
            await handleDelegationCompletion(stoppedState, 'fail', cwd, output);
          }

          output.flush();
        },
        { json: options.json },
      );
    });
}
