// packages/cli/src/commands/fail.ts

import type { Command } from 'commander';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import {
  buildTransitionContext,
  createFailTransitionConfig,
  executeTransition,
} from '../helpers/transitions.js';
import { handleDelegationCompletion } from '../helpers/delegation-completion.js';

/**
 * Registers the 'fail' command for marking steps as failed.
 * @param program - Commander program instance to register the command on
 */
export function registerFailCommand(program: Command): void {
  program
    .command('fail')
    .alias('no')
    .description('Mark current step as failed (triggers FAIL transition)')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      await withErrorHandling(
        async () => {
          const output = new OutputEmitter({ json: options.json });
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

            const result = await executeTransition(ctx, failConfig);
            if (result === 'stopped') shouldExitWithError = true;

            // Delegation propagation — fires when child run reaches terminal state
            const freshState = await ctx.manager.load(ctx.state.id);
            if (freshState?.delegation) {
              const isTerminal =
                freshState.variables.completed === true || freshState.variables.stopped === true;
              if (isTerminal) {
                const propResult = freshState.variables.completed ? 'pass' : 'fail';
                const delegationResult = await handleDelegationCompletion(
                  freshState,
                  propResult,
                  cwd,
                  output,
                );
                if (delegationResult === 'stopped') shouldExitWithError = true;
              }
            }
          } finally {
            ctx.actor.stop();
          }
          if (shouldExitWithError) {
            process.exit(1);
          }
        },
        { json: options.json },
      );
    });
}
