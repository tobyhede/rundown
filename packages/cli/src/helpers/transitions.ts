/**
 * Shared logic for pass/fail transition commands.
 *
 * This module extracts common patterns from pass.ts and fail.ts into
 * reusable functions, with configuration-driven behavior for the
 * semantic differences between pass and fail transitions.
 *
 * @module helpers/transitions
 */

import {
  RunbookStateManager,
  RunbookActorService,
  SessionService,
  ExecutionLifecycleService,
  type AnyActorRef,
  countNumberedSteps,
  isRunbookComplete,
  isRunbookStopped,
  type Step,
  type RunbookState,
  type StepPosition,
  type StepId,
  type LastAction,
  asTerminalSnapshotOrDefault,
} from '@rundown-org/core';
import { getRunbookFromState } from './runbook-loader.js';
import {
  runExecutionLoop,
  formatActionForDisplay,
  extractLastAction,
  extractRetryMax,
} from '../services/execution.js';
import type { OutputEmitter } from '../services/output-emitter.js';
import { createBridgedEmitter } from './execution-emitter.js';

/**
 * Result of evaluating a step condition (PASS or FAIL).
 *
 * Indicates what action should be taken based on the condition evaluation.
 * This mirrors ConditionResult from @rundown-org/core but is defined locally
 * since that type is not exported from the core package.
 */
export interface ConditionResult {
  /** The action to take based on the condition evaluation */
  action: 'retry' | 'stopped' | 'goto' | 'continue' | 'complete';
  /** New retry count (only set when action is 'retry') */
  newRetryCount?: number;
  /** Target step for GOTO action */
  gotoTarget?: StepId;
  /** Message to display (typically for STOP action) */
  message?: string;
}

/**
 * Action type derived from formatted action string.
 */
export type ActionType = 'GOTO' | 'RETRY' | 'CONTINUE' | 'COMPLETE' | 'STOP';

/**
 * Side effects to perform when reaching terminal states.
 */
export interface TerminalSideEffects {
  /** Whether to pop the runbook from the stack */
  popRunbook: boolean;
  /** Whether to update parent agent binding (if agent + parentRunbookId) */
  updateParentBinding: boolean;
}

/**
 * Configuration for transition behavior.
 *
 * Captures all semantic differences between pass and fail commands
 * in a declarative structure.
 */
export interface TransitionConfig {
  /** Event type to send to the actor */
  eventType: 'PASS' | 'FAIL';
  /** Command name for error messages */
  commandName: 'pass' | 'fail';
  /**
   * lastResult value to persist (user's command choice).
   * pass='pass', fail='fail'
   */
  lastResult: 'pass' | 'fail';
  /**
   * Compute action result for output.action().
   * pass: derived from actionType (false for RETRY/STOP)
   * fail: always false
   */
  computeActionResult: (actionType: ActionType) => boolean;
  /**
   * Condition evaluator - receives step and prevState for pre-transition context.
   * fail uses prevState.retryCount for correct message; pass ignores retryCount.
   */
  evaluateCondition: (step: Step, prevState: RunbookState) => ConditionResult;
  /** Order of terminal state checks */
  terminalOrder: 'complete-first' | 'stopped-first';
  /** Side effects when runbook stops (STOP transition) */
  onStopped: TerminalSideEffects;
  /** Side effects when runbook completes */
  onComplete: TerminalSideEffects;
}

/**
 * Context for executing a transition.
 *
 * Contains all the resolved state needed for transition execution.
 */
export interface TransitionContext {
  /** Output emitter for CLI output */
  output: OutputEmitter;
  /** Runbook state manager */
  manager: RunbookStateManager;
  /** Actor lifecycle service */
  actorService: RunbookActorService;
  /** Session stack orchestration service */
  sessionService: SessionService;
  /** Execution lifecycle service */
  lifecycleService: ExecutionLifecycleService;
  /** Current runbook state */
  state: RunbookState;
  /** Parsed runbook steps */
  steps: Step[];
  /** XState actor for the runbook */
  actor: AnyActorRef;
  /** Current working directory */
  cwd: string;
  /** Optional agent ID */
  agentId?: string;
}

/**
 * Resolve active runbook state with agent fallback logic.
 *
 * If agent specified but no runbook in agent's stack, check default stack for binding.
 *
 * @param sessionService - Session service for stack operations
 * @param manager - Runbook state manager for loading state
 * @param agentId - Optional agent ID
 * @returns Active runbook state or null if none found
 */
export async function resolveActiveState(
  sessionService: SessionService,
  manager: RunbookStateManager,
  agentId?: string,
): Promise<RunbookState | null> {
  let state = await sessionService.getActive(agentId);

  // If agent specified but no runbook in agent's stack, check default stack for binding
  if (!state && agentId) {
    const parentState = await sessionService.getActive(); // Default stack
    if (parentState) {
      const binding = await manager.getAgentBinding(parentState.id, agentId);
      if (binding) {
        // Agent has binding on parent but no child runbook - operate on parent
        state = parentState;
      }
    }
  }

  return state;
}

/**
 * Build full transition context from resolved state.
 *
 * Loads runbook, parses steps, and creates actor.
 *
 * @param output - Output emitter for CLI output
 * @param cwd - Current working directory
 * @param agentId - Optional agent ID
 * @returns TransitionContext or null if no active runbook
 * @throws Error if state is missing runbookSrc (corrupted state)
 * @throws Error if runbook engine fails to initialize
 */
export async function buildTransitionContext(
  output: OutputEmitter,
  cwd: string,
  agentId?: string,
): Promise<TransitionContext | null> {
  const manager = new RunbookStateManager(cwd);
  const actorService = new RunbookActorService(manager);
  const sessionService = new SessionService(manager);
  const lifecycleService = new ExecutionLifecycleService(manager);
  const state = await resolveActiveState(sessionService, manager, agentId);

  if (!state) {
    return null;
  }

  const readonlySteps = getRunbookFromState(state, cwd);
  const steps = [...readonlySteps]; // Convert to mutable array for TransitionContext
  const actor = await actorService.createActor(state.id, steps);
  if (!actor) {
    throw new Error('Failed to initialize runbook engine');
  }

  return {
    output,
    manager,
    actorService,
    sessionService,
    lifecycleService,
    state,
    steps,
    actor,
    cwd,
    agentId,
  };
}

/**
 * Calculate display position info for a runbook state.
 *
 * @param state - Current runbook state
 * @param steps - Parsed runbook steps
 * @returns Display position with step, total, and optional substep
 */
export function calculatePosition(
  state: RunbookState,
  steps: Step[],
): { displayStep: string; totalSteps: number; displaySubstep?: string } {
  const totalSteps = countNumberedSteps(steps);
  return { displayStep: state.step, totalSteps, displaySubstep: state.substep };
}

/**
 * Build prev/new position objects for output.action().
 *
 * @param prevState - State before transition
 * @param newState - State after transition
 * @param steps - Parsed runbook steps
 * @returns Prev and new position objects
 */
export function buildPositions(
  prevState: RunbookState,
  newState: RunbookState,
  steps: Step[],
): { prevPos: StepPosition; newPos: StepPosition } {
  const totalSteps = countNumberedSteps(steps);

  const prevPos: StepPosition = {
    current: prevState.step,
    total: totalSteps,
    substep: prevState.substep,
  };
  const newPos: StepPosition = {
    current: newState.step,
    total: totalSteps,
    substep: newState.substep,
  };

  return { prevPos, newPos };
}

/**
 * Derive actionType from structured LastAction.
 *
 * Maps the discriminated union type to the simplified ActionType used
 * for display-layer result computation.
 *
 * @param lastAction - The structured LastAction from XState context
 * @returns Action type for display-layer use
 */
export function parseActionType(lastAction: LastAction | undefined): ActionType {
  if (!lastAction) return 'CONTINUE';
  switch (lastAction.type) {
    case 'GOTO':
      return 'GOTO';
    case 'RETRY':
      return 'RETRY';
    case 'COMPLETE':
      return 'COMPLETE';
    case 'STOP':
      return 'STOP';
    default:
      return 'CONTINUE';
  }
}

/**
 * Handle terminal states (complete/stopped) with configurable side effects.
 *
 * @param ctx - Transition context
 * @param config - Transition configuration
 * @param isComplete - Whether runbook is complete
 * @param isStopped - Whether runbook is stopped
 * @param _prevState - State before transition (for correct retryCount in messages)
 * @param positions - Prev and new position objects
 * @param conditionResult - Result of condition evaluation (for message)
 * @returns 'complete', 'stopped', or 'continue'
 */
export async function handleTerminalState(
  ctx: TransitionContext,
  config: TransitionConfig,
  isComplete: boolean,
  isStopped: boolean,
  _prevState: RunbookState,
  positions: { prevPos: StepPosition; newPos: StepPosition },
  conditionResult: ConditionResult,
): Promise<'complete' | 'stopped' | 'continue'> {
  const { output, manager, sessionService, state, agentId } = ctx;
  const { prevPos, newPos } = positions;

  /**
   * Apply terminal side effects based on configuration.
   */
  const applySideEffects = async (
    effects: TerminalSideEffects,
    result: 'pass' | 'fail',
  ): Promise<void> => {
    // updateParentBinding only executes when BOTH agentId AND parentRunbookId are present
    if (effects.updateParentBinding && agentId && state.parentRunbookId) {
      await manager.updateAgentBinding(state.parentRunbookId, agentId, {
        status: 'done',
        result,
      });
    }

    if (effects.popRunbook) {
      await sessionService.popRunbook(agentId);
    }
  };

  // Check terminal states in configured order
  const checks =
    config.terminalOrder === 'complete-first'
      ? [
          { check: isComplete, type: 'complete' as const },
          { check: isStopped, type: 'stopped' as const },
        ]
      : [
          { check: isStopped, type: 'stopped' as const },
          { check: isComplete, type: 'complete' as const },
        ];

  for (const { check, type } of checks) {
    if (!check) continue;

    if (type === 'complete') {
      output.complete(conditionResult.message, newPos);
      output.flush();

      await applySideEffects(config.onComplete, config.lastResult);
      return 'complete';
    }

    // type === 'stopped' (only other possibility)
    // stopped uses prevPos for output
    output.stopped(conditionResult.message, prevPos);
    output.flush();

    await applySideEffects(config.onStopped, config.lastResult);
    process.exit(1);
    return 'stopped'; // Explicit return for clarity (process.exit never returns)
  }

  return 'continue';
}

/**
 * Handle agent binding completion with condition evaluation.
 *
 * Unified handler for both pass and fail agent bindings. Evaluates
 * RETRY/GOTO conditions before marking agent as done. If retry or
 * goto is triggered, continues execution instead of marking complete.
 *
 * @param ctx - Transition context
 * @param agentId - Agent ID to check binding for
 * @param config - Transition configuration (for condition evaluation)
 * @returns True if agent binding was handled, false to continue to main flow
 */
export async function handleAgentBinding(
  ctx: TransitionContext,
  agentId: string,
  config: TransitionConfig,
): Promise<boolean> {
  const { output, manager, actorService, lifecycleService, state, steps, actor, cwd } = ctx;
  const binding = await manager.getAgentBinding(state.id, agentId);

  if (!binding) {
    // No binding - this is a standalone runbook in agent's stack
    // Continue to main pass/fail flow
    return false;
  }

  // Agent binding exists - evaluate condition for RETRY/GOTO (same for pass and fail)
  const stepName = binding.stepId.step;
  const stepIndex = steps.findIndex((s) => s.name === stepName);
  const agentStep = stepIndex >= 0 ? steps[stepIndex] : steps[0];
  const conditionResult = config.evaluateCondition(agentStep, state);

  if (conditionResult.action === 'retry') {
    try {
      actor.send({ type: config.eventType });
      const { state: retryState } = await actorService.updateFromActor(state.id, actor, steps);
      output.status(true, 'retry', `Agent ${agentId} retrying step ${stepName}`, {
        agent: agentId,
        step: stepName,
      });
      // Continue with execution loop for retry
      const retryEmitter = createBridgedEmitter(retryState, output);
      const loopResult = await runExecutionLoop(
        manager,
        state.id,
        steps,
        cwd,
        !!state.prompted,
        agentId,
        retryEmitter,
      );
      output.flush();
      if (loopResult === 'stopped') process.exit(1);
      return true;
    } finally {
      actor.stop();
    }
  }

  if (conditionResult.action === 'goto') {
    try {
      actor.send({ type: config.eventType });
      const { state: gotoState } = await actorService.updateFromActor(state.id, actor, steps);
      output.status(true, 'goto', `Agent ${agentId} triggered goto to step ${gotoState.step}`, {
        agent: agentId,
        step: gotoState.step,
      });
      // Continue with execution loop after GOTO
      const gotoEmitter = createBridgedEmitter(gotoState, output);
      const loopResult = await runExecutionLoop(
        manager,
        state.id,
        steps,
        cwd,
        !!state.prompted,
        agentId,
        gotoEmitter,
      );
      output.flush();
      if (loopResult === 'stopped') process.exit(1);
      return true;
    } finally {
      actor.stop();
    }
  }

  // No retry/goto - mark binding as done; stop actor since it's no longer needed
  actor.stop();

  let result: 'pass' | 'fail' = config.lastResult;

  if (binding.childRunbookId) {
    const childResult = await lifecycleService.getChildRunbookResult(binding.childRunbookId);
    if (childResult === null) {
      throw new Error(
        `Child runbook still active. Complete or stop it first.\nChild runbook: ${binding.childRunbookId}`,
      );
    }
    result = childResult;
  }

  await manager.updateAgentBinding(state.id, agentId, { status: 'done', result });

  const updated = await manager.load(state.id);
  const bindings = Object.values(updated?.agentBindings ?? {});
  const runningCount = bindings.filter((b) => b.status === 'running').length;

  const action = config.lastResult === 'pass' ? 'agent_completed' : 'agent_failed';
  const statusMessage =
    runningCount > 0
      ? `Agent ${agentId} marked as ${config.lastResult} (${String(runningCount)} agent(s) still running)`
      : `Agent ${agentId} marked as ${config.lastResult} (All agents complete)`;

  output.status(config.lastResult === 'pass', action, statusMessage, {
    agent: agentId,
    result,
    agentsRunning: runningCount,
  });
  output.flush();
  return true;
}

/**
 * Execute a transition with the given configuration.
 *
 * Main entry point for transition execution. Sends event to actor,
 * updates state, emits action output, handles terminal states,
 * and runs execution loop if needed.
 *
 * @param ctx - Transition context
 * @param config - Transition configuration
 */
export async function executeTransition(
  ctx: TransitionContext,
  config: TransitionConfig,
): Promise<void> {
  const { output, manager, actorService, state, steps, actor, cwd, agentId } = ctx;

  try {
    // Capture prev state BEFORE mutation (deep copy for retryCount, etc.)
    const prevState = { ...state };

    // Calculate initial position for action output
    const { displayStep } = calculatePosition(state, steps);
    const prevSubstep = state.substep;

    // Send event
    actor.send({ type: config.eventType });

    const { state: updatedState, snapshot: rawSnapshot } = await actorService.updateFromActor(
      state.id,
      actor,
      steps,
    );

    const terminalSnapshot = asTerminalSnapshotOrDefault(rawSnapshot);
    const isComplete = isRunbookComplete(terminalSnapshot);
    const isStopped = isRunbookStopped(terminalSnapshot);

    // Read action from XState context (source of truth for retryMax and lastAction)
    const prevStepIndex = steps.findIndex((s) => s.name === prevState.step);
    const currentStep = prevStepIndex >= 0 ? steps[prevStepIndex] : steps[0];
    const retryMax = extractRetryMax(rawSnapshot);
    const lastActionFromContext = extractLastAction(rawSnapshot);

    const action = formatActionForDisplay(lastActionFromContext, updatedState.retryCount, retryMax);

    // Derive action type and compute result
    const actionType = parseActionType(lastActionFromContext);
    const actionResult = config.computeActionResult(actionType);

    // Update lastAction and lastResult in persistent state (pass structured object directly)
    await manager.update(state.id, {
      lastAction: lastActionFromContext,
      lastResult: config.lastResult,
    });

    // Build positions for output
    const totalStepsValue = countNumberedSteps(steps);

    const prevPos = { current: displayStep, total: totalStepsValue, substep: prevSubstep };
    const newPos = {
      current: updatedState.step,
      total: totalStepsValue,
      substep: updatedState.substep,
    };

    // Emit action block
    output.action({
      action,
      from: prevPos,
      result: actionResult,
      at: newPos,
    });

    // Evaluate condition for terminal state message (using prevState for correct retryCount)
    const conditionResult = config.evaluateCondition(currentStep, prevState);

    // Handle terminal states
    const terminalResult = await handleTerminalState(
      ctx,
      config,
      isComplete,
      isStopped,
      prevState,
      { prevPos, newPos },
      conditionResult,
    );

    if (terminalResult !== 'continue') {
      return;
    }

    // Create emitter bridged to unified output
    const emitter = createBridgedEmitter(updatedState, output);

    const loopResult = await runExecutionLoop(
      manager,
      state.id,
      steps,
      cwd,
      !!state.prompted,
      agentId,
      emitter,
    );

    // Flush any remaining output
    output.flush();

    if (loopResult === 'stopped') {
      process.exit(1);
    }
  } finally {
    actor.stop();
  }
}
