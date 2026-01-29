// packages/cli/src/commands/fail.ts

import type { Command } from 'commander';
import { evaluateFailCondition, type Step, type RunbookState } from '@rundown-org/core';
import { getCwd } from '../helpers/context.js';
import { runExecutionLoop } from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { createBridgedEmitter } from '../helpers/execution-emitter.js';
import {
  buildTransitionContext,
  executeTransition,
  type TransitionContext,
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
      await withErrorHandling(async () => {
        const output = new OutputEmitter({ json: options.json });
        const cwd = getCwd();
        const ctx = await buildTransitionContext(output, cwd, options.agent);

        if (!ctx) {
          output.noActiveRunbook('fail');
          output.flush();
          return;
        }

        // Handle agent binding completion (substep case) - REUSE evaluateFailCondition
        // Only applies when parent runbook has an agent binding - not for standalone agent runbooks
        if (options.agent) {
          const handled = await handleFailAgentBinding(ctx, options.agent);
          if (handled) return;
        }

        await executeTransition(ctx, {
          eventType: 'FAIL',
          commandName: 'fail',
          lastResult: 'fail',
          computeActionResult: () => false, // Always false for fail
          evaluateCondition: (step: Step, prevState: RunbookState) => evaluateFailCondition(step, prevState.retryCount),
          terminalOrder: 'stopped-first',
          onStopped: { popRunbook: true, updateParentBinding: true },
          onComplete: { popRunbook: true, updateParentBinding: true },
        });
      }, { json: options.json });
    });
}

/**
 * Handle fail-specific agent binding completion.
 *
 * Evaluates retry/goto conditions before marking agent binding.
 * If retry or goto is triggered, continues execution instead of marking as fail.
 *
 * @param ctx - Transition context
 * @param agentId - Agent ID to check binding for
 * @returns True if agent binding was handled, false to continue to main flow
 */
async function handleFailAgentBinding(ctx: TransitionContext, agentId: string): Promise<boolean> {
  const { output, manager, state, steps, actor, cwd } = ctx;
  const binding = await manager.getAgentBinding(state.id, agentId);

  if (!binding) {
    // No binding - this is a standalone runbook in agent's stack
    // Continue to main fail flow
    return false;
  }

  // Agent binding exists - handle substep fail
  // Evaluate fail condition for the agent's step (preserves RETRY/GOTO behavior)
  const stepName = binding.stepId.step;
  const stepIndex = steps.findIndex(s => s.name === stepName);
  const agentStep = stepIndex >= 0 ? steps[stepIndex] : steps[0];
  const failResult = evaluateFailCondition(agentStep, state.retryCount);

  if (failResult.action === 'retry') {
    actor.send({ type: 'FAIL' });
    const retryState = await manager.updateFromActor(state.id, actor, steps);
    output.status(true, 'retry', `Agent ${agentId} retrying step ${stepName}`, {
      agent: agentId,
      step: stepName
    });
    // Continue with execution loop for retry
    const retryEmitter = createBridgedEmitter(retryState, output);
    const loopResult = await runExecutionLoop(manager, state.id, steps, cwd, !!state.prompted, agentId, retryEmitter);
    output.flush();
    if (loopResult === 'stopped') process.exit(1);
    return true;
  } else if (failResult.action === 'goto') {
    actor.send({ type: 'FAIL' });
    const gotoState = await manager.updateFromActor(state.id, actor, steps);
    output.status(true, 'goto', `Agent ${agentId} failed, runbook jumped to step ${gotoState.step}`, {
      agent: agentId,
      step: gotoState.step
    });
    // Continue with execution loop after GOTO
    const gotoEmitter = createBridgedEmitter(gotoState, output);
    const loopResult = await runExecutionLoop(manager, state.id, steps, cwd, !!state.prompted, agentId, gotoEmitter);
    output.flush();
    if (loopResult === 'stopped') process.exit(1);
    return true;
  }

  // Only mark binding as fail if no retry/goto triggered
  await manager.updateAgentBinding(state.id, agentId, {
    status: 'done',
    result: 'fail'
  });

  const updated = await manager.load(state.id);
  const bindings = Object.values(updated?.agentBindings ?? {});
  const runningCount = bindings.filter((b: { status: string }) => b.status === 'running').length;

  const statusMessage = runningCount > 0
    ? `Agent ${agentId} marked as fail (${String(runningCount)} agent(s) still running)`
    : `Agent ${agentId} marked as fail (All agents complete)`;

  output.status(false, 'agent_failed', statusMessage, {
    agent: agentId,
    result: 'fail',
    agentsRunning: runningCount,
    allComplete: runningCount === 0
  });
  output.flush();
  return true;
}
