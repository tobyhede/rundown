// packages/cli/src/services/execution.ts

import {
  type RunbookStateManager,
  printActionBlock,
  printStepBlock,
  printStepSeparator,
  printCommandExec,
  printRunbookComplete,
  printRunbookStoppedAtStep,
  printPolicyDenied,
  type Step,
  type Substep,
  type RunbookMetadata,
  type RunbookState,
  type ExecutionResult,
  executeCommand,
  executeCommandWithPolicy,
  evaluatePassCondition,
  evaluateFailCondition,
  countNumberedSteps,
  extractDisplayCommand,
} from '@rundown/core';
import {
  isInternalRdCommand,
  executeRdCommandInternal,
} from './internal-commands.js';
import {
  getPolicyEvaluator,
  getPolicyPrompter,
  isPolicyEnforced,
} from './policy-context.js';

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

    // For dynamic runbooks, display {N} as total; for static, use numbered step count
    // '{N}' indicates dynamic runbook with unbounded iterations
    const totalSteps: number | string = isDynamicRunbook ? '{N}' : countNumberedSteps(steps);

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
    // Use itemToRender which may be a substep with its own command
    if (prompted || !itemToRender.command) {
      return 'waiting';
    }

    // Execute command
    // For rd commands, try internal execution first (avoids nested spawn issues in WebContainer)
    // Use display command (with rd echo wrapper stripped) for cleaner output
    // Fall back to original command if extractDisplayCommand returns empty (e.g., "rd echo --result pass")
    const extracted = extractDisplayCommand(itemToRender.command.code);
    const displayCommand = extracted || itemToRender.command.code;
    printCommandExec(displayCommand);
    let execResult: ExecutionResult;

    if (isInternalRdCommand(itemToRender.command.code)) {
      const internalResult = await executeRdCommandInternal(itemToRender.command.code, cwd);
      if (internalResult !== null) {
        execResult = internalResult;
      } else {
        // Fallback to spawn if internal execution not supported for this subcommand
        execResult = await executeCommandWithPolicyCheck(itemToRender.command.code, cwd, state.runbookPath);
      }
    } else {
      execResult = await executeCommandWithPolicyCheck(itemToRender.command.code, cwd, state.runbookPath);
    }

    // Handle policy denial
    if (execResult.policyDenied) {
      printPolicyDenied(itemToRender.command.code, execResult.denialReason ?? 'Permission denied');
      return 'stopped';
    }

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

    // Compute new display step (position after transition)
    const newDisplayStep = isDynamicRunbook && updatedState.instance !== undefined
      ? String(updatedState.instance)
      : updatedState.step;

    // Resolve {n} in new substep for display
    const newDisplaySubstep = updatedState.substep === '{n}'
      ? String(updatedState.substepStates?.length ?? 1)
      : updatedState.substep;

    // Compute positions for output
    const prevPos = { current: prevDisplayStep, total: totalSteps, substep: prevDisplaySubstep };
    const newPos = { current: newDisplayStep, total: totalSteps, substep: newDisplaySubstep };

    // Print separator with new step number and action block
    printStepSeparator(newPos);
    printActionBlock({
      action,
      from: prevPos,
      command: displayCommand,
      result: execResult.success ? 'PASS' : 'FAIL',
      at: newPos,
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
 * XState snapshot context with lastAction and retryMax fields.
 * Used for type-safe extraction of action and retry info from persisted snapshots.
 */
interface SnapshotContext {
  lastAction?: string;
  retryMax?: number;
  nextInstance?: boolean;
  nextSubstepInstance?: boolean;
}

/**
 * Extract the lastAction from an XState snapshot in a type-safe way.
 *
 * @param snapshot - The persisted XState snapshot
 * @returns The lastAction string or undefined
 */
export function extractLastAction(snapshot: unknown): string | undefined {
  if (
    snapshot &&
    typeof snapshot === 'object' &&
    'context' in snapshot &&
    snapshot.context &&
    typeof snapshot.context === 'object' &&
    'lastAction' in snapshot.context
  ) {
    return (snapshot.context as SnapshotContext).lastAction;
  }
  return undefined;
}

/**
 * Extract the retryMax from an XState snapshot in a type-safe way.
 *
 * The XState context is the source of truth for retryMax, storing the value
 * when a RETRY action is triggered. This avoids needing to re-derive it from
 * step definitions.
 *
 * @param snapshot - The persisted XState snapshot
 * @returns The retryMax number or 0 if not set
 */
export function extractRetryMax(snapshot: unknown): number {
  if (
    snapshot &&
    typeof snapshot === 'object' &&
    'context' in snapshot &&
    snapshot.context &&
    typeof snapshot.context === 'object' &&
    'retryMax' in snapshot.context
  ) {
    return (snapshot.context as SnapshotContext).retryMax ?? 0;
  }
  return 0;
}

/**
 * Format action for display, resolving placeholders and adding retry details.
 *
 * Reads the lastAction from XState context (source of truth) and formats
 * it for user-friendly display. Resolves {N} and {n} placeholders to actual
 * instance numbers, and appends retry count info for RETRY actions.
 *
 * @param lastAction - The lastAction value from XState context
 * @param retryCount - Current retry count
 * @param retryMax - Maximum retries allowed
 * @param instance - Step instance number for resolving {N} placeholders
 * @param substepInstance - Substep instance number for resolving {n} placeholders
 * @returns Formatted action string for display
 */
export function formatActionForDisplay(
  lastAction: string | undefined,
  retryCount: number,
  retryMax: number,
  instance?: number,
  substepInstance?: number
): string {
  if (!lastAction) return 'CONTINUE';
  if (lastAction === 'RETRY') {
    return `RETRY (${String(retryCount)}/${String(retryMax)})`;
  }

  // Resolve {N} and {n} placeholders with actual instance numbers
  let result = lastAction;
  if (instance !== undefined && result.includes('{N}')) {
    result = result.replace(/\{N\}/g, String(instance));
  }
  if (substepInstance !== undefined && result.includes('{n}')) {
    result = result.replace(/\{n\}/g, String(substepInstance));
  }
  return result;
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
 * Get retry max for a step or substep.
 * @param item - Runbook step or substep to get retry max from
 * @returns Maximum number of retries, or 0 if no retry configured
 */
export function getStepRetryMax(item: Step | Substep): number {
  if (!item.transitions) return 0;
  // Check FAIL transition first
  if (item.transitions.fail.action.type === 'RETRY') {
    return item.transitions.fail.action.max;
  }
  // Also check PASS transition
  if (item.transitions.pass.action.type === 'RETRY') {
    return item.transitions.pass.action.max;
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

  // Helper to check if substep transition is sequential
  const isSequentialSubstep = (prev: string | undefined, next: string | undefined): boolean => {
    if (!prev || !next) return false;
    const prevNum = parseInt(prev, 10);
    const nextNum = parseInt(next, 10);
    return !isNaN(prevNum) && !isNaN(nextNum) && nextNum === prevNum + 1;
  };

  // Handle substep transitions
  if (newSubstep) {
    // Same step, sequential substeps (1.1 → 1.2) = CONTINUE
    if (newStep === prevStep && isSequentialSubstep(prevSubstep, newSubstep)) {
      return 'CONTINUE';
    }
    // Non-sequential substep or different step = GOTO
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

/**
 * Execute a command with policy enforcement.
 *
 * Uses the global policy context to check permissions before execution.
 * If policy is enforced and the command requires permission, prompts the user.
 * Sets the runbook path on the evaluator to enable runbook-specific overrides.
 *
 * @param command - The shell command to execute
 * @param cwd - Working directory for execution
 * @param runbookPath - Optional runbook file path for override matching
 * @returns Execution result
 */
async function executeCommandWithPolicyCheck(
  command: string,
  cwd: string,
  runbookPath?: string
): Promise<ExecutionResult> {
  // Check if policy enforcement is active
  if (!isPolicyEnforced()) {
    return executeCommand(command, cwd);
  }

  // Get evaluator and set runbook path for override matching
  const evaluator = getPolicyEvaluator();
  if (runbookPath) {
    evaluator.setRunbookPath(runbookPath);
  }

  // Use policy-aware execution
  return executeCommandWithPolicy(command, cwd, {
    evaluator,
    prompter: getPolicyPrompter(),
  });
}
