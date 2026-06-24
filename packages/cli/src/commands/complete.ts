// packages/cli/src/commands/complete.ts

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
import { getRunbookFromState } from '../helpers/runbook-loader.js';
import {
  cleanupOrphanedActiveStack,
  isRecoverableActiveStackError,
} from '../helpers/active-runbook-cleanup.js';
import { parseClaimIdOption } from '../helpers/claim-id-option.js';
import { extractParentLinkage, propagateChildTerminal } from '../helpers/delegation-completion.js';
import { forceTerminalWorkflow } from '../helpers/force-terminal-workflow.js';

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
    .option('--claim-id <claimId>', 'Target a claimed delegated child runbook')
    .option('--text', 'Output as human-readable text')
    .action(async (message: string | undefined, options: { claimId?: string; text?: boolean }) => {
      await withErrorHandling(
        async () => {
          const output = new OutputEmitter({ text: options.text, command: 'complete' });
          const cwd = getCwd();
          const manager = new RunbookStateManager(cwd);
          const sessionService = new SessionService(manager);

          const claimTarget = parseClaimIdOption(options.claimId, output);
          if (!claimTarget.ok) return;

          // Bare `rd complete` is a workflow-level force override: it targets the
          // outermost contiguous-inline ancestor of the active runbook and forces
          // every active inline descendant terminal first. `--claim-id` keeps the
          // narrow delegated-child semantics below.
          if (claimTarget.claimId === undefined) {
            const actorService = createCliRunbookActorService(manager);
            let outcome: Awaited<ReturnType<typeof forceTerminalWorkflow>>;
            try {
              outcome = await forceTerminalWorkflow({
                kind: 'complete',
                message,
                cwd,
                sessionService,
                actorService,
                output,
              });
            } catch (error: unknown) {
              // Invalid persisted snapshots surface only when the machine
              // rehydrates inside sendAndSync. `complete` is an explicit recovery
              // action, so fall through to orphan cleanup against the resolved
              // chain instead of leaving the user stuck behind a freshness error.
              if (
                error instanceof InvalidRunbookStateError ||
                (isError(error) && isRecoverableActiveStackError(error))
              ) {
                const orphanId = await cleanupOrphanedActiveStack(manager, sessionService);
                if (orphanId) {
                  output.complete('Removed unusable runbook state from session');
                  output.flush();
                  return;
                }
              }
              throw error;
            }

            switch (outcome.status) {
              case 'none': {
                const orphanId = await cleanupOrphanedActiveStack(manager, sessionService);
                if (orphanId) {
                  output.complete('Removed unusable runbook state from session');
                } else {
                  output.noActiveRunbook('complete');
                }
                output.flush();
                return;
              }
              case 'missing-inline-parent':
              case 'inline-cycle':
              case 'root-unavailable':
                output.error(outcome.message, outcome.code);
                output.flush();
                process.exitCode = 1;
                return;
              case 'already-terminal':
                output.metadata(buildMetadata(outcome.targetState));
                output.noActiveRunbook('complete', 'RUNBOOK_NOT_RUNNING');
                output.flush();
                return;
              case 'completed':
              case 'stopped': {
                // Successful forced terminal of the resolved inline root. Only
                // the resolved root may propagate to its own parent (report-only
                // across a delegation boundary); descendants must not. The root's
                // actual terminal lifecycle — never the command kind — decides
                // how it propagates: a stopped terminal must report `fail` and
                // exit non-zero, never a silent `pass` (No silent mapping).
                output.metadata(buildMetadata(outcome.targetState));
                const rootStopped = outcome.finalTargetState.lifecycle === 'stopped';
                if (extractParentLinkage(outcome.finalTargetState)) {
                  await propagateChildTerminal(
                    outcome.finalTargetState,
                    rootStopped ? 'fail' : 'pass',
                    cwd,
                    output,
                  );
                }
                if (rootStopped) {
                  output.stopped(message ?? 'Runbook stopped');
                  output.flush();
                  process.exitCode = 1;
                  return;
                }
                output.complete(message ?? 'Runbook completed successfully');
                output.flush();
                return;
              }
              default: {
                const _exhaustive: never = outcome;
                return _exhaustive;
              }
            }
          }

          let state: RunbookState | null = null;
          let getActiveError: Error | undefined;
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
            // Claim path only: claimId is always defined here, so orphan cleanup
            // (a bare-command recovery) never applied — report no active runbook.
            if (getActiveError && !isRecoverableActiveStackError(getActiveError)) {
              throw getActiveError;
            }
            output.noActiveRunbook('complete');
            output.flush();
            return;
          }

          // Emit metadata
          output.metadata(buildMetadata(state));

          // Short-circuit when the runbook is already terminal: FORCE_COMPLETE
          // would be a no-op at the machine, and propagating pass to the
          // parent on a terminal child is wrong (Issue 3). Release the
          // session entry and emit a clear no-op message; do NOT call
          // sendAndSync and do NOT propagate to a parent.
          if (state.lifecycle !== 'running') {
            await sessionService.releaseRunbook(state.id);
            output.noActiveRunbook('complete', 'RUNBOOK_NOT_RUNNING');
            output.flush();
            return;
          }

          const steps = getRunbookFromState(state, cwd);
          const actorService = createCliRunbookActorService(manager);
          let syncResult: Awaited<ReturnType<RunbookActorService['sendAndSync']>>;
          try {
            syncResult = await actorService.sendAndSync(state.id, steps, {
              type: 'FORCE_COMPLETE',
              message,
            });
          } catch (error: unknown) {
            // Invalid persisted snapshots can be detected only when the machine
            // tries to rehydrate inside sendAndSync. In the claim path the
            // claimed child is unavailable; bare-command orphan cleanup is
            // handled in the force-terminal branch above.
            if (error instanceof InvalidRunbookStateError) {
              output.error(
                `Claimed runbook ${claimTarget.claimId} is unavailable`,
                'CLAIMED_RUNBOOK_UNAVAILABLE',
              );
              output.flush();
              process.exitCode = 1;
              return;
            }
            throw error;
          }
          await sessionService.releaseRunbook(state.id);
          if (syncResult && extractParentLinkage(syncResult.state)) {
            // Propagate on linkage kind (Plan 5): an inline child composes/advances
            // the parent synchronously; a delegation child reports-only (the
            // delegating run is left collection pending until `rd collect`).
            await propagateChildTerminal(syncResult.state, 'pass', cwd, output);
          }

          // Emit completion
          output.complete(message ?? 'Runbook completed successfully');
          output.flush();
        },
        { text: options.text },
      );
    });
}
