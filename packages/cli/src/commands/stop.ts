// packages/cli/src/commands/stop.ts

import type { Command } from 'commander';
import { getProjectRoot } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { TOKEN_OPTION_DESCRIPTION, parseTokenOption } from '../helpers/token-option.js';
import { runSeamTerminal } from '../helpers/terminal-command.js';
import { parseRunId } from '../helpers/run-option.js';
import { runEscapeHatchStop } from '../helpers/escape-hatch.js';
import { NO_HUMAN, humanAt, type HumanConfirmation } from '../services/human-confirmation.js';

/** Help text of `stop --run`, the human escape hatch. */
const RUN_OPTION_DESCRIPTION =
  'Human escape hatch for a lost owner token: stop this top-level run by id after confirming at an interactive terminal (audited; never for agents)';

/**
 * Registers the 'stop' command for aborting runbooks.
 *
 * The command is a thin front end: the Owner Token names the run, core
 * resolves it and applies the FORCE_STOP terminal through the lifecycle seam
 * (via {@link runSeamTerminal}); the CLI renders the outcome.
 *
 * `--run <id>` without `--token` is the human escape hatch (#906): the one
 * mutation a run id may drive, refused `INTERACTIVE_REQUIRED` unless a human
 * at an interactive terminal confirms it, and audited on the run
 * ({@link runEscapeHatchStop}). `--run` with `--token` stays `INVALID_SYNTAX`.
 *
 * @param program - Commander program instance to register the command on
 * @param human - The human at the terminal the escape hatch asks; none by default
 */
export function registerStopCommand(program: Command, human: HumanConfirmation = NO_HUMAN): void {
  program
    .command('stop')
    .description('Abort a running runbook')
    .argument('[message]', 'Stop message')
    .option('--token <token>', TOKEN_OPTION_DESCRIPTION)
    .option('--run <runId>', RUN_OPTION_DESCRIPTION)
    .option('--text', 'Output as human-readable text')
    .action(
      async (
        message: string | undefined,
        options: { token?: string; run?: string; text?: boolean },
        command: Command,
      ) => {
        await withErrorHandling(
          async () => {
            const output = new OutputEmitter({ text: options.text, command: 'stop' });
            if (options.run !== undefined && options.token === undefined) {
              const runId = parseRunId(options.run, output);
              if (runId === undefined) return;
              const exitError = await runEscapeHatchStop(output, getProjectRoot(), {
                runId,
                human: humanAt(command, human),
                ...(message !== undefined ? { message } : {}),
              });
              if (exitError) process.exitCode = 1;
              return;
            }
            const token = parseTokenOption(options, 'stop', output);
            if (token === undefined) return;
            const { exitError } = await runSeamTerminal(output, getProjectRoot(), 'stop', {
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
