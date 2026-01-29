// packages/cli/src/commands/fail.ts

import * as fs from 'fs/promises';
import type { Command } from 'commander';
import {
  RunbookStateManager,
  parseRunbook,
  evaluateFailCondition,
  countNumberedSteps,
} from '@rundown-org/core';
import { resolveRunbookFile } from '../helpers/resolve-runbook.js';
import { getCwd } from '../helpers/context.js';
import {
  runExecutionLoop,
  formatActionForDisplay,
  extractLastAction,
  extractRetryMax,
  isRunbookComplete,
  isRunbookStopped,
  handleNextInstanceFlags,
} from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { createBridgedEmitter } from '../helpers/execution-emitter.js';

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
        const manager = new RunbookStateManager(cwd);
        let state = await manager.getActive(options.agent);

        // If agent specified but no runbook in agent's stack, check default stack for binding
        if (!state && options.agent) {
          const parentState = await manager.getActive(); // Default stack
          if (parentState) {
            const binding = await manager.getAgentBinding(parentState.id, options.agent);
            if (binding) {
              // Agent has binding on parent but no child runbook - operate on parent
              state = parentState;
            }
          }
        }

        if (!state) {
          output.noActiveRunbook('fail');
          output.flush();
          return;
        }
        const runbookPath = await resolveRunbookFile(cwd, state.runbook);
        if (!runbookPath) {
          throw new Error(`Runbook file ${state.runbook} not found`);
        }
        const content = await fs.readFile(runbookPath, 'utf8');
        const steps = parseRunbook(content);
        const currentStepIndex = steps.findIndex(s => s.name === state.step);
        const currentStep = currentStepIndex >= 0 ? steps[currentStepIndex] : steps[0];
        const actor = await manager.createActor(state.id, steps);
        if (!actor) {
          throw new Error('Failed to initialize runbook engine');
        }

        // Handle agent binding completion (substep case) - REUSE evaluateFailCondition
        // Only applies when parent runbook has an agent binding - not for standalone agent runbooks
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
              const retryState = await manager.updateFromActor(state.id, actor, steps);
              output.status(true, 'retry', `Agent ${options.agent} retrying step ${stepName}`, {
                agent: options.agent,
                step: stepName
              });
              // Continue with execution loop for retry
              const retryEmitter = createBridgedEmitter(retryState, output);
              const loopResult = await runExecutionLoop(manager, state.id, steps, cwd, !!state.prompted, options.agent, retryEmitter);
              output.flush();
              if (loopResult === 'stopped') process.exit(1);
              return;
            } else if (failResult.action === 'goto') {
              actor.send({ type: 'FAIL' });
              const gotoState = await manager.updateFromActor(state.id, actor, steps);
              output.status(true, 'goto', `Agent ${options.agent} failed, runbook jumped to step ${gotoState.step}`, {
                agent: options.agent,
                step: gotoState.step
              });
              // Continue with execution loop after GOTO
              const gotoEmitter = createBridgedEmitter(gotoState, output);
              const loopResult = await runExecutionLoop(manager, state.id, steps, cwd, !!state.prompted, options.agent, gotoEmitter);
              output.flush();
              if (loopResult === 'stopped') process.exit(1);
              return;
            }

            // Only mark binding as fail if no retry/goto triggered
            await manager.updateAgentBinding(state.id, options.agent, {
              status: 'done',
              result: 'fail'
            });

            const updated = await manager.load(state.id);
            const bindings = Object.values(updated?.agentBindings ?? {});
            const runningCount = bindings.filter((b: { status: string }) => b.status === 'running').length;

            const statusMessage = runningCount > 0
              ? `Agent ${options.agent} marked as fail (${String(runningCount)} agent(s) still running)`
              : `Agent ${options.agent} marked as fail (All agents complete)`;

            output.status(false, 'agent_failed', statusMessage, {
              agent: options.agent,
              result: 'fail',
              agentsRunning: runningCount,
              allComplete: runningCount === 0
            });
            output.flush();
            return;
          }
          // No binding - this is a standalone runbook in agent's stack
          // Continue to main fail flow below
        }

        // Main step fail - send FAIL event to actor
        // Capture prev state BEFORE mutation
        const prevSubstep = state.substep;
        const isDynamic = steps.length > 0 && steps[0].isDynamic;
        // '{N}' indicates dynamic runbook with unbounded iterations
        const totalSteps: number | string = isDynamic ? '{N}' : countNumberedSteps(steps);
        // Use state.instance for dynamic runbooks
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
        const isComplete = isRunbookComplete(snapshot);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        const isStopped = isRunbookStopped(snapshot);

        // Handle NEXT instance/substep flags
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        updatedState = await handleNextInstanceFlags(snapshot, updatedState, manager, state.id, steps, isComplete, isStopped);

        // Read action from XState context (source of truth for retryMax and lastAction)
        const retryMax = extractRetryMax(snapshot);
        const lastActionFromContext = extractLastAction(snapshot);
        // Compute substep instance for {n} resolution
        const substepInstance = updatedState.substep
          ? (updatedState.substep === '{n}'
              ? (updatedState.substepStates?.length ?? 1)
              : parseInt(updatedState.substep, 10) || undefined)
          : undefined;
        const action = formatActionForDisplay(
          lastActionFromContext,
          updatedState.retryCount,
          retryMax,
          updatedState.instance,
          substepInstance
        );

        // Update lastAction and lastResult
        let actionType: 'GOTO' | 'RETRY' | 'CONTINUE' | 'COMPLETE' | 'STOP';
        if (action.startsWith('GOTO')) {
          actionType = 'GOTO';
        } else if (action.startsWith('RETRY')) {
          actionType = 'RETRY';
        } else {
          actionType = action as 'CONTINUE' | 'COMPLETE' | 'STOP';
        }
        // Fail always results in lastResult='fail' since it's a failure action
        await manager.update(state.id, { lastAction: actionType, lastResult: 'fail' });

        // Resolve {n} in prev substep for display
        const prevSubstepStatesLen = state.substepStates?.length ?? 1;
        const prevDisplaySubstep = prevSubstep === '{n}'
          ? String(prevSubstepStatesLen)
          : prevSubstep;

        // Compute new display step (position after transition)
        const newDisplayStep = isDynamic && updatedState.instance !== undefined
          ? String(updatedState.instance)
          : updatedState.step;

        // Resolve {n} in new substep for display
        const newDisplaySubstep = updatedState.substep === '{n}'
          ? String(updatedState.substepStates?.length ?? 1)
          : updatedState.substep;

        // Compute positions for output
        const prevPos = { current: displayStep, total: totalSteps, substep: prevDisplaySubstep };
        const newPos = { current: newDisplayStep, total: totalSteps, substep: newDisplaySubstep };

        // Emit action block
        output.action({
          action,
          from: prevPos,
          result: false,
          at: newPos,
        });

        // Evaluate fail condition once to get message
        // Use state.retryCount (pre-transition value) to correctly determine message
        const failResult = evaluateFailCondition(currentStep, state.retryCount);

        // Handle stopped
        if (isStopped) {
          await manager.update(state.id, { variables: { ...state.variables, stopped: true } });

          output.stopped(failResult.message, prevPos);
          output.flush();

          // If this was a child runbook with agent, update parent's agent binding
          if (options.agent && state.parentRunbookId) {
            await manager.updateAgentBinding(state.parentRunbookId, options.agent, {
              status: 'done',
              result: 'fail'
            });
          }

          await manager.popRunbook(options.agent);
          process.exit(1);
        }

        // Handle completion (rare for fail, but possible with GOTO to end)
        if (isComplete) {
          await manager.update(state.id, {
            step: steps[steps.length - 1].name,
            variables: { ...state.variables, completed: true }
          });
          
          output.complete(failResult.message, newPos);
          output.flush();

          // If this was a child runbook with agent, update parent's agent binding
          if (options.agent && state.parentRunbookId) {
            await manager.updateAgentBinding(state.parentRunbookId, options.agent, {
              status: 'done',
              result: 'fail'
            });
          }

          await manager.popRunbook(options.agent);
          return;
        }

        // Create emitter bridged to unified output
        const emitter = createBridgedEmitter(updatedState, output);

        const loopResult = await runExecutionLoop(manager, state.id, steps, cwd, !!state.prompted, options.agent, emitter);

        // Flush any remaining output
        output.flush();

        if (loopResult === 'stopped') {
          process.exit(1);
        }
      }, { json: options.json });
    });
}