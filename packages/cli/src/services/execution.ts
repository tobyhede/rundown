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
  type ExecutionEventEmitter,
  type LastAction,
  type ForContext,
} from '@rundown-org/core';
import {
  isInternalRdCommand,
  executeRdCommandInternal,
} from './internal-commands.js';
import {
  getPolicyEvaluator,
  getPolicyPrompter,
  isPolicyEnforced,
  getSandboxOptions,
} from './policy-context.js';
import { expandLoopVariables } from './template-renderer.js';

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
 * Build a loop variable map from the current FOR loop state.
 *
 * Returns `undefined` when no expansion is needed (no explicit FOR loop active).
 * Falls back to the step's `forClause` definition when `forStack` is empty
 * (initial state created without actor snapshot, before first transition).
 *
 * @param forStack - Current FOR loop stack from persisted state
 * @param forClause - FOR clause from the step definition (bootstrap fallback)
 * @returns Variable map with `Index` and optional named variable, or `undefined`
 */
function buildLoopVariables(
  forStack?: readonly ForContext[],
  forClause?: Step['forClause']
): Record<string, string> | undefined {
  // Primary: use forStack (available after first transition)
  if (forStack?.length) {
    const top = forStack[forStack.length - 1];
    if (top.implicit) return undefined;
    const vars: Record<string, string> = { Index: String(top.iteration) };
    if (top.variable) {
      vars[top.variable] = String(top.iteration);
    }
    return vars;
  }
  // Bootstrap: first iteration before actor has run
  if (forClause) {
    const start = forClause.start;
    const vars: Record<string, string> = { Index: String(start) };
    if (forClause.variable) {
      vars[forClause.variable] = String(start);
    }
    return vars;
  }
  return undefined;
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
 * @param emitter - Optional event emitter for execution events
 * @returns 'done' if completed, 'stopped' if stopped, 'waiting' if prompt-only step reached
 */
export async function runExecutionLoop(
  manager: RunbookStateManager,
  runbookId: string,
  steps: Step[],
  cwd: string,
  prompted: boolean,
  agentId?: string,
  emitter?: ExecutionEventEmitter
): Promise<'done' | 'stopped' | 'waiting'> {
  // Note: state is loaded here and reloaded at end of each loop iteration.
  // Some immutable properties (parentRunbookId, agentId) are accessed from
  // the initial load for completion handling. This is safe because these
  // properties are set at runbook creation and never modified.
  let state = await manager.load(runbookId);
  if (!state) return 'stopped';

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const currentStepIndex = steps.findIndex(s => s.name === state!.step);
    const currentStep = currentStepIndex >= 0 ? steps[currentStepIndex] : steps[0];

    const displayStep = state.step;
    const totalSteps = countNumberedSteps(steps);

    // Determine what to render: substep if we're at one, otherwise the step
    let itemToRender: Step | Substep = currentStep;
    if (state.substep && currentStep.substeps) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const substep = currentStep.substeps.find(s => s.id === state!.substep);
      if (substep) {
        itemToRender = substep;
      }
    }

    const displaySubstep = state.substep;

    // Expand FOR loop variables ({{var}}, {{Index}}) for current iteration
    const loopVars = buildLoopVariables(state.forStack, currentStep.forClause);
    const expandedDescription = loopVars
      ? expandLoopVariables(itemToRender.description, loopVars)
      : itemToRender.description;
    const expandedPrompt = loopVars && itemToRender.prompt
      ? expandLoopVariables(itemToRender.prompt, loopVars)
      : itemToRender.prompt;

    // Emit STEP_ENTERED event or print step/substep block
    const stepPosition = { current: displayStep, total: totalSteps, substep: displaySubstep };
    if (emitter) {
      const isSubstep = 'id' in itemToRender;
      emitter.emit('STEP_ENTERED', {
        position: stepPosition,
        stepName: isSubstep ? (itemToRender as Substep).id : (itemToRender as Step).name,
        description: expandedDescription,
        prompt: expandedPrompt,
        hasCommand: !!itemToRender.command,
        commandCode: loopVars && itemToRender.command?.code
          ? expandLoopVariables(itemToRender.command.code, loopVars)
          : itemToRender.command?.code,
        commandLang: itemToRender.command?.lang,
        isSubstep,
        prompted,  // CRITICAL: Pass prompted flag for correct command display
      });
    } else {
      const renderItem = loopVars
        ? {
            ...itemToRender,
            description: expandedDescription,
            prompt: expandedPrompt,
            command: itemToRender.command
              ? { ...itemToRender.command, code: expandLoopVariables(itemToRender.command.code, loopVars) }
              : itemToRender.command,
          }
        : itemToRender;
      // Temporary fallback only when emitter is not provided.
      printStepBlock(stepPosition, renderItem, prompted);
    }

    // If CLI prompted mode, OR no command
    // Use itemToRender which may be a substep with its own command
    if (prompted || !itemToRender.command) {
      return 'waiting';
    }

    // Expand command code for execution (after guard — itemToRender.command is guaranteed)
    const expandedCommandCode = loopVars
      ? expandLoopVariables(itemToRender.command.code, loopVars)
      : itemToRender.command.code;

    // Execute command
    // For rd commands, try internal execution first (avoids nested spawn issues in WebContainer)
    // Use display command (with rd echo wrapper stripped) for cleaner output
    // Fall back to original command if extractDisplayCommand returns empty (e.g., "rd echo --result pass")
    const extracted = extractDisplayCommand(expandedCommandCode);
    const displayCommand = extracted || expandedCommandCode;
    if (emitter) {
      emitter.emit('COMMAND_STARTED', {
        command: expandedCommandCode,
        displayCommand,
        position: { current: displayStep, total: totalSteps, substep: displaySubstep },
      });
    } else {
      // Temporary fallback only when emitter is not provided.
      printCommandExec(displayCommand);
    }
    let execResult: ExecutionResult;

    if (isInternalRdCommand(expandedCommandCode)) {
      const internalResult = await executeRdCommandInternal(expandedCommandCode, cwd);
      if (internalResult !== null) {
        execResult = internalResult;
      } else {
        // Fallback to spawn if internal execution not supported for this subcommand
        execResult = await executeCommandWithPolicyCheck(expandedCommandCode, cwd, state.runbookPath);
      }
    } else {
      execResult = await executeCommandWithPolicyCheck(expandedCommandCode, cwd, state.runbookPath);
    }

    // Emit COMMAND_COMPLETED event
    if (emitter) {
      const cmdPosition = { current: displayStep, total: totalSteps, substep: displaySubstep };
      emitter.emit('COMMAND_COMPLETED', {
        command: expandedCommandCode,
        success: execResult.success,
        exitCode: execResult.exitCode,
        position: cmdPosition,
        policyDenied: execResult.policyDenied,
        denialReason: execResult.denialReason,
        sandboxed: execResult.sandboxed,
      });
    }

    // Handle policy denial
    if (execResult.policyDenied) {
      const policyPosition = { current: displayStep, total: totalSteps, substep: displaySubstep };
      if (emitter) {
        emitter.emit('POLICY_DENIED', {
          command: expandedCommandCode,
          reason: execResult.denialReason ?? 'Permission denied',
          position: policyPosition,
        });
        // Emit RUNBOOK_STOPPED so JSON output shows correct terminal state
        emitter.emit('RUNBOOK_STOPPED', {
          position: policyPosition,
          reason: 'policy_denied',
          message: `Command blocked by policy: ${execResult.denialReason ?? 'Permission denied'}`,
        });
      } else {
        // Temporary fallback only when emitter is not provided.
        printPolicyDenied(expandedCommandCode, execResult.denialReason ?? 'Permission denied');
      }
      return 'stopped';
    }

    // Store result
    const lastResult = execResult.success ? 'pass' : 'fail';
    await manager.setLastResult(runbookId, lastResult);

    // Capture prev state BEFORE mutation
    const prevStep = state.step;
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

    // Read action from XState context (source of truth for retryMax and lastAction)
    const retryMax = extractRetryMax(snapshot);
    const lastActionFromContext = extractLastAction(snapshot);
    const action = formatActionForDisplay(
      lastActionFromContext,
      updatedState.retryCount,
      retryMax
    );

    // Update lastAction in state (pass structured object directly — no lossy conversion)
    await manager.update(runbookId, { lastAction: lastActionFromContext });

    const prevDisplayStep = prevStep;
    const prevDisplaySubstep = prevSubstep;
    const newDisplayStep = updatedState.step;
    const newDisplaySubstep = updatedState.substep;

    // Compute positions for output
    const prevPos = { current: prevDisplayStep, total: totalSteps, substep: prevDisplaySubstep };
    const newPos = { current: newDisplayStep, total: totalSteps, substep: newDisplaySubstep };

    // Emit STEP_TRANSITIONED event or fallback to printing
    if (emitter) {
      emitter.emit('STEP_TRANSITIONED', {
        action,
        from: prevPos,
        to: newPos,
        result: execResult.success,
        command: displayCommand,
      });
    } else {
      // Temporary fallback only when emitter is not provided.
      printStepSeparator(newPos);
      printActionBlock({
        action,
        from: prevPos,
        command: displayCommand,
        result: execResult.success,
        at: newPos,
      });
    }

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
      if (emitter) {
        emitter.emit('RUNBOOK_COMPLETED', {
          message: completionMessage,
          finalPosition: newPos,
        });
      } else {
        // Temporary fallback only when emitter is not provided.
        printRunbookComplete(completionMessage);
      }

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
      const stopPos = { current: prevDisplayStep, total: totalSteps, substep: prevDisplaySubstep };
      if (emitter) {
        emitter.emit('RUNBOOK_STOPPED', {
          message: stopMessage,
          position: stopPos,
          reason: 'fail_transition',
        });
      } else {
        // Temporary fallback only when emitter is not provided.
        printRunbookStoppedAtStep(stopPos, stopMessage);
      }

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
  lastAction?: LastAction;
  retryMax?: number;
}

/**
 * Extract the lastAction from an XState snapshot in a type-safe way.
 *
 * @param snapshot - The persisted XState snapshot
 * @returns The structured LastAction or undefined
 */
export function extractLastAction(snapshot: unknown): LastAction | undefined {
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
 * Format action for display, adding retry details.
 *
 * Reads the structured LastAction from XState context (source of truth) and formats
 * it for user-friendly display. Appends retry count info for RETRY actions.
 *
 * @param lastAction - The structured LastAction from XState context
 * @param retryCount - Current retry count
 * @param retryMax - Maximum retries allowed
 * @returns Formatted action string for display
 */
export function formatActionForDisplay(
  lastAction: LastAction | undefined,
  retryCount: number,
  retryMax: number
): string {
  if (!lastAction) return 'CONTINUE';

  switch (lastAction.type) {
    case 'RETRY':
      return `RETRY (${String(retryCount)}/${String(retryMax)})`;
    case 'GOTO': {
      let result = `GOTO ${lastAction.target}`;
      if (lastAction.substep) {
        result = `GOTO ${lastAction.target}.${lastAction.substep}`;
      }
      if (lastAction.at !== undefined) {
        result = `${result} AT ${String(lastAction.at)}`;
      }
      return result;
    }
    default:
      return lastAction.type;
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
 * Get retry max for a step or substep.
 * @param item - Runbook step or substep to get retry max from
 * @returns Maximum number of retries, or 0 if no retry configured
 */
export function getStepRetryMax(item: Step | Substep): number {
  if (!item.transitions) return 0;
  // Check FAIL transition first (more common to have retry on FAIL)
  if (item.transitions.fail.retry > 0) {
    return item.transitions.fail.retry;
  }
  // Also check PASS transition
  if (item.transitions.pass.retry > 0) {
    return item.transitions.pass.retry;
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

/**
 * Execute a command with policy enforcement.
 *
 * Uses the global policy context to check permissions before execution.
 * If policy is enforced and the command requires permission, prompts the user.
 * Sets the runbook path on the evaluator to enable runbook-specific overrides.
 * When sandboxing is enabled, enforces file access policies at the OS level.
 *
 * @param command - The shell command to execute
 * @param cwd - Working directory for execution
 * @param runbookPath - Optional runbook file path for override matching
 * @returns Execution result
 */
export async function executeCommandWithPolicyCheck(
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

  // Get sandbox options
  const sandboxOpts = getSandboxOptions();

  // Use policy-aware execution with sandbox
  return executeCommandWithPolicy(command, cwd, {
    evaluator,
    prompter: getPolicyPrompter(),
    sandbox: sandboxOpts.sandbox,
    sandboxStrict: sandboxOpts.sandboxStrict,
  });
}
