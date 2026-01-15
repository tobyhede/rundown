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
  evaluatePassCondition,
  evaluateFailCondition,
} from '@rundown/core';

/**
 * Check if workflow snapshot indicates completion.
 * @param snapshot - XState snapshot with status and value
 * @returns True if the workflow has completed successfully
 */
export function isWorkflowComplete(snapshot: { status: string; value: unknown }): boolean {
  return snapshot.status === 'done' && snapshot.value === 'COMPLETE';
}

/**
 * Check if workflow snapshot indicates stopped state.
 * @param snapshot - XState snapshot with status and value
 * @returns True if the workflow has been stopped
 */
export function isWorkflowStopped(snapshot: { status: string; value: unknown }): boolean {
  return snapshot.status === 'done' && snapshot.value === 'STOPPED';
}

/**
 * Handle dynamic instance and substep advancement via NEXT flags.
 *
 * When a transition sets nextInstance or nextSubstepInstance flags,
 * this function applies the appropriate state updates.
 *
 * @param snapshot - XState snapshot with context and flags
 * @param updatedState - Current workflow state to potentially update
 * @param manager - Workflow state manager
 * @param workflowId - ID of the workflow
 * @param steps - Array of workflow steps
 * @param isComplete - Whether the workflow is complete
 * @param isStopped - Whether the workflow is stopped
 * @returns Updated workflow state with instance/substep advancement applied
 */
export async function handleNextInstanceFlags(
  snapshot: { context: { nextInstance?: boolean; nextSubstepInstance?: boolean } },
  updatedState: WorkflowState,
  manager: WorkflowStateManager,
  workflowId: string,
  steps: Step[],
  isComplete: boolean,
  isStopped: boolean
): Promise<WorkflowState> {
  let state = updatedState;

  // Handle NEXT step action: increment instance for dynamic workflows
  const nextInstance = snapshot.context.nextInstance;
  if (nextInstance && !isComplete && !isStopped) {
    // Check if this is a dynamic workflow (has instance field set)
    if (state.instance !== undefined) {
      const currentInstance = state.instance;
      const nextInstanceNum = currentInstance + 1;
      state = await manager.update(workflowId, {
        instance: nextInstanceNum,
        substep: '1'
      });
      console.log(`Instance ${String(currentInstance)} complete. Starting instance ${String(nextInstanceNum)}...`);
    }
  }

  // Handle NEXT substep action: create new dynamic substep instance
  const nextSubstepInstance = snapshot.context.nextSubstepInstance;
  if (nextSubstepInstance && !isComplete && !isStopped) {
    // Guard: only advance if current step actually has a dynamic substep
    const currentStepDef = steps.find(s => s.name === state.step || s.isDynamic);
    const hasDynamicSubstep = currentStepDef?.substeps?.some(s => s.isDynamic);

    if (hasDynamicSubstep) {
      const currentSubstep = state.substep;
      // Use addDynamicSubstep to properly track substep states and get new ID
      const nextSubstepId = await manager.addDynamicSubstep(workflowId);
      state = await manager.update(workflowId, {
        substep: nextSubstepId
      });
      console.log(`Substep ${currentSubstep ?? '?'} complete. Starting substep ${nextSubstepId}...`);
    }
  }

  return state;
}

/**
 * Execute command steps in a loop until:
 * - Workflow completes or stops
 * - A prompt-only step is reached (no command)
 * - In prompted mode (no auto-execution)
 *
 * @param manager - Workflow state manager instance
 * @param workflowId - ID of the workflow to execute
 * @param steps - Array of workflow steps
 * @param cwd - Current working directory for command execution
 * @param prompted - Whether to run in prompted mode (no auto-execution)
 * @param agentId - Optional agent ID for agent-specific workflow stacks
 * @returns 'done' if completed, 'stopped' if stopped, 'waiting' if prompt-only step reached
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

  // Detect if this is a dynamic workflow (first step has isDynamic: true)
  // In dynamic workflows, state.step is '{N}' but state.instance tracks the current instance number
  const isDynamicWorkflow = steps.length > 0 && steps[0].isDynamic;

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    // For dynamic workflows, always use the template step (index 0)
    // For static workflows, use the step name to find index
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const currentStepIndex = isDynamicWorkflow ? 0 : steps.findIndex(s => s.name === state!.step);
    const currentStep = currentStepIndex >= 0 ? steps[currentStepIndex] : steps[0];

    // For dynamic workflows, use state.instance for display; for static, use step name
    // state.instance is set to 1 on initialization for dynamic workflows
    const displayStep = isDynamicWorkflow && state.instance !== undefined
      ? String(state.instance)   // Use instance field: 1, 2, 3, ...
      : state.step;              // Use step name: "1", "ErrorHandler", etc.

    // For dynamic workflows, display {N} as total; for static, use steps.length
    const totalSteps: number | string = isDynamicWorkflow ? '{N}' : steps.length;

    // Print step block with resolved instance number
    printStepBlock({ current: displayStep, total: totalSteps, substep: state.substep }, currentStep);

    // If CLI prompted mode, OR no command
    if (prompted || !currentStep.command) {
      return 'waiting';
    }

    // Execute command (output via stdio:inherit)
    printCommandExec(currentStep.command.code);
    const execResult = await executeCommand(currentStep.command.code, cwd);

    // Store result
    const lastResult = execResult.success ? 'pass' : 'fail';
    await manager.setLastResult(workflowId, lastResult);

    // Capture prev state BEFORE mutation
    const prevStep = state.step;
    const prevInstance = state.instance;
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

    // Handle NEXT instance/substep flags
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    updatedState = await handleNextInstanceFlags(snapshot, updatedState, manager, workflowId, steps, isComplete, isStopped);

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

    // Compute prev display step (for action block output)
    const prevDisplayStep = isDynamicWorkflow && prevInstance !== undefined
      ? String(prevInstance)   // Use instance field: 1, 2, 3, ...
      : prevStep;              // Use step name: "1", "ErrorHandler", etc.

    // Print separator and action block
    printSeparator();
    printActionBlock({
      action,
      from: { current: prevDisplayStep, total: totalSteps, substep: prevSubstep },
      result: execResult.success ? 'PASS' : 'FAIL',
    });

    // Handle workflow end states
    if (isComplete) {
      // Extract message from the transition that led to completion
      const completionMessage = lastResult === 'pass'
        ? evaluatePassCondition(currentStep).message
        : evaluateFailCondition(currentStep, prevRetryCount).message;
      await manager.update(workflowId, { variables: { ...updatedState.variables, completed: true } });
      printWorkflowComplete(completionMessage);

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
      // Extract message from the transition that led to stop
      const stopMessage = lastResult === 'pass'
        ? evaluatePassCondition(currentStep).message
        : evaluateFailCondition(currentStep, prevRetryCount).message;
      await manager.update(workflowId, { variables: { ...updatedState.variables, stopped: true } });
      printWorkflowStoppedAtStep({ current: prevDisplayStep, total: totalSteps, substep: prevSubstep }, stopMessage);

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
 * Check if value is a valid result ('pass' | 'fail').
 *
 * When no explicit result sequence is provided to test commands,
 * the default sequence ['pass'] is used. This means steps pass on the first attempt.
 * Users can override this with --result flags to customize the sequence.
 * @param r - String value to check
 * @returns True if the value is 'pass' or 'fail'
 */
export function isValidResult(r: string): r is 'pass' | 'fail' {
  return r === 'pass' || r === 'fail';
}

/**
 * Get retry max for a step.
 * @param step - Workflow step to get retry max from
 * @returns Maximum number of retries, or 0 if no retry configured
 */
export function getStepRetryMax(step: Step): number {
  // eslint-disable-next-line @typescript-eslint/prefer-optional-chain, @typescript-eslint/no-unnecessary-condition
  if (step.transitions && step.transitions.fail && step.transitions.fail.action.type === 'RETRY') {
    return step.transitions.fail.action.max;
  }
  return 0; // No retry configured
}

/**
 * Build metadata object for output.
 * @param state - Current workflow state
 * @returns Metadata object for CLI output
 */
export function buildMetadata(state: WorkflowState): WorkflowMetadata {
  return {
    file: state.workflow,
    state: `.claude/rundown/runs/${state.id}.json`,
    prompted: state.prompted ?? undefined,
  };
}

/**
 * Derive action string from state transition.
 * @param prevStep - Previous step name
 * @param newStep - New step name after transition
 * @param prevSubstep - Previous substep ID
 * @param newSubstep - New substep ID after transition
 * @param prevRetryCount - Previous retry count
 * @param newRetryCount - New retry count after transition
 * @param retryMax - Maximum retries allowed for the step
 * @param isComplete - Whether the workflow is complete
 * @param isStopped - Whether the workflow is stopped
 * @returns Action string describing the transition (e.g., 'CONTINUE', 'GOTO 3', 'RETRY (1/3)')
 */
export function deriveAction(
  prevStep: string,
  newStep: string,
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
  // Even "sequential" step changes are GOTO if substep is specified
  // Because GOTO step_2.1 is meaningfully different from CONTINUE to step_2
  if (newSubstep) {
    return `GOTO ${newStep}.${newSubstep}`;
  }

  // Check if step change is sequential (e.g., "1" → "2")
  // Sequential means: both are numeric strings and newStep = prevStep + 1
  if (newStep !== prevStep) {
    const prevNum = parseInt(prevStep, 10);
    const newNum = parseInt(newStep, 10);
    const isSequential = !isNaN(prevNum) && !isNaN(newNum) && newNum === prevNum + 1;
    if (!isSequential) {
      return `GOTO ${newStep}`;
    }
  }

  // Sequential step change or same step = CONTINUE
  return 'CONTINUE';
}
