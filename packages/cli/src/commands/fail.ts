// packages/cli/src/commands/fail.ts

import * as fs from 'fs/promises';
import type { Command } from 'commander';
import {
  WorkflowStateManager,
  parseWorkflow,
  evaluateFailCondition,
  printSeparator,
  printActionBlock,
  printWorkflowComplete,
  printWorkflowStoppedAtStep,
} from '@rundown/core';
import { resolveRunbookFile } from '../helpers/resolve-runbook.js';
import { getCwd } from '../helpers/context.js';
import {
  runExecutionLoop,
  deriveAction,
  getStepRetryMax,
  isWorkflowComplete,
  isWorkflowStopped,
} from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';

/**
 * Registers the 'fail' command for marking steps as failed.
 * @param program - Commander program instance to register the command on
 */
import {
  handleNextInstanceFlags,
} from '../services/execution.js';

export function registerFailCommand(program: Command): void {
  program
    .command('fail')
    .alias('no')
    .description('Mark current step as failed (triggers FAIL transition)')
    .option('--agent <agentId>', 'Specify agent completing step')
    .action(async (options: { agent?: string }) => {
      await withErrorHandling(async () => {
        const cwd = getCwd();
        const manager = new WorkflowStateManager(cwd);
        let state = await manager.getActive(options.agent);

        // If agent specified but no workflow in agent's stack, check default stack for binding
        if (!state && options.agent) {
          const parentState = await manager.getActive(); // Default stack
          if (parentState) {
            const binding = await manager.getAgentBinding(parentState.id, options.agent);
            if (binding) {
              // Agent has binding on parent but no child workflow - operate on parent
              state = parentState;
            }
          }
        }

              if (!state) {
                console.log('No active runbook');
                return;
              }
        const workflowPath = await resolveRunbookFile(cwd, state.workflow);
        if (!workflowPath) {
          throw new Error(`Workflow file ${state.workflow} not found`);
        }
        const content = await fs.readFile(workflowPath, 'utf8');
        const steps = parseWorkflow(content);
        const currentStepIndex = steps.findIndex(s => s.name === state.step);
        const currentStep = currentStepIndex >= 0 ? steps[currentStepIndex] : steps[0];
        const actor = await manager.createActor(state.id, steps);
        if (!actor) {
          throw new Error('Failed to initialize workflow engine');
        }

        // Handle agent binding completion (substep case) - REUSE evaluateFailCondition
        // Only applies when parent workflow has an agent binding - not for standalone agent workflows
        if (options.agent) {
          const binding = await manager.getAgentBinding(state.id, options.agent);
          if (binding) {
            // Agent binding exists - handle substep fail
            // Evaluate fail condition for the agent's step (preserves RETRY/GOTO behavior)
            const stepName = binding.stepId.step;
            const stepIndex = steps.findIndex(s => s.name === stepName);
            const agentStep = stepIndex >= 0 ? steps[stepIndex] : steps[0];
            const failResult = evaluateFailCondition(agentStep, state.retryCount);

            if (failResult.action === 'retry') {
              actor.send({ type: 'FAIL' });
              await manager.updateFromActor(state.id, actor, steps);
              console.log(`Agent ${options.agent} retrying step ${stepName}`);
              // Continue with execution loop for retry
              const loopResult = await runExecutionLoop(manager, state.id, steps, cwd, !!state.prompted, options.agent);
              if (loopResult === 'stopped') process.exit(1);
              return;
            } else if (failResult.action === 'goto') {
              actor.send({ type: 'FAIL' });
              const updated = await manager.updateFromActor(state.id, actor, steps);
              console.log(`Agent ${options.agent} failed, workflow jumped to step ${updated.step}`);
              // Continue with execution loop after GOTO
              const loopResult = await runExecutionLoop(manager, state.id, steps, cwd, !!state.prompted, options.agent);
              if (loopResult === 'stopped') process.exit(1);
              return;
            }

            // Only mark binding as fail if no retry/goto triggered
            await manager.updateAgentBinding(state.id, options.agent, {
              status: 'done',
              result: 'fail'
            });
            console.log(`Agent ${options.agent} marked as fail`);

            const updated = await manager.load(state.id);
            const bindings = Object.values(updated?.agentBindings ?? {});
            const runningCount = bindings.filter((b: { status: string }) => b.status === 'running').length;

            if (runningCount > 0) {
              console.log(`${String(runningCount)} agent(s) still running`);
            } else {
              console.log('All agents complete');
            }
            return;
          }
          // No binding - this is a standalone workflow in agent's stack
          // Continue to main fail flow below
        }

        // Main step fail - send FAIL event to actor
        // Capture prev state BEFORE mutation
        const prevStep = state.step;
        const prevSubstep = state.substep;
        const prevRetryCount = state.retryCount;
        const isDynamic = steps.length > 0 && steps[0].isDynamic;
        // '{N}' indicates dynamic workflow with unbounded iterations
        const totalSteps: number | string = isDynamic ? '{N}' : steps.length;
        // Use state.instance for dynamic workflows
        const displayStep = isDynamic && state.instance !== undefined
          ? String(state.instance)
          : state.step;

        // Send FAIL event
        actor.send({ type: 'FAIL' });

        let updatedState = await manager.updateFromActor(state.id, actor, steps);
        // XState snapshot type is not fully typed
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
        const snapshot = actor.getPersistedSnapshot() as any;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        const isComplete = isWorkflowComplete(snapshot);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        const isStopped = isWorkflowStopped(snapshot);

        // Handle NEXT instance/substep flags
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        updatedState = await handleNextInstanceFlags(snapshot, updatedState, manager, state.id, steps, isComplete, isStopped);

        // Derive action
        const retryMax = getStepRetryMax(currentStep);
        const action = deriveAction(
          prevStep, updatedState.step,
          prevSubstep, updatedState.substep,
          prevRetryCount, updatedState.retryCount,
          retryMax, isComplete, isStopped
        );

        // Update lastAction
        let actionType: 'GOTO' | 'RETRY' | 'CONTINUE' | 'COMPLETE' | 'STOP';
        if (action.startsWith('GOTO')) {
          actionType = 'GOTO';
        } else if (action.startsWith('RETRY')) {
          actionType = 'RETRY';
        } else {
          actionType = action as 'CONTINUE' | 'COMPLETE' | 'STOP';
        }
        await manager.update(state.id, { lastAction: actionType });

        // Print separator and action block
        printSeparator();
        printActionBlock({
          action,
          from: { current: displayStep, total: totalSteps, substep: prevSubstep },
          result: 'FAIL',
        });

        // Evaluate fail condition once to get message
        const failResult = evaluateFailCondition(currentStep, prevRetryCount);

        // Handle stopped
        if (isStopped) {
          await manager.update(state.id, { variables: { ...state.variables, stopped: true } });
          printWorkflowStoppedAtStep({ current: displayStep, total: totalSteps, substep: prevSubstep }, failResult.message);

          // If this was a child workflow with agent, update parent's agent binding
          if (options.agent && state.parentWorkflowId) {
            await manager.updateAgentBinding(state.parentWorkflowId, options.agent, {
              status: 'done',
              result: 'fail'
            });
          }

          await manager.popWorkflow(options.agent);
          process.exit(1);
        }

        // Handle completion (rare for fail, but possible with GOTO to end)
        if (isComplete) {
          await manager.update(state.id, {
            step: steps[steps.length - 1].name,
            variables: { ...state.variables, completed: true }
          });
          printWorkflowComplete(failResult.message);

          // If this was a child workflow with agent, update parent's agent binding
          if (options.agent && state.parentWorkflowId) {
            await manager.updateAgentBinding(state.parentWorkflowId, options.agent, {
              status: 'done',
              result: 'fail'
            });
          }

          await manager.popWorkflow(options.agent);
          return;
        }

        // Continue with execution loop
        const loopResult = await runExecutionLoop(manager, state.id, steps, cwd, !!state.prompted, options.agent);
        if (loopResult === 'stopped') {
          process.exit(1);
        }
      });
    });
}