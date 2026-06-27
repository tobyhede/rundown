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
import { propagateChildTerminal, extractParentLinkage } from '../helpers/delegation-completion.js';
import { getRunbookFromState } from '../helpers/runbook-loader.js';
import {
  cleanupOrphanedActiveStack,
  isRecoverableActiveStackError,
} from '../helpers/active-runbook-cleanup.js';
import { parseClaimIdOption } from '../helpers/claim-id-option.js';
import { forceTerminalWorkflow } from '../helpers/force-terminal-workflow.js';

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
          // Actor-context ingress (Plan: cli-actor-context-ingress): `stop` is a
          // workflow-level force-terminal override and the narrow --claim-id
          // force path; it invokes no actor-context-gated core policy, so it
          // constructs no ActorContext. A future actor-gated force-terminal
          // policy would consume readActorSourceIngress + resolveActorContext.
          const manager = new RunbookStateManager(cwd);
          const sessionService = new SessionService(manager);

          const claimTarget = parseClaimIdOption(options.claimId, output);
          if (!claimTarget.ok) return;

          // Bare `rd stop` is a workflow-level force override: it targets the
          // outermost contiguous-inline ancestor of the active runbook and forces
          // every active inline descendant terminal first. Bare stop is a failure
          // terminal and exits non-zero. `--claim-id` keeps the narrow delegated
          // report-only semantics below.
          if (claimTarget.claimId === undefined) {
            const actorService = createCliRunbookActorService(manager);
            let outcome: Awaited<ReturnType<typeof forceTerminalWorkflow>>;
            try {
              outcome = await forceTerminalWorkflow({
                kind: 'stop',
                message,
                cwd,
                sessionService,
                actorService,
                output,
              });
            } catch (error: unknown) {
              // Invalid persisted snapshots surface only when the machine
              // rehydrates inside sendAndSync. `stop` is an explicit recovery
              // action, so fall through to orphan cleanup against the resolved
              // chain instead of leaving the user stuck behind a freshness error.
              if (
                error instanceof InvalidRunbookStateError ||
                (isError(error) && isRecoverableActiveStackError(error))
              ) {
                const orphanId = await cleanupOrphanedActiveStack(manager, sessionService);
                if (orphanId) {
                  output.stopped('Removed unusable runbook state from session');
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
                  output.stopped('Removed unusable runbook state from session');
                } else {
                  output.noActiveRunbook('stop');
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
                output.noActiveRunbook('stop', 'RUNBOOK_NOT_RUNNING');
                output.flush();
                return;
              case 'completed':
              case 'stopped':
                // Successful forced stop of the resolved inline root. Only the
                // resolved root may propagate to its own parent (report-only
                // across a delegation boundary); descendants must not. Bare stop
                // exits 1.
                output.metadata(buildMetadata(outcome.targetState));
                output.stopped(message ?? 'Runbook stopped');
                if (extractParentLinkage(outcome.finalTargetState)) {
                  await propagateChildTerminal(outcome.finalTargetState, 'fail', cwd, output);
                }
                output.flush();
                process.exitCode = 1;
                return;
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
            // tries to rehydrate inside sendAndSync. In the claim path the
            // claimed child is unavailable; bare-command orphan cleanup is
            // handled in the force-terminal branch above.
            if (error instanceof InvalidRunbookStateError) {
              output.noActiveRunbook('stop');
              output.flush();
              return;
            }
            throw error;
          }
          await sessionService.releaseRunbook(state.id);

          // Emit structured output - renderer decides format
          output.metadata(buildMetadata(state));
          output.stopped(message ?? 'Runbook stopped');

          // `rd stop --claim-id` is a delegated report-only close: it reports the
          // child's fail terminal to the delegating parent (collection pending
          // until `rd collect`) and keeps command-success exit 0. Bare `rd stop`
          // is handled above as a workflow force terminal and exits non-zero.
          if (syncResult && extractParentLinkage(syncResult.state)) {
            await propagateChildTerminal(syncResult.state, 'fail', cwd, output);
          }

          output.flush();
        },
        { text: options.text },
      );
    });
}
