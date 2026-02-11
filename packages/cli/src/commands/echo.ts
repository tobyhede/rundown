// packages/cli/src/commands/echo.ts

import type { Command } from 'commander';
import { getCwd } from '../helpers/context.js';
import { DEFAULT_RESULT_SEQUENCE, executeEchoLogic } from '../helpers/echo-command.js';
import { OutputEmitter } from '../services/output-emitter.js';

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
    .option('--json', 'Output as JSON for programmatic use')
    .action(
      async (command: string[] | undefined, options: { result: string[]; json?: boolean }) => {
        const output = new OutputEmitter({ json: options.json });

        try {
          const cwd = getCwd();
          const sequence = options.result.length > 0 ? options.result : DEFAULT_RESULT_SEQUENCE;
          const commandArgs = command ?? [];

          const result = await executeEchoLogic(sequence, commandArgs, cwd);

          // Emit structured data unconditionally - renderer handles formatting
          output.detail(
            {
              result: result.exitCode === 0,
              ...(result.output && { output: result.output }),
              ...(result.error && { error: result.error }),
              exitCode: result.exitCode,
            },
            'echo',
          );
          output.flush();
          process.exit(result.exitCode);
        } catch (error) {
          let message = 'Failed to process test command';
          if (error instanceof Error) {
            message = error.message;
          } else if (typeof error === 'string') {
            message = error;
          }

          // Emit error unconditionally - renderer handles formatting
          output.detail(
            {
              result: false,
              error: message,
              exitCode: 1,
            },
            'echo',
          );
          output.flush();
          process.exit(1);
        }
      },
    );
}
