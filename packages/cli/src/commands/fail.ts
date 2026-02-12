// packages/cli/src/commands/fail.ts

import type { Command } from 'commander';
import { evaluateFailCondition, type Step, type RunbookState } from '@rundown-org/core';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import {
  buildTransitionContext,
  executeTransition,
  handleAgentBinding,
} from '../helpers/transitions.js';

/**
 * Registers the 'fail' command for marking steps as failed.
 * @param program - Commander program instance to register the command on
 */
export function registerFailCommand(program: Command): void {
  program
    .command('fail')
    .alias('no')
    .description('Mark current step as failed (triggers FAIL transition)')
    .option('--agent <agentId>', 'Specify agent completing step')
    .option('--json', 'Output as JSON')
    .action(async (options: { agent?: string; json?: boolean }) => {
      await withErrorHandling(
        async () => {
          const output = new OutputEmitter({ json: options.json });
          const cwd = getCwd();
          const ctx = await buildTransitionContext(output, cwd, options.agent);

          if (!ctx) {
            output.noActiveRunbook('fail');
            output.flush();
            return;
          }

          // Handle agent binding completion (substep case)
          // Only applies when parent runbook has an agent binding - not for standalone agent runbooks
          if (options.agent) {
            const config = {
              eventType: 'FAIL' as const,
              commandName: 'fail' as const,
              lastResult: 'fail' as const,
              computeActionResult: () => false, // Always false for fail
              evaluateCondition: (step: Step, prevState: RunbookState) =>
                evaluateFailCondition(step, prevState.retryCount),
              terminalOrder: 'stopped-first' as const,
              onStopped: { popRunbook: true, updateParentBinding: true },
              onComplete: { popRunbook: true, updateParentBinding: true },
            };
            const handled = await handleAgentBinding(ctx, options.agent, config);
            if (handled) return;
          }

          await executeTransition(ctx, {
            eventType: 'FAIL',
            commandName: 'fail',
            lastResult: 'fail',
            computeActionResult: () => false, // Always false for fail
            evaluateCondition: (step: Step, prevState: RunbookState) =>
              evaluateFailCondition(step, prevState.retryCount),
            terminalOrder: 'stopped-first',
            onStopped: { popRunbook: true, updateParentBinding: true },
            onComplete: { popRunbook: true, updateParentBinding: true },
          });
        },
        { json: options.json },
      );
    });
}
