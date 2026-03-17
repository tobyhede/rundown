// packages/cli/src/commands/goto.ts

import type { Command } from 'commander';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { buildGotoContext, validateGotoTarget, executeGoto } from '../helpers/goto-workflow.js';

/**
 * Registers the 'goto' command for jumping to specific steps.
 * @param program - Commander program instance to register the command on
 */
export function registerGotoCommand(program: Command): void {
  program
    .command('goto <step>')
    .description('Jump to specific step (e.g., "3" or "3.1" for substep)')
    .option('--index <number>', 'FOR loop iteration to target')
    .option('--json', 'Output as JSON for programmatic use')
    .action(async (stepArg: string, options: { index?: string; json?: boolean }) => {
      await withErrorHandling(
        async () => {
          const output = new OutputEmitter({ json: options.json });
          const cwd = getCwd();

          const ctx = await buildGotoContext(output, cwd);
          if (!ctx) {
            output.noActiveRunbook('goto');
            output.flush();
            return;
          }

          const validation = validateGotoTarget(stepArg, ctx.steps, options.index);
          if (!validation.ok) {
            output.error(validation.error, validation.code, validation.details);
            output.flush();
            process.exit(1);
          }

          const result = await executeGoto(ctx, validation.target);
          if (!result.ok) {
            output.error(result.error, result.code);
            output.flush();
            process.exit(1);
          }

          // Flush any remaining output
          output.flush();

          if (result.loopResult === 'stopped') {
            process.exit(1);
          }
        },
        { json: options.json },
      );
    });
}
