// packages/cli/src/commands/pass.ts

import type { Command } from 'commander';
import { evaluatePassCondition, type Step, type RunbookState } from '@rundown-org/core';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import {
  buildTransitionContext,
  executeTransition,
  handleAgentBinding,
  type ActionType,
} from '../helpers/transitions.js';

/**
 * Registers the 'pass' command for marking steps as passed.
 * @param program - Commander program instance to register the command on
 */
export function registerPassCommand(program: Command): void {
  program
    .command('pass')
    .aliases(['yes', 'ok'])
    .description('Mark current step as passed (triggers PASS transition)')
    .option('--agent <agentId>', 'Specify agent completing step')
    .option('--json', 'Output as JSON')
    .action(async (options: { agent?: string; json?: boolean }) => {
      await withErrorHandling(async () => {
        const output = new OutputEmitter({ json: options.json });
        const cwd = getCwd();
        const ctx = await buildTransitionContext(output, cwd, options.agent);

        if (!ctx) {
          output.noActiveRunbook('pass');
          output.flush();
          return;
        }

        // Handle agent binding completion (substep case)
        // Only applies when parent runbook has an agent binding - not for standalone agent runbooks
        if (options.agent) {
          const config = {
            eventType: 'PASS' as const,
            commandName: 'pass' as const,
            lastResult: 'pass' as const,
            computeActionResult: (actionType: ActionType) => actionType !== 'RETRY' && actionType !== 'STOP',
            evaluateCondition: (step: Step, prevState: RunbookState) => evaluatePassCondition(step, prevState.retryCount),
            terminalOrder: 'complete-first' as const,
            onStopped: { popRunbook: false, updateParentBinding: false },
            onComplete: { popRunbook: true, updateParentBinding: true },
          };
          const handled = await handleAgentBinding(ctx, options.agent, config);
          if (handled) return;
        }

        await executeTransition(ctx, {
          eventType: 'PASS',
          commandName: 'pass',
          lastResult: 'pass',
          computeActionResult: (actionType: ActionType) => actionType !== 'RETRY' && actionType !== 'STOP',
          evaluateCondition: (step: Step, prevState: RunbookState) => evaluatePassCondition(step, prevState.retryCount),
          terminalOrder: 'complete-first',
          onStopped: { popRunbook: false, updateParentBinding: false },
          onComplete: { popRunbook: true, updateParentBinding: true },
        });
      }, { json: options.json });
    });
}
