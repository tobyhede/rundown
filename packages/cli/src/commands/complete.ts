// packages/cli/src/commands/complete.ts

import type { Command } from 'commander';
import { RunbookStateManager } from '@rundown-org/core';
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
      await withErrorHandling(async () => {
        const output = new OutputEmitter({ json: options.json });
        const cwd = getCwd();
        const manager = new RunbookStateManager(cwd);
        const state = await manager.getActive(options.agent);

        if (!state) {
          output.noActiveRunbook('complete');
          output.flush();
          return;
        }

        // Emit metadata
        output.metadata(buildMetadata(state));

        const steps = getRunbookFromState(state, cwd);
        await manager.update(state.id, {
          step: steps[steps.length - 1].name,
          variables: { ...state.variables, completed: true }
        });
        await manager.popRunbook(options.agent);

        // Emit completion
        output.complete(message ?? 'Runbook completed successfully');
        output.flush();
      }, { json: options.json });
    });
}
