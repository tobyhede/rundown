// packages/cli/src/commands/pass.ts

import type { Command } from 'commander';
import { evaluatePassCondition, type Step, type RunbookState } from '@rundown-org/core';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import {
  buildTransitionContext,
  executeTransition,
  type TransitionContext,
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
          const handled = await handlePassAgentBinding(ctx, options.agent);
          if (handled) return;
        }

        await executeTransition(ctx, {
          eventType: 'PASS',
          commandName: 'pass',
          lastResult: 'pass',
          computeActionResult: (actionType: ActionType) => actionType !== 'RETRY' && actionType !== 'STOP',
          evaluateCondition: (step: Step, _prevState: RunbookState) => evaluatePassCondition(step),
          terminalOrder: 'complete-first',
          onStopped: { popRunbook: false, updateParentBinding: false },
          onComplete: { popRunbook: true, updateParentBinding: true },
        });
      }, { json: options.json });
    });
}

/**
 * Handle pass-specific agent binding completion.
 *
 * Checks child runbook result before marking agent as done.
 *
 * @param ctx - Transition context
 * @param agentId - Agent ID to check binding for
 * @returns True if agent binding was handled, false to continue to main flow
 */
async function handlePassAgentBinding(ctx: TransitionContext, agentId: string): Promise<boolean> {
  const { output, manager, state } = ctx;
  const binding = await manager.getAgentBinding(state.id, agentId);

  if (!binding) {
    // No binding - this is a standalone runbook in agent's stack
    // Continue to main pass flow
    return false;
  }

  // Agent binding exists - handle substep completion
  let result: 'pass' | 'fail' = 'pass';

  if (binding.childRunbookId) {
    const childResult = await manager.getChildRunbookResult(binding.childRunbookId);
    if (childResult === null) {
      throw new Error(`Child runbook still active. Complete or stop it first.\nChild runbook: ${binding.childRunbookId}`);
    }
    result = childResult;
  }

  await manager.updateAgentBinding(state.id, agentId, {
    status: 'done',
    result
  });

  const updated = await manager.load(state.id);
  const bindings = Object.values(updated?.agentBindings ?? {});
  const runningCount = bindings.filter((b) => b.status === 'running').length;

  const statusMessage = runningCount > 0
    ? `Agent ${agentId} marked as pass (${String(runningCount)} agent(s) still running)`
    : `Agent ${agentId} marked as pass (All agents complete)`;

  output.status(true, 'agent_completed', statusMessage, {
    agent: agentId,
    result,
    agentsRunning: runningCount
  });
  output.flush();
  return true;
}
