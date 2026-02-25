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
  extractLastAction,
  parseActionType,
  buildTargetKey,
  deriveExecutionAt,
  getActiveForContext,
  type AnyActorRef,
  stepIdToString,
  type DeferredCompletion,
  type Step,
  type RunbookState,
  type RunbookCompletedPayload,
  type RunbookStoppedPayload,
  type StepTransitionedPayload,
} from '@rundown-org/core';
import { getRunbookFromState } from './runbook-loader.js';
import { runExecutionLoop } from '../services/execution.js';
import type { OutputEmitter } from '../services/output-emitter.js';
import { createBridgedEmitter } from './execution-emitter.js';
import {
  orchestrateTransition,
  type TransitionEventSink,
  type TransitionOrchestrationPolicy,
} from './transition-orchestrator.js';

/**
 * Action type derived from formatted action string.
 */
export type ActionType = 'GOTO' | 'RETRY' | 'CONTINUE' | 'COMPLETE' | 'STOP';

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
  /** Terminal side-effect policy shared with execution loop transitions. */
  policy: TransitionOrchestrationPolicy;
}

/**
 * Canonical PASS transition behavior.
 */
export function createPassTransitionConfig(): TransitionConfig {
  return {
    eventType: 'PASS',
    commandName: 'pass',
    lastResult: 'pass',
    computeActionResult: (actionType: ActionType) =>
      actionType !== 'RETRY' && actionType !== 'STOP',
    policy: {
      onStopped: {
        popRunbook: false,
        updateParentBinding: false,
        parentResult: 'fail',
      },
      onComplete: {
        popRunbook: true,
        updateParentBinding: true,
        parentResult: 'pass',
      },
    },
  };
}

/**
 * Canonical FAIL transition behavior.
 */
export function createFailTransitionConfig(): TransitionConfig {
  return {
    eventType: 'FAIL',
    commandName: 'fail',
    lastResult: 'fail',
    computeActionResult: () => false,
    policy: {
      onStopped: {
        popRunbook: true,
        updateParentBinding: true,
        parentResult: 'fail',
      },
      onComplete: {
        popRunbook: true,
        updateParentBinding: true,
        parentResult: 'pass',
      },
    },
  };
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

interface RuntimeTarget {
  step: string;
  substep?: string;
  iteration?: number;
  at: string;
  key: string;
}

function toRuntimeTarget(step: string, substep?: string, iteration?: number): RuntimeTarget {
  return {
    step,
    substep,
    iteration,
    at: deriveExecutionAt(step, substep, iteration),
    key: buildTargetKey(step, substep, iteration),
  };
}

function activeCursorTarget(state: RunbookState): RuntimeTarget {
  const activeFor = getActiveForContext(state.forStack, state.step);
  return toRuntimeTarget(state.step, state.substep, activeFor?.iteration);
}

function resolveBindingTarget(
  state: RunbookState,
  steps: Step[],
  binding: RunbookState['agentBindings'][string],
): RuntimeTarget {
  if (binding.targetStep) {
    return toRuntimeTarget(binding.targetStep, binding.targetSubstep, binding.targetIteration);
  }

  // Legacy compatibility: infer only when target is unambiguous from active state.
  if (binding.stepId.step !== state.step) {
    throw new Error(
      `Legacy agent binding target cannot be inferred for ${stepIdToString(binding.stepId)}. ` +
        `Current cursor: ${activeCursorTarget(state).at}. Re-queue the active step before completing this agent.`,
    );
  }

  const inferredSubstep = binding.stepId.substep ?? state.substep;
  if (!binding.stepId.substep && !state.substep) {
    const activeStep = steps.find((s) => s.name === state.step);
    if (activeStep?.substeps && activeStep.substeps.length > 1) {
      throw new Error(
        `Legacy agent binding for step ${state.step} is ambiguous without a substep. ` +
          `Re-queue a specific frontier substep and rebind the agent.`,
      );
    }
  }

  const activeFor = getActiveForContext(state.forStack, state.step);
  return toRuntimeTarget(state.step, inferredSubstep, activeFor?.iteration);
}

function isFrontierTarget(target: RuntimeTarget, cursor: RuntimeTarget): boolean {
  if (target.step !== cursor.step) return false;
  if (cursor.iteration !== undefined) return target.iteration === cursor.iteration;
  return target.iteration === undefined;
}

/**
 * Handle agent binding completion.
 *
 * Matching cursor targets are routed through the same actor PASS/FAIL path
 * as plain commands. Valid frontier targets that are not at cursor are
 * deferred. Out-of-frontier and stale completions are rejected.
 */
export async function handleAgentBinding(
  ctx: TransitionContext,
  agentId: string,
  _config: TransitionConfig,
): Promise<boolean> {
  const { output, manager, lifecycleService, state, steps } = ctx;
  const binding = await manager.getAgentBinding(state.id, agentId);

  if (!binding) {
    // No binding - this is a standalone runbook in agent's stack
    // Continue to main pass/fail flow
    return false;
  }

  if (binding.status !== 'running') {
    throw new Error(
      `Agent ${agentId} completion is stale (binding status is ${binding.status}). ` +
        'Use rd status to inspect current bindings before completing.',
    );
  }

  let result: 'pass' | 'fail' = _config.lastResult;
  if (binding.childRunbookId) {
    const childResult = await lifecycleService.getChildRunbookResult(binding.childRunbookId);
    if (childResult === null) {
      throw new Error(
        `Child runbook still active. Complete or stop it first.\nChild runbook: ${binding.childRunbookId}`,
      );
    }
    result = childResult;
  }

  const target = resolveBindingTarget(state, steps, binding);
  const cursor = activeCursorTarget(state);

  if (!isFrontierTarget(target, cursor)) {
    throw new Error(
      `Rejected out-of-frontier completion. Current cursor: ${cursor.key} (${cursor.at}). ` +
        `Attempted target: ${target.key} (${target.at}).`,
    );
  }

  await manager.updateAgentBinding(state.id, agentId, {
    status: 'done',
    result,
    targetStep: target.step,
    targetSubstep: target.substep,
    targetIteration: target.iteration,
  });

  const updated = await manager.load(state.id);
  const bindings = Object.values(updated?.agentBindings ?? {});
  const runningCount = bindings.filter((b) => b.status === 'running').length;

  if (target.key === cursor.key) {
    const transitionConfig =
      result === 'pass' ? createPassTransitionConfig() : createFailTransitionConfig();
    await executeTransition(ctx, transitionConfig);
    return true;
  }

  const completion: DeferredCompletion = {
    agentId,
    result,
    targetStep: target.step,
    targetSubstep: target.substep,
    targetIteration: target.iteration,
    completedAt: new Date().toISOString(),
  };
  await lifecycleService.upsertDeferredCompletion(state.id, target.key, completion);

  output.status(
    result === 'pass',
    'agent_deferred',
    `Agent ${agentId} completion deferred for ${target.at} (${String(runningCount)} agent(s) still running)`,
    {
      agent: agentId,
      targetAt: target.at,
      targetKey: target.key,
      result,
      agentsRunning: runningCount,
    },
  );
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
  // Capture previous state before mutation.
  const previousState = { ...state };
  const currentStep = steps.find((s) => s.name === previousState.step) ?? steps[0];

  actor.send({ type: config.eventType });
  const { state: updatedState, snapshot: rawSnapshot } = await actorService.updateFromActor(
    state.id,
    actor,
    steps,
  );

  const actionType = parseActionType(extractLastAction(rawSnapshot));
  const actionResult = config.computeActionResult(actionType);
  const commandSink: TransitionEventSink = {
    onStepTransitioned: (payload: StepTransitionedPayload) => {
      output.action({
        action: payload.action,
        from: payload.from,
        at: payload.to,
        result: payload.result,
        ...(payload.command ? { command: payload.command } : {}),
      });
    },
    onRunbookCompleted: (payload: RunbookCompletedPayload) => {
      output.complete(payload.message, payload.finalPosition);
    },
    onRunbookStopped: (payload: RunbookStoppedPayload) => {
      output.stopped(payload.message, payload.position);
    },
  };

  const orchestration = await orchestrateTransition({
    manager,
    sessionService: ctx.sessionService,
    sink: commandSink,
    runbookId: state.id,
    steps,
    currentStep,
    previousState,
    updatedState,
    snapshot: rawSnapshot,
    result: config.lastResult,
    actionResult,
    policy: config.policy,
    agentId,
  });

  output.flush();

  if (orchestration.status === 'stopped') {
    process.exit(1);
  }
  if (orchestration.status === 'done') {
    return;
  }

  const emitter = createBridgedEmitter(updatedState, output);
  const loopResult = await runExecutionLoop(
    manager,
    state.id,
    steps,
    cwd,
    !!state.prompted,
    emitter,
    agentId,
  );

  output.flush();
  if (loopResult === 'stopped') {
    process.exit(1);
  }
}
