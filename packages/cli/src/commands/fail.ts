// packages/cli/src/commands/fail.ts

import type { Command } from 'commander';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import {
  buildTransitionContext,
  createFailTransitionConfig,
  executeTransition,
  type ExplicitTarget,
} from '../helpers/transitions.js';
import { handleParentCompletion, extractParentLinkage } from '../helpers/delegation-completion.js';
import { validateIndexRequiresStep } from '../helpers/index-option.js';

/**
 * Registers the 'fail' command for marking steps as failed.
 * @param program - Commander program instance to register the command on
 */
export function registerFailCommand(program: Command): void {
  program
    .command('fail')
    .alias('no')
    .description('Mark current step as failed (triggers FAIL transition)')
    .option('--step <stepId>', 'Target specific substep')
    .option('--index <number>', 'FOR loop iteration to target (requires --step)')
    .option('--text', 'Output as human-readable text')
    .action(async (options: { step?: string; index?: string; text?: boolean }) => {
      await withErrorHandling(
        async () => {
          const output = new OutputEmitter({ text: options.text });

          const depError = validateIndexRequiresStep(options.index, options.step);
          if (depError) {
            output.error(depError, 'INVALID_SYNTAX');
            output.flush();
            process.exit(1);
          }

          const cwd = getCwd();
          const ctx = await buildTransitionContext(output, cwd);

          if (!ctx) {
            output.noActiveRunbook('fail');
            output.flush();
            return;
          }

          let shouldExitWithError = false;
          try {
            const failConfig = createFailTransitionConfig();
            const explicitTarget: ExplicitTarget | undefined = options.step
              ? { stepId: options.step, index: options.index }
              : undefined;

            const result = await executeTransition(ctx, failConfig, explicitTarget);
            if (result === 'stopped') shouldExitWithError = true;

            // Parent propagation — fires when child run reaches terminal state
            const freshState = await ctx.manager.load(ctx.state.id);
            if (freshState && extractParentLinkage(freshState)) {
              const isTerminal =
                freshState.variables.completed === true || freshState.variables.stopped === true;
              if (isTerminal) {
                const propResult = freshState.variables.completed ? 'pass' : 'fail';
                const propagationResult = await handleParentCompletion(
                  freshState,
                  propResult,
                  cwd,
                  output,
                );
                if (propagationResult === 'stopped') shouldExitWithError = true;
              }
            }
          } finally {
            ctx.actor.stop();
          }
          if (shouldExitWithError) {
            process.exitCode = 1;
          }
        },
        { text: options.text },
      );
    });
}
