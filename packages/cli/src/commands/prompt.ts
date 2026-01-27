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
    .option('--json', 'Output as JSON for programmatic use')
    .action((content: string, options: { json?: boolean }) => {
      const output = new OutputEmitter({ json: options.json });

      if (options.json) {
        // JSON mode: output structured data (use 'output' per CLI-OUTPUT-SPEC)
        output.detail({ output: content });
        output.flush();
        return;
      }

      // Text mode: wrap in markdown fences
      output.message('```', 'info');
      output.message(content, 'info');
      output.message('```', 'info');
      output.flush();
    });
}
