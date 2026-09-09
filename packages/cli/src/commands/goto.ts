// packages/cli/src/commands/goto.ts

import type { Command } from 'commander';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { commandStreamOptionsForOutputMode } from '../services/execution.js';
import {
  buildGotoContext,
  validateGotoTarget,
  executeGoto,
  gotoResultRequiresFailureExit,
  renderNavigationRefusal,
} from '../helpers/goto-workflow.js';
import {
  withTransitionTargetOptions,
  parseTransitionTarget,
  transitionTargetFields,
} from '../helpers/transition-target.js';

/**
 * Registers the 'goto' command for jumping to specific steps.
 * @param program - Commander program instance to register the command on
 */
export function registerGotoCommand(program: Command): void {
  withTransitionTargetOptions(
    program
      .command('goto <step>')
      .description('Jump to specific step (e.g., "3" or "3.1" for substep)')
      .option('--index <number>', 'FOR loop iteration to target'),
  )
    .option('--text', 'Output as human-readable text')
    .action(
      async (
        stepArg: string,
        options: {
          index?: string;
          claimId?: string;
          run?: string;
          text?: boolean;
        },
      ) => {
        await withErrorHandling(
          async () => {
            const output = new OutputEmitter({ text: options.text, command: 'goto' });
            const cwd = getCwd();

            const target = parseTransitionTarget(options, output);
            if (!target) return;
            const contextResult = await buildGotoContext(output, cwd, {
              ...transitionTargetFields(target),
              commandStreamOptions: commandStreamOptionsForOutputMode(options.text),
            });
            // Refusal rendering is owned by one named dispatcher in
            // goto-workflow.ts, matching renderRefusal (pass/fail) and
            // renderTerminalOutcome (complete/stop). Only the exit-code mapping
            // stays here — that is the Category-A part.
            if (contextResult.kind !== 'ready') {
              const exitError = renderNavigationRefusal(output, contextResult);
              output.flush();
              if (exitError) process.exitCode = 1;
              return;
            }
            const ctx = contextResult.ctx;

            const validation = validateGotoTarget(stepArg, ctx.navigation.steps, options.index);
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

            if (gotoResultRequiresFailureExit(result)) {
              process.exit(1);
            }
          },
          { text: options.text },
        );
      },
    );
}
