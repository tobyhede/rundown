// packages/cli/src/services/execution.ts

import {
  type RunbookStateManager,
  printActionBlock,
  printStepBlock,
  printSeparator,
  printCommandExec,
  printRunbookComplete,
  printRunbookStoppedAtStep,
  type Step,
  type Substep,
  type RunbookMetadata,
  type RunbookState,
  executeCommand,
  evaluatePassCondition,
  evaluateFailCondition,
} from '@rundown/core';

/**
 * Check if runbook snapshot indicates completion.
 * @param snapshot - XState snapshot with status and value
 * @returns True if the runbook has completed successfully
 */
export function isRunbookComplete(snapshot: { status: string; value: unknown }): boolean {
  return snapshot.status === 'done' && snapshot.value === 'COMPLETE';
}

/**
 * Check if runbook snapshot indicates stopped state.
 * @param snapshot - XState snapshot with status and value
 * @returns True if the runbook has been stopped
 */
export function isRunbookStopped(snapshot: { status: string; value: unknown }): boolean {
  return snapshot.status === 'done' && snapshot.value === 'STOPPED';
}

/**
 * Handle dynamic instance and substep advancement via NEXT flags.
 *
 * When a transition sets nextInstance or nextSubstepInstance flags,
 * this function applies the appropriate state updates.
 *
 * @param snapshot - XState snapshot with context and flags
 * @param updatedState - Current runbook state to potentially update
 * @param manager - Runbook state manager
 * @param runbookId - ID of the runbook
 * @param steps - Array of runbook steps
 * @param isComplete - Whether the runbook is complete
 * @param isStopped - Whether the runbook is stopped
 * @returns Updated runbook state with instance/substep advancement applied
 */
export async function handleNextInstanceFlags(
  snapshot: { context: { nextInstance?: boolean; nextSubstepInstance?: boolean } },
  updatedState: RunbookState,
  manager: RunbookStateManager,
  runbookId: string,
  steps: Step[],
  isComplete: boolean,
  isStopped: boolean
): Promise<RunbookState> {
  let state = updatedState;

  // Handle NEXT step action: increment instance for dynamic runbooks
  const nextInstance = snapshot.context.nextInstance;
  if (nextInstance && !isComplete && !isStopped) {
    // Check if this is a dynamic runbook (has instance field set)
    if (state.instance !== undefined) {
      const currentInstance = state.instance;
      const nextInstanceNum = currentInstance + 1;
      state = await manager.update(runbookId, {
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
      // Use addDynamicSubstep to properly track substep states and get new ID
      const nextSubstepId = await manager.addDynamicSubstep(runbookId);
      state = await manager.update(runbookId, {
        substep: nextSubstepId
      });
    }
  }

  return state;
}

/**
 * Execute command steps in a loop until:
 * - Runbook completes or stops
 * - A prompt-only step is reached (no command)
 * - In prompted mode (no auto-execution)
 *
 * @param manager - Runbook state manager instance
 * @param runbookId - ID of the runbook to execute
 * @param steps - Array of runbook steps
 * @param cwd - Current working directory for command execution
 * @param prompted - Whether to run in prompted mode (no auto-execution)
 * @param agentId - Optional agent ID for agent-specific runbook stacks
 * @returns 'done' if completed, 'stopped' if stopped, 'waiting' if prompt-only step reached
 */
export async function runExecutionLoop(
  manager: RunbookStateManager,
  runbookId: string,
  steps: Step[],
  cwd: string,
  prompted: boolean,
  agentId?: string
): Promise<'done' | 'stopped' | 'waiting'> {
  // Note: state is loaded here and reloaded at end of each loop iteration.
  // Some immutable properties (parentRunbookId, agentId) are accessed from
  // the initial load for completion handling. This is safe because these
  // properties are set at runbook creation and never modified.
  let state = await manager.load(runbookId);
  if (!state) return 'stopped';

  // Detect if this is a dynamic runbook (first step has isDynamic: true)
  // In dynamic runbooks, state.step is '{N}' but state.instance tracks the current instance number
  const isDynamicRunbook = steps.length > 0 && steps[0].isDynamic;

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    // For dynamic runbooks, always use the template step (index 0)
    // For static runbooks, use the step name to find index
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const currentStepIndex = isDynamicRunbook ? 0 : steps.findIndex(s => s.name === state!.step);
    const currentStep = currentStepIndex >= 0 ? steps[currentStepIndex] : steps[0];

    // For dynamic runbooks, use state.instance for display; for static, use step name
    // state.instance is set to 1 on initialization for dynamic runbooks
    const displayStep = isDynamicRunbook && state.instance !== undefined
      ? String(state.instance)   // Use instance field: 1, 2, 3, ...
      : state.step;              // Use step name: "1", "ErrorHandler", etc.

    // For dynamic runbooks, display {N} as total; for static, use steps.length
    // '{N}' indicates dynamic runbook with unbounded iterations
    const totalSteps: number | string = isDynamicRunbook ? '{N}' : steps.length;

    // Determine what to render: substep if we're at one, otherwise the step
    let itemToRender: Step | Substep = currentStep;
    if (state.substep && currentStep.substeps) {
      // Find the substep - for dynamic substeps use the template, otherwise match by id
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const substep = currentStep.substeps.find(s => s.isDynamic || s.id === state!.substep);
      if (substep) {
        itemToRender = substep;
      }
    }

    // Resolve {n} in substep for display
    // If substep is {n}, use substepStates count; otherwise use as-is
    const displaySubstep = state.substep === '{n}'
      ? String(state.substepStates?.length ?? 1)
      : state.substep;

    // Print step/substep block with resolved instance number
    printStepBlock({ current: displayStep, total: totalSteps, substep: displaySubstep }, itemToRender);

    // If CLI prompted mode, OR no command
    if (prompted || !currentStep.command) {
      return 'waiting';
    }

    // Execute command (output via stdio:inherit)
    printCommandExec(currentStep.command.code);
    const execResult = await executeCommand(currentStep.command.code, cwd);

    // Store result
    const lastResult = execResult.success ? 'pass' : 'fail';
    await manager.setLastResult(runbookId, lastResult);

    // Capture prev state BEFORE mutation
    const prevStep = state.step;
    const prevInstance = state.instance;
    const prevSubstep = state.substep;
    const prevRetryCount = state.retryCount;

    // Send event to actor
    const actor = await manager.createActor(runbookId, steps);
    if (!actor) return 'stopped';

    actor.send({ type: execResult.success ? 'PASS' : 'FAIL' });
    let updatedState = await manager.updateFromActor(runbookId, actor, steps);

    // XState snapshot type is not fully typed
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
    const snapshot = actor.getPersistedSnapshot() as any;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const isComplete = isRunbookComplete(snapshot);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const isStopped = isRunbookStopped(snapshot);

    // Handle NEXT instance/substep flags
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    updatedState = await handleNextInstanceFlags(snapshot, updatedState, manager, runbookId, steps, isComplete, isStopped);

    // Derive action string
    const retryMax = getStepRetryMax(currentStep);
    // Compute substep instance for {n} resolution
    // If substep is numeric, use it; if {n}, use substepStates count
    const substepInstance = updatedState.substep
      ? (updatedState.substep === '{n}'
          ? (updatedState.substepStates?.length ?? 1)
          : parseInt(updatedState.substep, 10) || undefined)
      : undefined;
    const action = deriveAction(
      prevStep,
      updatedState.step,
      prevSubstep,
      updatedState.substep,
      prevRetryCount,
      updatedState.retryCount,
      retryMax,
      isComplete,
      isStopped,
      updatedState.instance,
      substepInstance
    );

    // Update lastAction in state
    const actionType = action.startsWith('GOTO') ? 'GOTO' :
                       action.startsWith('RETRY') ? 'RETRY' :
                       action as 'CONTINUE' | 'COMPLETE' | 'STOP';
    await manager.update(runbookId, { lastAction: actionType });

    // Compute prev display step (for action block output)
    const prevDisplayStep = isDynamicRunbook && prevInstance !== undefined
      ? String(prevInstance)   // Use instance field: 1, 2, 3, ...
      : prevStep;              // Use step name: "1", "ErrorHandler", etc.

    // Resolve {n} in prev substep for display
    // Use prev substep states count since this is the state before transition
    const prevSubstepStatesLen = state.substepStates?.length ?? 1;
    const prevDisplaySubstep = prevSubstep === '{n}'
      ? String(prevSubstepStatesLen)
      : prevSubstep;

    // Print separator and action block
    printSeparator();
    printActionBlock({
      action,
      from: { current: prevDisplayStep, total: totalSteps, substep: prevDisplaySubstep },
      result: execResult.success ? 'PASS' : 'FAIL',
    });

    // Handle runbook end states
    if (isComplete) {
      // Extract message from the transition that led to completion
      const completionMessage = lastResult === 'pass'
        ? evaluatePassCondition(currentStep).message
        : evaluateFailCondition(currentStep, prevRetryCount).message;

      const currentVars = updatedState.variables;
      await manager.update(runbookId, {
        variables: { ...currentVars, completed: true }
      });
      printRunbookComplete(completionMessage);

      // If this was a child runbook with agent, update parent's agent binding

      if (agentId && state.parentRunbookId) {

        await manager.updateAgentBinding(state.parentRunbookId, agentId, {
          status: 'done',
          result: 'pass'
        });
      }

      // Pop current runbook from stack (makes parent active if exists, or clears stack)
      await manager.popRunbook(agentId);
      return 'done';
    }

    if (isStopped) {
      // Extract message from the transition that led to stop
      const stopMessage = lastResult === 'pass'
        ? evaluatePassCondition(currentStep).message
        : evaluateFailCondition(currentStep, prevRetryCount).message;

      const currentVars = updatedState.variables;
      await manager.update(runbookId, {
        variables: { ...currentVars, stopped: true }
      });
      printRunbookStoppedAtStep({ current: prevDisplayStep, total: totalSteps, substep: prevDisplaySubstep }, stopMessage);

      // If this was a child runbook with agent, update parent's agent binding

      if (agentId && state.parentRunbookId) {

        await manager.updateAgentBinding(state.parentRunbookId, agentId, {
          status: 'done',
          result: 'fail'
        });
      }

      // Pop current runbook from stack
      await manager.popRunbook(agentId);
      return 'stopped';
    }

    // Reload state for next iteration
    state = await manager.load(runbookId);
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
 * @param step - Runbook step to get retry max from
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
 * @param state - Current runbook state
 * @returns Metadata object for CLI output
 */
export function buildMetadata(state: RunbookState): RunbookMetadata {
  return {
    file: state.runbook,
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
 * @param isComplete - Whether the runbook is complete
 * @param isStopped - Whether the runbook is stopped
 * @param instance - Instance number for dynamic runbooks (to resolve {N} placeholders)
 * @param substepInstance - Substep instance number for dynamic substeps (to resolve {n} placeholders)
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
  isStopped: boolean,
  instance?: number,
  substepInstance?: number
): string {
  if (isComplete) return 'COMPLETE';
  if (isStopped) return 'STOP';
  if (newStep === prevStep && newRetryCount > prevRetryCount) {
    return `RETRY (${String(newRetryCount)}/${String(retryMax)})`;
  }

  /**
   * Resolve {N} and {n} placeholders with actual instance numbers.
   */
  const resolvePlaceholders = (s: string): string => {
    let result = s;
    if (instance !== undefined && result.includes('{N}')) {
      result = result.replace(/\{N\}/g, String(instance));
    }
    if (substepInstance !== undefined && result.includes('{n}')) {
      result = result.replace(/\{n\}/g, String(substepInstance));
    }
    return result;
  };

  // CRITICAL FIX: Any transition with a substep target is a GOTO
  // Even "sequential" step changes are GOTO if substep is specified
  // Because GOTO step_2.1 is meaningfully different from CONTINUE to step_2
  if (newSubstep) {
    const resolvedSubstep = resolvePlaceholders(newSubstep);
    return `GOTO ${resolvePlaceholders(newStep)}.${resolvedSubstep}`;
  }

  // Check if step change is sequential (e.g., "1" → "2")
  // Sequential means: both are numeric strings and newStep = prevStep + 1
  if (newStep !== prevStep) {
    const prevNum = parseInt(prevStep, 10);
    const newNum = parseInt(newStep, 10);
    const isSequential = !isNaN(prevNum) && !isNaN(newNum) && newNum === prevNum + 1;
    if (!isSequential) {
      return `GOTO ${resolvePlaceholders(newStep)}`;
    }
  }

  // Sequential step change or same step = CONTINUE
  return 'CONTINUE';
}
