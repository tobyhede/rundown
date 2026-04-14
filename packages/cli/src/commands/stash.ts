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
    .option('--text', 'Output as human-readable text')
    .action(async (options: { text?: boolean }) => {
      await withErrorHandling(
        async () => {
          const cwd = getCwd();
          const output = new OutputEmitter({ text: options.text });
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
            output.error('A runbook is already stashed. Pop it first.', 'ALREADY_STASHED');
            output.flush();
            process.exitCode = 1;
            return;
          }

          // Emit structured output - TextRenderer handles stash action specially
          output.metadata(buildMetadata(state));
          output.status('stash', 'Runbook stashed', {
            position: {
              current: state.step,
              total: totalSteps,
            },
            stashedId,
          });
          output.flush();
        },
        { text: options.text },
      );
    });
}
