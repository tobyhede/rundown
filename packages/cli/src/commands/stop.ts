// packages/cli/src/commands/stop.ts

import type { Command } from 'commander';
import { RunbookStateManager, SessionService, isError, type RunbookState } from '@rundown-org/core';
import { getCwd } from '../helpers/context.js';
import { buildMetadata } from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { handleParentCompletion, extractParentLinkage } from '../helpers/delegation-completion.js';
import { resolveActiveRunbook } from '../helpers/active-runbook-resolver.js';
import {
  cleanupOrphanedActiveStack,
  isRecoverableActiveStackError,
} from '../helpers/active-runbook-cleanup.js';
import { parseClaimIdOption } from '../helpers/claim-id-option.js';

/**
 * Registers the 'stop' command for aborting runbooks.
 * @param program - Commander program instance to register the command on
 */
export function registerStopCommand(program: Command): void {
  program
    .command('stop')
    .description('Abort current runbook')
    .argument('[message]', 'Stop message')
    .option('--claim-id <claimId>', 'Target a claimed delegated child runbook')
    .option('--text', 'Output as human-readable text')
    .action(async (message: string | undefined, options: { claimId?: string; text?: boolean }) => {
      await withErrorHandling(
        async () => {
          const cwd = getCwd();
          const output = new OutputEmitter({ text: options.text, command: 'stop' });
          const manager = new RunbookStateManager(cwd);
          const sessionService = new SessionService(manager);

          let state: RunbookState | null = null;
          let getActiveError: Error | undefined;
          const claimTarget = parseClaimIdOption(options.claimId, output);
          if (!claimTarget.ok) return;
          try {
            const active = await resolveActiveRunbook(sessionService, {
              claimId: claimTarget.claimId,
            });
            switch (active.kind) {
              case 'claim':
              case 'default':
                state = active.state;
                break;
              case 'none':
                break;
              case 'stale_claim':
                output.error(active.message, 'CLAIMED_RUNBOOK_UNAVAILABLE');
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
            // Unexpected errors must propagate — but stale/corrupted state errors
            // fall through to the orphan cleanup path since stop is a cleanup command.
            if (getActiveError && !isRecoverableActiveStackError(getActiveError)) {
              throw getActiveError;
            }
            if (claimTarget.claimId !== undefined) {
              output.noActiveRunbook('stop');
              output.flush();
              return;
            }
            const orphanId = await cleanupOrphanedActiveStack(manager, sessionService);
            if (orphanId) {
              // Corrupted or missing state — delete the broken file and pop the stack
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
            lifecycle: 'stopped',
          });
          await sessionService.releaseRunbook(state.id);

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
