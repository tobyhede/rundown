// packages/cli/src/services/execution.ts

import {
  type WorkflowStateManager,
  printActionBlock,
  printStepBlock,
  printSeparator,
  printCommandExec,
  printWorkflowComplete,
  printWorkflowStoppedAtStep,
  type Step,
  type WorkflowMetadata,
  type WorkflowState,
  executeCommand,
  createStepNumber,
} from '@rundown/core';

/**
 * Check if workflow snapshot indicates completion
 */
export function isWorkflowComplete(snapshot: { status: string; value: unknown }): boolean {
  return snapshot.status === 'done' && snapshot.value === 'COMPLETE';
}

/**
 * Check if workflow snapshot indicates stopped state
 */
export function isWorkflowStopped(snapshot: { status: string; value: unknown }): boolean {
  return snapshot.status === 'done' && snapshot.value === 'STOPPED';
}

/**
 * Execute command steps in a loop until:
 * - Workflow completes or stops
 * - A prompt-only step is reached (no command)
 * - In prompted mode (no auto-execution)
 *
 * @returns 'done' | 'stopped' | 'waiting' (waiting = prompt-only step reached)
 */
export async function runExecutionLoop(
  manager: WorkflowStateManager,
  workflowId: string,
  steps: Step[],
  cwd: string,
  prompted: boolean,
  agentId?: string
): Promise<'done' | 'stopped' | 'waiting'> {
  // Note: state is loaded here and reloaded at end of each loop iteration.
  // Some immutable properties (parentWorkflowId, agentId) are accessed from
  // the initial load for completion handling. This is safe because these
  // properties are set at workflow creation and never modified.
  let state = await manager.load(workflowId);
  if (!state) return 'stopped';

  // Detect if this is a dynamic workflow (single step with isDynamic: true)
  // In dynamic workflows, steps array has only the template step, but state.step is the instance number
  const isDynamicWorkflow = steps.length === 1 && steps[0].isDynamic;

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    // For dynamic workflows, always use the template step (index 0)
    // For static workflows, use the step number as index
    const currentStep = isDynamicWorkflow ? steps[0] : steps[state.step - 1];
    const totalSteps = isDynamicWorkflow ? state.step : steps.length;

    // Print step block
    printStepBlock({ current: state.step, total: totalSteps, substep: state.substep }, currentStep);

    // If CLI prompted mode, OR no command, OR command is marked as prompted (```prompt blocks)
    if (prompted || !currentStep.command || currentStep.command.prompted) {
      return 'waiting';
    }

    // Execute command (output via stdio:inherit)
    printCommandExec(currentStep.command.code);
    const execResult = await executeCommand(currentStep.command.code, cwd);

    // Store result
    await manager.setLastResult(workflowId, execResult.success ? 'pass' : 'fail');

    // Capture prev state BEFORE mutation
    const prevStep = state.step;
    const prevSubstep = state.substep;
    const prevRetryCount = state.retryCount;

    // Send event to actor
    const actor = await manager.createActor(workflowId, steps);
    if (!actor) return 'stopped';

    actor.send({ type: execResult.success ? 'PASS' : 'FAIL' });
    let updatedState = await manager.updateFromActor(workflowId, actor, steps);

    // XState snapshot type is not fully typed
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
    const snapshot = actor.getPersistedSnapshot() as any;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const isComplete = isWorkflowComplete(snapshot);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const isStopped = isWorkflowStopped(snapshot);

    // Handle NEXT action: increment instance number for dynamic steps
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const nextInstance = snapshot.context.nextInstance as boolean | undefined;
    if (nextInstance && !isComplete && !isStopped) {
      // Increment instance number (stay in step_1 for dynamic workflows)
      const currentInstanceNum = updatedState.step;
      const nextStepNumberValue = currentInstanceNum + 1;
      const nextStepNumber = createStepNumber(nextStepNumberValue);
      if (nextStepNumber) {
        updatedState = await manager.update(workflowId, {
          step: nextStepNumber,
          substep: '1'
        });
        console.log(`Instance ${String(currentInstanceNum)} complete. Starting instance ${String(nextStepNumberValue)}...`);
      }
      // Continue loop to process next instance
    }

    // Derive action string
    const retryMax = getStepRetryMax(currentStep);
    const action = deriveAction(
      prevStep,
      updatedState.step,
      prevSubstep,
      updatedState.substep,
      prevRetryCount,
      updatedState.retryCount,
      retryMax,
      isComplete,
      isStopped
    );

    // Update lastAction in state
    const actionType = action.startsWith('GOTO') ? 'GOTO' :
                       action.startsWith('RETRY') ? 'RETRY' :
                       action as 'CONTINUE' | 'COMPLETE' | 'STOP';
    await manager.update(workflowId, { lastAction: actionType });

    // Print separator and action block
    printSeparator();
    printActionBlock({
      action,
      from: { current: prevStep, total: totalSteps, substep: prevSubstep },
      result: execResult.success ? 'PASS' : 'FAIL',
    });

    // Handle workflow end states
    if (isComplete) {
      await manager.update(workflowId, { variables: { ...updatedState.variables, completed: true } });
      printWorkflowComplete();

      // If this was a child workflow with agent, update parent's agent binding
      if (agentId && state.parentWorkflowId) {
        await manager.updateAgentBinding(state.parentWorkflowId, agentId, {
          status: 'done',
          result: 'pass'
        });
      }

      // Pop current workflow from stack (makes parent active if exists, or clears stack)
      await manager.popWorkflow(agentId);
      return 'done';
    }

    if (isStopped) {
      await manager.update(workflowId, { variables: { ...updatedState.variables, stopped: true } });
      printWorkflowStoppedAtStep({ current: prevStep, total: totalSteps, substep: prevSubstep });

      // If this was a child workflow with agent, update parent's agent binding
      if (agentId && state.parentWorkflowId) {
        await manager.updateAgentBinding(state.parentWorkflowId, agentId, {
          status: 'done',
          result: 'fail'
        });
      }

      // Pop current workflow from stack
      await manager.popWorkflow(agentId);
      return 'stopped';
    }

    // Reload state for next iteration
    state = await manager.load(workflowId);
    if (!state) return 'stopped';
  }
}

/**
 * Check if value is a valid result ('pass' | 'fail')
 *
 * When no explicit result sequence is provided to test commands,
 * the default sequence ['pass'] is used. This means steps pass on the first attempt.
 * Users can override this with --result flags to customize the sequence.
 */
export function isValidResult(r: string): r is 'pass' | 'fail' {
  return r === 'pass' || r === 'fail';
}

/**
 * Get retry max for a step
 */
export function getStepRetryMax(step: Step): number {
  // eslint-disable-next-line @typescript-eslint/prefer-optional-chain, @typescript-eslint/no-unnecessary-condition
  if (step.transitions && step.transitions.fail && step.transitions.fail.action.type === 'RETRY') {
    return step.transitions.fail.action.max;
  }
  return 0; // No retry configured
}

/**
 * Build metadata object for output
 */
export function buildMetadata(state: WorkflowState): WorkflowMetadata {
  return {
    file: state.workflow,
    state: `.claude/rundown/runs/${state.id}.json`,
    prompted: state.prompted ?? undefined,
  };
}

/**
 * Derive action string from state transition
 */
export function deriveAction(
  prevStep: number,
  newStep: number,
  prevSubstep: string | undefined,
  newSubstep: string | undefined,
  prevRetryCount: number,
  newRetryCount: number,
  retryMax: number,
  isComplete: boolean,
  isStopped: boolean
): string {
  if (isComplete) return 'COMPLETE';
  if (isStopped) return 'STOP';
  if (newStep === prevStep && newRetryCount > prevRetryCount) {
    return `RETRY (${String(newRetryCount)}/${String(retryMax)})`;
  }

  // CRITICAL FIX: Any transition with a substep target is a GOTO
  // Even "sequential" step changes (1 → 2) are GOTO if substep is specified
  // Because GOTO 2.1 is meaningfully different from CONTINUE to step 2
  if (newSubstep) {
    return `GOTO ${String(newStep)}.${newSubstep}`;
  }

  // Non-sequential step change without substep
  if (newStep !== prevStep + 1 && newStep !== prevStep) {
    return `GOTO ${String(newStep)}`;
  }

  // Substep cleared (had substep, now doesn't) on same step = unusual, treat as CONTINUE
  // Sequential step change without substep = CONTINUE
  return 'CONTINUE';
}
