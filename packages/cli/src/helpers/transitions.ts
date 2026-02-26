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
  type ActionType,
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
  deriveExecutionAt,
  getActiveForContext,
  deriveActiveFrame,
  type AnyActorRef,
  stepIdToString,
  type Step,
  type RunbookState,
  type RunbookCompletedPayload,
  type RunbookStoppedPayload,
  type StepTransitionedPayload,
} from '@rundown-org/core';
import { getRunbookFromState } from './runbook-loader.js';
import {
  drainResolvedCompletions,
  findStepOrThrow,
  runExecutionLoop,
} from '../services/execution.js';
import type { OutputEmitter } from '../services/output-emitter.js';
import { createBridgedEmitter } from './execution-emitter.js';
import {
  orchestrateTransition,
  type TransitionEventSink,
  type TransitionOrchestrationPolicy,
} from './transition-orchestrator.js';
export type { ActionType } from '@rundown-org/core';

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
 *
 * @returns TransitionConfig for PASS transitions
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
 *
 * @returns TransitionConfig for FAIL transitions
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
  frameKey: string;
  entry: number;
  completionKey: string;
  at: string;
}

function toRuntimeTarget(
  step: string,
  substep: string | undefined,
  iteration: number | undefined,
  entry: number,
  frameKey?: string,
): RuntimeTarget {
  const resolvedFrameKey = frameKey ?? buildFrameKey(step, iteration);
  return {
    step,
    substep,
    iteration,
    frameKey: resolvedFrameKey,
    entry,
    completionKey: buildCompletionKey(resolvedFrameKey, entry, substep),
    at: deriveExecutionAt(step, substep, iteration),
  };
}

function activeCursorTarget(state: RunbookState): RuntimeTarget {
  const activeFrame = deriveActiveFrame(state);
  return toRuntimeTarget(
    activeFrame.step,
    state.substep,
    activeFrame.iteration,
    state.activeEntry ?? 1,
    activeFrame.frameKey,
  );
}

function resolveBindingTarget(
  state: RunbookState,
  steps: Step[],
  binding: RunbookState['agentBindings'][string],
): RuntimeTarget {
  if (binding.targetStep) {
    const frameKey =
      binding.targetFrameKey ?? buildFrameKey(binding.targetStep, binding.targetIteration);
    const entry = binding.targetEntry ?? state.activeEntry ?? 1;
    return toRuntimeTarget(
      binding.targetStep,
      binding.targetSubstep,
      binding.targetIteration,
      entry,
      frameKey,
    );
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
  const frame = deriveActiveFrame(state);
  return toRuntimeTarget(
    state.step,
    inferredSubstep,
    activeFor?.iteration,
    state.activeEntry ?? 1,
    frame.frameKey,
  );
}

/**
 * Handle agent binding completion.
 *
 * Agent completions are accepted only for the active frame+entry identity.
 * Accepted completions are recorded and drained through the shared transition path.
 *
 * @param ctx - Transition context
 * @param agentId - Agent ID completing the step
 * @param config - Transition configuration (pass or fail semantics)
 * @returns 'handled' if completion was processed, 'stopped' if runbook stopped, 'not-applicable' if no binding exists
 * @throws Error if binding is stale, child runbook is still active, or target identity is stale
 */
export async function handleAgentBinding(
  ctx: TransitionContext,
  agentId: string,
  config: TransitionConfig,
): Promise<'handled' | 'stopped' | 'not-applicable'> {
  const { output, manager, lifecycleService, state, steps, actorService, sessionService, cwd } =
    ctx;
  const ensured = await lifecycleService.ensureActiveEntry(state.id, undefined, state);
  const activeState = ensured.state;
  const binding = await manager.getAgentBinding(activeState.id, agentId);

  if (!binding) {
    // No binding - this is a standalone runbook in agent's stack
    // Continue to main pass/fail flow
    return 'not-applicable';
  }

  if (binding.status !== 'running') {
    throw new Error(
      `Agent ${agentId} completion is stale (binding status is ${binding.status}). ` +
        'Use rd status to inspect current bindings before completing.',
    );
  }

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

  const target = resolveBindingTarget(activeState, steps, binding);
  const cursor = activeCursorTarget(activeState);
  if (target.frameKey !== cursor.frameKey || target.entry !== cursor.entry) {
    throw new Error(
      `Rejected stale completion. Current frame=${cursor.frameKey}, entry=${String(cursor.entry)} (${cursor.at}). ` +
        `Attempted frame=${target.frameKey}, entry=${String(target.entry)} (${target.at}).`,
    );
  }

  await manager.updateAgentBinding(activeState.id, agentId, {
    status: 'done',
    result,
    targetStep: target.step,
    targetSubstep: target.substep,
    targetIteration: target.iteration,
    targetFrameKey: target.frameKey,
    targetEntry: target.entry,
  });

  // Derive transition config from child result, not from the outer pass/fail command
  const transitionConfig =
    result === 'pass' ? createPassTransitionConfig() : createFailTransitionConfig();
  if (!target.substep) {
    const execResult = await executeTransition(ctx, transitionConfig);
    if (execResult === 'stopped') return 'stopped';
    return 'handled';
  }

  const existing = await lifecycleService.getResolvedCompletion(
    activeState.id,
    target.completionKey,
  );
  if (!existing) {
    const completion = buildResolvedCompletion({
      agentId,
      result,
      targetStep: target.step,
      targetSubstep: target.substep,
      targetIteration: target.iteration,
      targetFrameKey: target.frameKey,
      targetEntry: target.entry,
    });
    await lifecycleService.upsertResolvedCompletion(
      activeState.id,
      target.completionKey,
      completion,
    );
  } else {
    output.status(
      existing.result === 'pass',
      'agent_duplicate',
      `Agent ${agentId} completion already recorded for ${target.at}`,
      {
        agent: agentId,
        targetAt: target.at,
        frameKey: target.frameKey,
        entry: target.entry,
      },
    );
  }

  const emitter = createBridgedEmitter(activeState, output);
  const drained = await drainResolvedCompletions({
    manager,
    actorService,
    sessionService,
    lifecycleService,
    emitter,
    runbookId: activeState.id,
    steps,
    currentState: activeState,
    transitionPolicy: transitionConfig.policy,
    computeActionResult: transitionConfig.computeActionResult,
    agentId: ctx.agentId,
  });

  if (drained.status === 'stopped') {
    output.flush();
    return 'stopped';
  }
  if (drained.status === 'done') {
    output.flush();
    return 'handled';
  }

  if (drained.applied > 0) {
    const loopResult = await runExecutionLoop(
      manager,
      activeState.id,
      steps,
      cwd,
      !!drained.state.prompted,
      emitter,
      ctx.agentId,
    );
    output.flush();
    if (loopResult === 'stopped') {
      return 'stopped';
    }
    return 'handled';
  }

  output.status(
    result === 'pass',
    'agent_recorded',
    `Agent ${agentId} completion recorded for ${target.at}`,
    {
      agent: agentId,
      targetAt: target.at,
      frameKey: target.frameKey,
      entry: target.entry,
      unresolved: drained.unresolved,
    },
  );
  output.flush();
  return 'handled';
}

/**
 * Propagate child runbook completion to the parent runbook.
 *
 * After `executeTransition` completes a child runbook, this function detects
 * whether the child was popped (agent stack empty) and, if so, propagates the
 * result to the parent. For substep bindings, a resolved completion is recorded
 * and drained through the standard path. For step-level bindings, the parent
 * transition is executed directly (mirroring handleAgentBinding's non-substep path).
 *
 * Child COMPLETE maps to PASS; child STOPPED maps to FAIL.
 *
 * @param ctx - Transition context (scoped to the child's agent)
 * @param agentId - Agent ID whose child runbook just completed
 * @returns 'handled' if parent was advanced, 'stopped' if parent stopped, 'not-applicable' if no propagation needed
 */
export async function handleAgentCompletion(
  ctx: TransitionContext,
  agentId: string,
): Promise<'handled' | 'stopped' | 'not-applicable'> {
  const { manager, sessionService, lifecycleService, output, cwd } = ctx;

  // 1. Check if agent stack is empty (child was popped)
  const agentActive = await sessionService.getActive(agentId);
  if (agentActive) return 'not-applicable'; // Child still running

  // 2. Load parent state (default stack)
  const parentState = await sessionService.getActive();
  if (!parentState) return 'not-applicable';

  // 3. Get binding
  const binding = await manager.getAgentBinding(parentState.id, agentId);
  if (!binding) return 'not-applicable';

  // 4. Load parent steps
  const readonlySteps = getRunbookFromState(parentState, cwd);
  const parentSteps = [...readonlySteps];

  // 5. Read binding.result as the child's terminal result
  const result = binding.result;
  if (!result) return 'not-applicable'; // No result yet

  // 6. Determine transition config from child result
  const transitionConfig =
    result === 'pass' ? createPassTransitionConfig() : createFailTransitionConfig();

  // 7. Resolve target from binding
  const target = resolveBindingTarget(parentState, parentSteps, binding);

  // 8. Stale check
  const cursor = activeCursorTarget(parentState);
  if (target.frameKey !== cursor.frameKey || target.entry !== cursor.entry) {
    throw new Error(
      `Rejected stale agent completion propagation. Current frame=${cursor.frameKey}, entry=${String(cursor.entry)} (${cursor.at}). ` +
        `Attempted frame=${target.frameKey}, entry=${String(target.entry)} (${target.at}).`,
    );
  }

  // 9. Non-substep path: execute transition directly on parent (mirrors handleAgentBinding)
  if (!target.substep) {
    const parentActorService = new RunbookActorService(manager);
    const parentActor = await parentActorService.createActor(parentState.id, parentSteps);
    if (!parentActor) {
      throw new Error(
        'Failed to initialize parent runbook engine for agent completion propagation',
      );
    }
    const parentCtx: TransitionContext = {
      output,
      manager,
      actorService: parentActorService,
      sessionService,
      lifecycleService,
      state: parentState,
      steps: parentSteps,
      actor: parentActor,
      cwd,
      agentId: undefined, // Default stack operations
    };
    try {
      const execResult = await executeTransition(parentCtx, transitionConfig);
      if (execResult === 'stopped') return 'stopped';
      return 'handled';
    } finally {
      parentActor.stop();
    }
  }

  const existing = await lifecycleService.getResolvedCompletion(
    parentState.id,
    target.completionKey,
  );
  if (!existing) {
    const completion = buildResolvedCompletion({
      agentId,
      result,
      targetStep: target.step,
      targetSubstep: target.substep,
      targetIteration: target.iteration,
      targetFrameKey: target.frameKey,
      targetEntry: target.entry,
    });
    await lifecycleService.upsertResolvedCompletion(
      parentState.id,
      target.completionKey,
      completion,
    );
  }

  // Create a new actor service for the parent runbook
  const parentActorService = new RunbookActorService(manager);
  const emitter = createBridgedEmitter(parentState, output);
  const drained = await drainResolvedCompletions({
    manager,
    actorService: parentActorService,
    sessionService,
    lifecycleService,
    emitter,
    runbookId: parentState.id,
    steps: parentSteps,
    currentState: parentState,
    transitionPolicy: transitionConfig.policy,
    computeActionResult: transitionConfig.computeActionResult,
    agentId: undefined, // Default stack operations
  });

  if (drained.status === 'stopped') {
    output.flush();
    return 'stopped';
  }
  if (drained.status === 'done') {
    output.flush();
    return 'handled';
  }

  if (drained.applied > 0) {
    const loopResult = await runExecutionLoop(
      manager,
      parentState.id,
      parentSteps,
      cwd,
      !!drained.state.prompted,
      emitter,
      undefined, // Default stack
    );
    output.flush();
    if (loopResult === 'stopped') {
      return 'stopped';
    }
    return 'handled';
  }

  // applied === 0: waiting for other substeps
  output.flush();
  return 'handled';
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
 * @returns `'continue'` if the runbook should keep running, `'stopped'` if it reached a terminal state
 * @throws Error from `findStepOrThrow` if the active step is missing (state corruption),
 *   from `ensureActiveEntry` on lifecycle violations, or from orchestration failures
 */
export async function executeTransition(
  ctx: TransitionContext,
  config: TransitionConfig,
): Promise<'continue' | 'stopped'> {
  const { output, manager, actorService, state, steps, actor, cwd, agentId, lifecycleService } =
    ctx;
  const ensured = await lifecycleService.ensureActiveEntry(state.id, undefined, state);
  const activeState = ensured.state;
  const activeStep = findStepOrThrow(steps, activeState.step);
  const isSubstepCompletion = !!(activeState.substep && activeStep.substeps?.length);

  if (isSubstepCompletion) {
    const cursor = activeCursorTarget(activeState);
    const completionKey = buildCompletionKey(cursor.frameKey, cursor.entry, activeState.substep);
    const existing = await lifecycleService.getResolvedCompletion(activeState.id, completionKey);
    if (!existing) {
      const completion = buildResolvedCompletion({
        agentId: agentId ?? 'manual',
        result: config.lastResult,
        targetStep: cursor.step,
        targetSubstep: cursor.substep,
        targetIteration: cursor.iteration,
        targetFrameKey: cursor.frameKey,
        targetEntry: cursor.entry,
      });
      await lifecycleService.upsertResolvedCompletion(activeState.id, completionKey, completion);
    } else {
      output.status(
        existing.result === 'pass',
        'completion_duplicate',
        `Completion already recorded for ${cursor.at}`,
        {
          at: cursor.at,
          frameKey: cursor.frameKey,
          entry: cursor.entry,
        },
      );
    }

    const emitter = createBridgedEmitter(activeState, output);
    const drained = await drainResolvedCompletions({
      manager,
      actorService,
      sessionService: ctx.sessionService,
      lifecycleService,
      emitter,
      runbookId: activeState.id,
      steps,
      currentState: activeState,
      transitionPolicy: config.policy,
      computeActionResult: config.computeActionResult,
      agentId,
    });
    if (drained.status === 'stopped') {
      output.flush();
      return 'stopped';
    }
    if (drained.status === 'done') {
      output.flush();
      return 'continue';
    }
    if (drained.applied === 0) {
      output.flush();
      return 'continue';
    }

    const loopResult = await runExecutionLoop(
      manager,
      activeState.id,
      steps,
      cwd,
      !!drained.state.prompted,
      emitter,
      agentId,
    );
    output.flush();
    if (loopResult === 'stopped') {
      return 'stopped';
    }
    return 'continue';
  }

  // Capture previous state before mutation.
  const previousState = { ...activeState };
  const currentStep = findStepOrThrow(steps, previousState.step);

  actor.send({ type: config.eventType });
  const { state: actorUpdatedState, snapshot: rawSnapshot } = await actorService.updateFromActor(
    activeState.id,
    actor,
    steps,
  );
  const ensuredAfterTransition = await lifecycleService.ensureActiveEntry(
    activeState.id,
    previousState,
    actorUpdatedState,
  );
  const updatedState = ensuredAfterTransition.state;

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
    runbookId: activeState.id,
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

  if (orchestration.status === 'stopped') {
    output.flush();
    return 'stopped';
  }
  if (orchestration.status === 'done') {
    output.flush();
    return 'continue';
  }

  const emitter = createBridgedEmitter(updatedState, output);
  const loopResult = await runExecutionLoop(
    manager,
    activeState.id,
    steps,
    cwd,
    !!updatedState.prompted,
    emitter,
    agentId,
  );

  output.flush();
  if (loopResult === 'stopped') {
    return 'stopped';
  }
  return 'continue';
}
