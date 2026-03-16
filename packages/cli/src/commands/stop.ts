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

          let state: RunbookState | null = null;
          try {
            state = await sessionService.getActive();
          } catch {
            // State exists but can't be loaded (e.g., legacy snapshot)
            // Fall through to orphan cleanup below
          }

          if (!state) {
            // P2: Check for orphaned stack entry
            const session = await manager.loadSession();
            const orphanId = session.defaultStack[session.defaultStack.length - 1];
            if (orphanId) {
              // Corrupted or missing state — delete the broken file and pop the stack
              await manager.delete(orphanId);
              await sessionService.popRunbook();
              output.stopped('Removed unusable runbook state from session');
              output.flush();
              return;
            }
            output.noActiveRunbook('stop');
            output.flush();
            return;
          }

          // P3: Persist STOP metadata instead of deleting
          const updatedState = await manager.update(state.id, {
            lastAction: { type: 'STOP' },
            lastResult: 'fail',
            variables: { ...state.variables, stopped: true },
          });
          await sessionService.popRunbook();

          // Emit structured output - renderer decides format
          output.metadata(buildMetadata(state));
          output.stopped(message ?? 'Runbook stopped');

          // Propagate FAIL to parent if delegation exists.
          // The return value is intentionally ignored: a user-initiated stop
          // always succeeds (exit 0) even if the parent propagation itself stops.
          if (updatedState.delegation) {
            await handleDelegationCompletion(updatedState, 'fail', cwd, output);
          }

          output.flush();
        },
        { json: options.json },
      );
    });
}
