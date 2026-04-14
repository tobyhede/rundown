// packages/cli/src/commands/stop.ts

import type { Command } from 'commander';
import { RunbookStateManager, SessionService, isError, type RunbookState } from '@rundown-org/core';
import { getCwd } from '../helpers/context.js';
import { buildMetadata } from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { handleParentCompletion, extractParentLinkage } from '../helpers/delegation-completion.js';

/**
 * Registers the 'stop' command for aborting runbooks.
 * @param program - Commander program instance to register the command on
 */
export function registerStopCommand(program: Command): void {
  program
    .command('stop')
    .description('Abort current runbook')
    .argument('[message]', 'Stop message')
    .option('--text', 'Output as human-readable text')
    .action(async (message: string | undefined, options: { text?: boolean }) => {
      await withErrorHandling(
        async () => {
          const cwd = getCwd();
          const output = new OutputEmitter({ text: options.text });
          const manager = new RunbookStateManager(cwd);
          const sessionService = new SessionService(manager);

          let state: RunbookState | null = null;
          let getActiveError: Error | undefined;
          try {
            state = await sessionService.getActive();
          } catch (error: unknown) {
            getActiveError = Error.isError(error) ? error : new Error(String(error));
          }

          if (!state) {
            // Unexpected errors must propagate — but stale/corrupted state errors
            // fall through to the orphan cleanup path since stop is a cleanup command.
            if (
              getActiveError &&
              !getActiveError.message.includes('Stale runbook state') &&
              !getActiveError.message.includes('dynamic-step snapshots') &&
              !(isError(getActiveError) && getActiveError.name === 'SyntaxError')
            ) {
              throw getActiveError;
            }
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

          // Propagate FAIL to parent if parent linkage exists.
          // The return value is intentionally ignored: a user-initiated stop
          // always succeeds (exit 0) even if the parent propagation itself stops.
          if (extractParentLinkage(updatedState)) {
            await handleParentCompletion(updatedState, 'fail', cwd, output);
          }

          output.flush();
        },
        { text: options.text },
      );
    });
}
