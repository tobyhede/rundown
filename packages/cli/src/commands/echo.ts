// packages/cli/src/commands/echo.ts

import type { Command } from 'commander';
import { getCwd } from '../helpers/context.js';
import {
  DEFAULT_RESULT_SEQUENCE,
  executeEchoLogic,
} from '../helpers/echo-command.js';

/**
 * Collect option values into an array.
 * Used for repeatable --result options.
 *
 * @param value - The new value to add
 * @param previous - Previously collected values
 * @returns Updated array with new value appended
 */
export function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

/**
 * Registers the 'echo' command for runbook testing.
 *
 * The echo command is a test helper that echoes back arguments with a
 * configurable pass/fail result. It supports result sequences that change
 * behavior on retries, useful for testing retry logic in runbooks.
 *
 * @param program - Commander program instance to register the command on
 */
export function registerEchoCommand(program: Command): void {
  program
    .command('echo [command...]')
    .description('Echo command for runbook testing')
    .option('-r, --result <outcome>', 'Add result to sequence (pass|fail)', collect, [])
    .action(async (command: string[] | undefined, options: { result: string[] }) => {
      try {
        const cwd = getCwd();
        const sequence = options.result.length > 0
          ? options.result
          : DEFAULT_RESULT_SEQUENCE;
        const commandArgs = command ?? [];

        const result = await executeEchoLogic(sequence, commandArgs, cwd);

        if (result.error) {
          console.error(result.error);
          process.exit(result.exitCode);
        }

        if (result.output) {
          console.log(result.output);
        }

        process.exit(result.exitCode);
      } catch (error) {
        let message = 'Failed to process test command';
        if (error instanceof Error) {
          message = error.message;
        } else if (typeof error === 'string') {
          message = error;
        }
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });
}
