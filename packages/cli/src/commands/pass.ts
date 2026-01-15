// packages/cli/src/commands/pass.ts

import * as fs from 'fs/promises';
import type { Command } from 'commander';
import {
  WorkflowStateManager,
  parseWorkflow,
  printSeparator,
  printActionBlock,
  printWorkflowComplete,
  printWorkflowStoppedAtStep,
  evaluatePassCondition,
} from '@rundown/core';
import { resolveWorkflowFile } from '../helpers/resolve-workflow.js';
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
 * Registers the 'pass' command for marking steps as passed.
 * @param program - Commander program instance to register the command on
 */
import {
  handleNextInstanceFlags,
} from '../services/execution.js';

export function registerPassCommand(program: Command): void {
  program
    .command('pass')
    .aliases(['yes', 'ok'])
    .description('Mark current step as passed (triggers PASS transition)')
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
        const workflowPath = await resolveWorkflowFile(cwd, state.workflow);
        if (!workflowPath) {
          throw new Error(`Workflow file ${state.workflow} not found`);
        }
        const content = await fs.readFile(workflowPath, 'utf8');
        const steps = parseWorkflow(content);
        const actor = await manager.createActor(state.id, steps);
        if (!actor) {
          throw new Error('Failed to initialize workflow engine');
        }

        // Handle agent binding completion (substep case)
        // Only applies when parent workflow has an agent binding - not for standalone agent workflows
        if (options.agent) {
          const binding = await manager.getAgentBinding(state.id, options.agent);
          if (binding) {
            // Agent binding exists - handle substep completion
            let result: 'pass' | 'fail' = 'pass';

            if (binding.childWorkflowId) {
              const childResult = await manager.getChildWorkflowResult(binding.childWorkflowId);
              if (childResult === null) {
                throw new Error(`Child workflow still active. Complete or stop it first.\nChild workflow: ${binding.childWorkflowId}`);
              }
              result = childResult;
            }

            await manager.updateAgentBinding(state.id, options.agent, {
              status: 'done',
              result
            });
            console.log(`Agent ${options.agent} marked as pass`);

            const updated = await manager.load(state.id);
            const bindings = Object.values(updated?.agentBindings ?? {});
            const runningCount = bindings.filter((b) => b.status === 'running').length;

            if (runningCount > 0) {
              console.log(`${String(runningCount)} agent(s) still running`);
            } else {
              console.log('All agents complete');
            }
            return;
          }
          // No binding - this is a standalone workflow in agent's stack
          // Continue to main pass flow below
        }

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

        // Send PASS event
        actor.send({ type: 'PASS' });

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
        const prevStepIndex = steps.findIndex(s => s.name === prevStep);
        const currentStep = prevStepIndex >= 0 ? steps[prevStepIndex] : steps[0];
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
          result: 'PASS',
        });

        // Evaluate pass condition once for use in completion/stopped blocks
        const passResult = evaluatePassCondition(currentStep);

        // Handle completion
        if (isComplete) {
          await manager.update(state.id, {
            step: steps[steps.length - 1].name,
            variables: { ...state.variables, completed: true }
          });
          printWorkflowComplete(passResult.message);

          // If this was a child workflow with agent, update parent's agent binding
          if (options.agent && state.parentWorkflowId) {
            await manager.updateAgentBinding(state.parentWorkflowId, options.agent, {
              status: 'done',
              result: 'pass'
            });
          }

          // Pop current workflow, returns parent ID or null
          await manager.popWorkflow(options.agent);
          return;
        }

        if (isStopped) {
          await manager.update(state.id, { variables: { ...state.variables, stopped: true } });
          printWorkflowStoppedAtStep({ current: displayStep, total: totalSteps, substep: prevSubstep }, passResult.message);
          process.exit(1);
        }

        // Continue with execution loop
        const loopResult = await runExecutionLoop(manager, state.id, steps, cwd, !!state.prompted, options.agent);
        if (loopResult === 'stopped') {
          process.exit(1);
        }
      });
    });
}
