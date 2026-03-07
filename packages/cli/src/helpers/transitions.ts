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
  formatTransitionAction,
  parseActionType,
  type ActionType,
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
  deriveExecutionAt,
  deriveActiveFrame,
  type FrameKey,
  type AnyActorRef,
  type Step,
  type RunbookState,
  type RunbookCompletedPayload,
  type RunbookStoppedPayload,
  type StepTransitionedPayload,
} from '@rundown-org/core';
import { stepHasSubsteps } from '@rundown-org/parser';
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
        popRunbook: true,
      },
      onComplete: {
        popRunbook: true,
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
      },
      onComplete: {
        popRunbook: true,
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
}

/**
 * Build full transition context from resolved state.
 *
 * Loads runbook, parses steps, and creates actor.
 *
 * @param output - Output emitter for CLI output
 * @param cwd - Current working directory
 * @returns TransitionContext or null if no active runbook
 * @throws {Error} if state is missing runbookSrc (corrupted state)
 * @throws {Error} if runbook engine fails to initialize
 */
export async function buildTransitionContext(
  output: OutputEmitter,
  cwd: string,
): Promise<TransitionContext | null> {
  const manager = new RunbookStateManager(cwd);
  const actorService = new RunbookActorService(manager);
  const sessionService = new SessionService(manager);
  const lifecycleService = new ExecutionLifecycleService(manager);
  const state = await sessionService.getActive();

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
  };
}

interface RuntimeTarget {
  step: string;
  substep?: string;
  iteration?: number;
  frameKey: FrameKey;
  entry: number;
  completionKey: string;
  at: string;
}

function toRuntimeTarget(
  step: string,
  substep: string | undefined,
  iteration: number | undefined,
  entry: number,
  frameKey?: FrameKey,
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

/**
 * Execute a transition with the given configuration.
 *
 * Main entry point for transition execution. Sends event to actor,
 * updates state, emits action output, handles terminal states,
 * and runs execution loop if needed.
 *
 * @param ctx - Transition context
 * @param config - Transition configuration
 * @returns `'continue'` for normal flow including completed/done paths, `'stopped'` if it reached a terminal state
 * @throws {Error} from `findStepOrThrow` if the active step is missing (state corruption),
 *   from `ensureActiveEntry` on lifecycle violations, or from orchestration failures
 */
export async function executeTransition(
  ctx: TransitionContext,
  config: TransitionConfig,
): Promise<'continue' | 'stopped'> {
  const { output, manager, actorService, state, steps, actor, cwd, lifecycleService } = ctx;
  const ensured = await lifecycleService.ensureActiveEntry(state.id, undefined, state);
  const activeState = ensured.state;
  const activeStep = findStepOrThrow(steps, activeState.step);
  const isSubstepCompletion = !!(
    activeState.substep &&
    stepHasSubsteps(activeStep) &&
    activeStep.substeps.length
  );

  if (isSubstepCompletion) {
    const cursor = activeCursorTarget(activeState);
    const completionKey = buildCompletionKey(cursor.frameKey, cursor.entry, activeState.substep);
    const existing = await lifecycleService.getResolvedCompletion(activeState.id, completionKey);
    if (!existing) {
      const completion = buildResolvedCompletion({
        agentId: 'manual',
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
        action: formatTransitionAction(
          payload.action,
          payload.at,
          payload.retryAttempt,
          payload.retryMax,
          payload.forIndex,
        ),
        from: payload.from,
        at: payload.at,
        result: payload.result,
        ...(payload.forIndex !== undefined
          ? { forIndex: payload.forIndex, forEnd: payload.forEnd }
          : {}),
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
  );

  output.flush();
  if (loopResult === 'stopped') {
    return 'stopped';
  }
  return 'continue';
}
