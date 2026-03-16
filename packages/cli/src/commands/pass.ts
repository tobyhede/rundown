// packages/cli/src/commands/pass.ts

import type { Command } from 'commander';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import {
  buildTransitionContext,
  createPassTransitionConfig,
  executeTransition,
  type ExplicitTarget,
} from '../helpers/transitions.js';
import { handleDelegationCompletion } from '../helpers/delegation-completion.js';

/**
 * Registers the 'pass' command for marking steps as passed.
 * @param program - Commander program instance to register the command on
 */
export function registerPassCommand(program: Command): void {
  program
    .command('pass')
    .aliases(['yes', 'ok'])
    .description('Mark current step as passed (triggers PASS transition)')
    .option('--step <stepId>', 'Target specific substep')
    .option('--index <number>', 'FOR loop iteration to target (requires --step)')
    .option('--json', 'Output as JSON')
    .action(async (options: { step?: string; index?: string; json?: boolean }) => {
      await withErrorHandling(
        async () => {
          const output = new OutputEmitter({ json: options.json });

          // Validate option dependencies
          if (options.index && !options.step) {
            output.error('--index requires --step', 'INVALID_SYNTAX');
            output.flush();
            process.exit(1);
          }

          const cwd = getCwd();
          const ctx = await buildTransitionContext(output, cwd);

          if (!ctx) {
            output.noActiveRunbook('pass');
            output.flush();
            return;
          }

          let shouldExitWithError = false;
          try {
            const passConfig = createPassTransitionConfig();
            const explicitTarget: ExplicitTarget | undefined = options.step
              ? { stepId: options.step, index: options.index }
              : undefined;

            const result = await executeTransition(ctx, passConfig, explicitTarget);
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
            process.exitCode = 1;
          }
        },
        { json: options.json },
      );
    });
}
