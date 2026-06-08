// packages/cli/src/commands/stop.ts

import type { Command } from 'commander';
import {
  type RunbookActorService,
  RunbookStateManager,
  SessionService,
  InvalidRunbookStateError,
  isError,
  resolveCommandTarget,
  type RunbookState,
} from '@rundown-org/core';
import { createCliRunbookActorService } from '../helpers/actor-service-factory.js';
import { getCwd } from '../helpers/context.js';
import { buildMetadata } from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { handleParentCompletion, extractParentLinkage } from '../helpers/delegation-completion.js';
import { getRunbookFromState } from '../helpers/runbook-loader.js';
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
            const active = await resolveCommandTarget(sessionService, {
              claimId: claimTarget.claimId,
            });
            switch (active.kind) {
              case 'claim':
              case 'default':
                state = active.state;
                break;
              case 'terminal_claim':
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

          // Short-circuit when the runbook is already terminal: FORCE_STOP
          // would be a no-op at the machine, and propagating fail to the
          // parent on a terminal child is wrong (Issue 3). Release the
          // session entry (it would otherwise stay pinned on a stopped run)
          // and emit a clear no-op message; do NOT call sendAndSync and
          // do NOT propagate to a parent.
          if (state.lifecycle !== 'running') {
            await sessionService.releaseRunbook(state.id);
            output.metadata(buildMetadata(state));
            output.noActiveRunbook('stop', 'RUNBOOK_NOT_RUNNING');
            output.flush();
            return;
          }

          const steps = getRunbookFromState(state, cwd);
          const actorService = createCliRunbookActorService(manager);
          let syncResult: Awaited<ReturnType<RunbookActorService['sendAndSync']>>;
          try {
            syncResult = await actorService.sendAndSync(state.id, steps, {
              type: 'FORCE_STOP',
              message,
            });
          } catch (error: unknown) {
            // Invalid persisted snapshots can be detected only when the machine
            // tries to rehydrate inside sendAndSync. `stop` is one of the
            // explicit user recovery actions named in CLAUDE.md, so fall
            // through to the same orphan-cleanup path used pre-load instead
            // of leaving the user stuck behind a freshness error. No state
            // is migrated or terminated — the broken file is deleted and
            // the session stack is popped, matching the existing fallback.
            // Claimed children skip cleanup and return with unavailable.
            if (error instanceof InvalidRunbookStateError) {
              if (claimTarget.claimId !== undefined) {
                output.noActiveRunbook('stop');
                output.flush();
                return;
              }
              const orphanId = await cleanupOrphanedActiveStack(manager, sessionService);
              if (orphanId) {
                output.metadata(buildMetadata(state));
                output.stopped('Removed unusable runbook state from session');
                output.flush();
                return;
              }
            }
            throw error;
          }
          await sessionService.releaseRunbook(state.id);

          // Emit structured output - renderer decides format
          output.metadata(buildMetadata(state));
          output.stopped(message ?? 'Runbook stopped');

          // Propagate FAIL to parent if parent linkage exists.
          // The return value is intentionally ignored: a user-initiated stop
          // always succeeds (exit 0) even if the parent propagation itself stops.
          if (syncResult && extractParentLinkage(syncResult.state)) {
            await handleParentCompletion(syncResult.state, 'fail', cwd, output);
          }

          output.flush();
        },
        { text: options.text },
      );
    });
}
