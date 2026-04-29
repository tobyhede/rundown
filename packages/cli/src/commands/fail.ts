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
          const contextResult = await buildTransitionContext(output, cwd);
          switch (contextResult.kind) {
            case 'ready':
              break;
            case 'none':
              output.noActiveRunbook('fail');
              output.flush();
              return;
            case 'stale_owner':
            case 'invalid_identity':
              output.error(contextResult.message, 'OWNED_RUNBOOK_UNAVAILABLE');
              output.flush();
              process.exitCode = 1;
              return;
            default: {
              const _exhaustive: never = contextResult;
              return _exhaustive;
            }
          }
          const ctx = contextResult.ctx;

          // Exit-code contract: when this runbook is a delegated child whose
          // terminal outcome is absorbed non-terminally by the parent (e.g. the
          // parent's FAIL transition is RETRY), the orchestrated workflow is
          // still progressing — `rd fail` exits 0 so scripted orchestrators
          // can use exit codes as flow control. RETRY exhaustion that stops
          // the parent (or any other parent-stop outcome) re-asserts exit 1.
          // For non-delegated runs, the local lifecycle drives the exit code.
          let shouldExitWithError = false;
          try {
            const failConfig = createFailTransitionConfig();
            const explicitTarget: ExplicitTarget | undefined = options.step
              ? { stepId: options.step, index: options.index }
              : undefined;

            const result = await executeTransition(ctx, failConfig, explicitTarget);
            if (result === 'stopped') shouldExitWithError = true;

            // Parent propagation — fires when child run reaches terminal state.
            // The propagation result supersedes the child's local-stop signal:
            // 'handled' means the parent absorbed the outcome non-terminally,
            // 'stopped' means the parent also terminated.
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
                  // Parent RETRY/CONTINUE absorbs the child's stop.
                  shouldExitWithError = false;
                } else if (propagationResult === 'stopped') {
                  // Parent also terminated (e.g. RETRY exhausted).
                  shouldExitWithError = true;
                }
                // 'not-applicable' leaves the local signal unchanged.
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
