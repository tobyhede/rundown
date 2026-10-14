// packages/cli/src/commands/complete.ts

import type { Command } from 'commander';
import { getProjectRoot } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { parseTokenOption, withTokenOption } from '../helpers/token-option.js';
import { runSeamTerminal } from '../helpers/terminal-command.js';

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
 * The command is a thin front end: the Owner Token names the run, core
 * resolves it and applies the FORCE_COMPLETE terminal through the lifecycle
 * seam (via {@link runSeamTerminal}); the CLI renders the outcome.
 *
 * @param program - Commander program instance to register the command on
 */
export function registerCompleteCommand(program: Command): void {
  withTokenOption(
    program
      .command('complete')
      .description(
        'Force early completion of a running runbook (runbooks auto-complete on final step)',
      )
      .argument('[message]', 'Completion message'),
  )
    .option('--text', 'Output as human-readable text')
    .action(
      async (
        message: string | undefined,
        options: { token?: string; run?: string; text?: boolean },
      ) => {
        await withErrorHandling(
          async () => {
            const output = new OutputEmitter({ text: options.text, command: 'complete' });
            const token = parseTokenOption(options, 'complete', output);
            if (token === undefined) return;
            const { exitError } = await runSeamTerminal(output, getProjectRoot(), 'complete', {
              token,
              ...(message !== undefined ? { message } : {}),
            });
            if (exitError) process.exitCode = 1;
          },
          { text: options.text },
        );
      },
    );
}
