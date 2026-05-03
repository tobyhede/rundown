// packages/cli/src/commands/prompt.ts

import type { Command } from 'commander';
import { OutputEmitter } from '../services/output-emitter.js';

/**
 * Registers the 'prompt' command for outputting content in markdown fences.
 * @param program - Commander program instance to register the command on
 */
export function registerPromptCommand(program: Command): void {
  program
    .command('prompt <content>')
    .description('Output content wrapped in markdown fences')
    .option('--text', 'Output as human-readable text')
    .action((content: string, options: { text?: boolean }) => {
      const output = new OutputEmitter({ text: options.text, command: 'prompt' });

      // Emit structured data unconditionally - renderer handles formatting
      // TextRenderer wraps in markdown fences, JSONRenderer outputs as-is
      output.detail({ output: content }, 'prompt');
      output.flush();
    });
}
