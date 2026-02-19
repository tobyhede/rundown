// packages/cli/src/commands/complete.ts

import type { Command } from 'commander';
import {
  RunbookStateManager,
  SessionService,
  RunbookActorService,
  type Step,
} from '@rundown-org/core';
import { getCwd } from '../helpers/context.js';
import { buildMetadata } from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { getRunbookFromState } from '../helpers/runbook-loader.js';

/**
 * Registers the 'complete' command for manually completing runbooks.
 *
 * Note: Runbooks auto-complete when the final step's PASS transition executes.
 * This command is for forcing early completion from any step, bypassing
 * remaining steps. Use cases include:
 * - Early exit when remaining steps are unnecessary
 * - Agent-driven completion where manual override is needed
 * - Testing/debugging workflows
 *
 * @param program - Commander program instance to register the command on
 */
export function registerCompleteCommand(program: Command): void {
  program
    .command('complete')
    .description('Force early completion of current runbook (runbooks auto-complete on final step)')
    .argument('[message]', 'Completion message')
    .option('--agent <agentId>', 'Complete runbook in agent-specific stack')
    .option('--json', 'Output as JSON for programmatic use')
    .action(async (message: string | undefined, options: { agent?: string; json?: boolean }) => {
      await withErrorHandling(
        async () => {
          const cwd = getCwd();
          const output = new OutputEmitter({ json: options.json });
          const manager = new RunbookStateManager(cwd);
          const sessionService = new SessionService(manager);
          const state = await sessionService.getActive(options.agent);

          if (!state) {
            output.noActiveRunbook('complete');
            output.flush();
            return;
          }

          // Route through XState actor
          let steps: Step[];
          try {
            steps = [...getRunbookFromState(state, cwd)];
          } catch (err) {
            // Pop the broken runbook from the session so users can recover
            await sessionService.popRunbook(options.agent);
            output.error(`Runbook state error: ${(err as Error).message}`, 'STATE_ERROR');
            output.flush();
            process.exit(1);
            return; // Defensive: guards against mocked process.exit in tests
          }

          const actorService = new RunbookActorService(manager);

          const syncResult = await actorService.sendAndSync(state.id, steps, {
            type: 'COMPLETE',
            message,
          });
          if (!syncResult) {
            await sessionService.popRunbook(options.agent);
            output.error('Failed to initialize runbook engine', 'ENGINE_INIT_FAILED');
            output.flush();
            process.exit(1);
            return; // Defensive: guards against mocked process.exit in tests
          }

          // Best-effort metadata and binding updates — popRunbook must run regardless
          try {
            await manager.update(state.id, {
              lastAction: { type: 'COMPLETE' },
              lastResult: 'pass',
            });
          } catch {
            // Non-fatal: actor already persisted terminal state via sendAndSync
          }

          if (options.agent && state.parentRunbookId) {
            try {
              await manager.updateAgentBinding(state.parentRunbookId, options.agent, {
                status: 'done',
                result: 'pass',
              });
            } catch {
              // Non-fatal: parent state may be missing or corrupt.
            }
          }

          await sessionService.popRunbook(options.agent);

          // Emit structured output - renderer decides format
          output.metadata(buildMetadata(state));
          output.complete(message ?? 'Runbook completed successfully');
          output.flush();
        },
        { json: options.json },
      );
    });
}
