// packages/cli/src/commands/prompt.ts

import type { Command } from 'commander';

/**
 * Registers the 'prompt' command for outputting content in markdown fences.
 * @param program - Commander program instance to register the command on
 */
export function registerPromptCommand(program: Command): void {
  program
    .command('prompt <content>')
    .description('Output content wrapped in markdown fences')
    .action((content: string) => {
      console.log('```');
      console.log(content);
      console.log('```');
    });
}
