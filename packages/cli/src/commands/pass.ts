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
import { handleParentCompletion, extractParentLinkage } from '../helpers/delegation-completion.js';
import { validateIndexRequiresStep } from '../helpers/index-option.js';

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
            output.noActiveRunbook('pass');
            output.flush();
            return;
          }

          // Exit-code contract (mirrors fail.ts): when this runbook is a
          // delegated child whose terminal outcome is absorbed non-terminally
          // by the parent, the orchestrated workflow is still progressing —
          // `rd pass` exits 0. Exit 1 is reserved for cases where the
          // workflow has actually halted (parent propagation also stopped,
          // or no parent linkage and local lifecycle is `stopped`).
          let shouldExitWithError = false;
          try {
            const passConfig = createPassTransitionConfig();
            const explicitTarget: ExplicitTarget | undefined = options.step
              ? { stepId: options.step, index: options.index }
              : undefined;

            const result = await executeTransition(ctx, passConfig, explicitTarget);
            if (result === 'stopped') shouldExitWithError = true;

            // Parent propagation supersedes the local-stop signal:
            // 'handled' → parent absorbed non-terminally; 'stopped' → parent
            // also terminated; 'not-applicable' → keep the local signal.
            const freshState = await ctx.manager.load(ctx.state.id);
            if (freshState && extractParentLinkage(freshState)) {
              const isTerminal =
                freshState.lifecycle === 'completed' || freshState.lifecycle === 'stopped';
              if (isTerminal) {
                const propResult = freshState.lifecycle === 'completed' ? 'pass' : 'fail';
                const propagationResult = await handleParentCompletion(
                  freshState,
                  propResult,
                  cwd,
                  output,
                );
                if (propagationResult === 'handled') {
                  shouldExitWithError = false;
                } else if (propagationResult === 'stopped') {
                  shouldExitWithError = true;
                }
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
