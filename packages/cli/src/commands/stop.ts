// packages/cli/src/commands/stop.ts

import type { Command } from 'commander';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { parseTokenOption, withTokenOption } from '../helpers/token-option.js';
import { runSeamTerminal } from '../helpers/terminal-command.js';

/**
 * Registers the 'stop' command for aborting runbooks.
 *
 * The command is a thin front end: the Owner Token names the run, core
 * resolves it and applies the FORCE_STOP terminal through the lifecycle seam
 * (via {@link runSeamTerminal}); the CLI renders the outcome.
 *
 * @param program - Commander program instance to register the command on
 */
export function registerStopCommand(program: Command): void {
  withTokenOption(
    program
      .command('stop')
      .description('Abort a running runbook')
      .argument('[message]', 'Stop message'),
  )
    .option('--text', 'Output as human-readable text')
    .action(
      async (
        message: string | undefined,
        options: { token?: string; run?: string; text?: boolean },
      ) => {
        await withErrorHandling(
          async () => {
            const output = new OutputEmitter({ text: options.text, command: 'stop' });
            const token = parseTokenOption(options, 'stop', output);
            if (token === undefined) return;
            const { exitError } = await runSeamTerminal(output, getCwd(), 'stop', {
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
