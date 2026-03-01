// packages/cli/src/commands/stash.ts

import type { Command } from 'commander';
import { RunbookStateManager, SessionService } from '@rundown-org/core';
import { getCwd, getStepTotal } from '../helpers/context.js';
import { buildMetadata } from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';

/**
 * Registers the 'stash' command for pausing runbook enforcement.
 * @param program - Commander program instance to register the command on
 */
export function registerStashCommand(program: Command): void {
  program
    .command('stash')
    .description('Pause runbook enforcement, preserve state')
    .option('--json', 'Output as JSON for programmatic use')
    .action(async (options: { json?: boolean }) => {
      await withErrorHandling(
        async () => {
          const cwd = getCwd();
          const output = new OutputEmitter({ json: options.json });
          const manager = new RunbookStateManager(cwd);
          const sessionService = new SessionService(manager);
          const state = await sessionService.getActive();

          if (!state) {
            output.noActiveRunbook();
            output.flush();
            return;
          }

          const totalSteps = await getStepTotal(cwd, state.runbook);

          // Stash the runbook
          const stashedId = await sessionService.stash();
          if (!stashedId) {
            output.status(false, 'stash', 'A runbook is already stashed. Pop it first.');
            output.flush();
            return;
          }

          // Emit structured output - TextRenderer handles stash action specially
          output.metadata(buildMetadata(state));
          output.status(true, 'stash', 'Runbook stashed', {
            position: {
              current: state.step,
              total: totalSteps,
            },
            stashedId,
          });
          output.flush();
        },
        { json: options.json },
      );
    });
}
