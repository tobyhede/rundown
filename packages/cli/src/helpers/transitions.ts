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
  parseStepIdFromString,
  type ActionType,
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
  deriveExecutionAt,
  deriveActiveFrame,
  SENTINEL_ENTRY,
  type FrameKey,
  type AnyActorRef,
  type ResolvedStep,
  type RunbookState,
  type RunbookCompletedPayload,
  type RunbookStoppedPayload,
  type StepTransitionedPayload,
} from '@rundown-org/core';
import { resolvedStepHasSubsteps } from '@rundown-org/parser';
import { persistPassOutputs } from './execution-units.js';
import { resolveIndexOption } from './index-option.js';
import { getRunbookFromState } from './runbook-loader.js';
import {
  buildStepVariables,
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
  steps: ResolvedStep[];
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
 * Explicit target for directing a transition at a specific substep and iteration.
 *
 * Used by `pass --step` and `fail --step` to target a specific substep
 * rather than the current cursor position.
 */
export interface ExplicitTarget {
  /** Step ID string (e.g., "1.1") */
  stepId: string;
  /** Optional `--index` value (raw string from CLI) */
  index?: string;
}

/**
 * Perform a pass/fail transition against the active runbook state.
 *
 * Records or reuses a resolved completion when targeting a substep; otherwise sends the configured
 * transition event to the runbook actor, orchestrates step-level changes, and runs the execution loop
 * as required. Emits CLI output for actions, completions, runbook completion, and stopped conditions.
 *
 * @param ctx - Runtime transition context containing output, services, current state, parsed steps, actor, and cwd
 * @param config - Transition configuration that determines the event type, persisted result, action-result mapping, and terminal policy
 * @param explicitTarget - Optional explicit step/substep target (e.g., "2.1") and optional raw `--index` value to target a specific iteration
 * @returns `'continue'` when execution proceeds or completes normally, `'stopped'` when a terminal stop was reached
 * @throws {Error} if the active step is missing, an explicit target is invalid, or lifecycle/orchestration validations fail
 * @throws {IndexOptionError} if `--index` validation or resolution fails
 */
export async function executeTransition(
  ctx: TransitionContext,
  config: TransitionConfig,
  explicitTarget?: ExplicitTarget,
): Promise<'continue' | 'stopped'> {
  const { output, manager, actorService, state, steps, actor, cwd, lifecycleService } = ctx;
  const ensured = await lifecycleService.ensureActiveEntry(state.id, undefined, state);
  const activeState = ensured.state;
  const activeStep = findStepOrThrow(steps, activeState.step);
  const isSubstepCompletion = !!(
    activeState.substep &&
    resolvedStepHasSubsteps(activeStep) &&
    activeStep.substeps.length
  );

  // Guard: --step targets a substep, so reject if we're not in substep mode
  if (explicitTarget && !isSubstepCompletion) {
    throw new Error(
      `--step requires the runbook to be at a substep, but step "${activeState.step}" has no active substep`,
    );
  }

  if (isSubstepCompletion) {
    // If explicit target, build RuntimeTarget from parsed step ID + resolved index
    let cursor: RuntimeTarget;
    if (explicitTarget) {
      const parsed = parseStepIdFromString(explicitTarget.stepId);
      if (!parsed) {
        throw new Error(`Invalid step target: ${explicitTarget.stepId}`);
      }
      if (parsed.step !== activeState.step) {
        throw new Error(
          `--step ${explicitTarget.stepId} targets step "${parsed.step}" but the active step is "${activeState.step}"`,
        );
      }
      // Require substep — bare step IDs create unreachable completions
      if (!parsed.substep) {
        throw new Error(
          `--step ${explicitTarget.stepId} must include a substep (e.g., "${parsed.step}.1")`,
        );
      }
      // Validate substep exists in the step definition
      if (parsed.substep && resolvedStepHasSubsteps(activeStep)) {
        const validIds = activeStep.substeps.map((s) => s.id);
        if (!validIds.includes(parsed.substep)) {
          throw new Error(
            `--step ${explicitTarget.stepId}: substep "${parsed.substep}" does not exist in step "${parsed.step}". Valid substeps: ${validIds.join(', ')}`,
          );
        }
      }

      let resolvedIndex = resolveIndexOption(explicitTarget.index, parsed.at);

      // Reject template AT expressions — they cannot be resolved in pass/fail context
      if (typeof parsed.at === 'string') {
        throw new Error(
          `--step ${explicitTarget.stepId} uses template AT expression "${parsed.at}", which cannot be resolved here. Use --index <number> instead.`,
        );
      }

      // Default to active iteration when inside a FOR step without explicit --index
      if (
        resolvedIndex === undefined &&
        (activeStep.kind === 'for' || activeStep.kind === 'prompted-for')
      ) {
        const activeFrame = deriveActiveFrame(activeState);
        resolvedIndex = activeFrame.iteration;
      }

      // Validate iteration bounds against step definition
      if (resolvedIndex !== undefined) {
        if (activeStep.kind !== 'for' && activeStep.kind !== 'prompted-for') {
          throw new Error(
            `--index requires step "${parsed.step}" to be a FOR or PROMPTED-FOR step, but it is "${activeStep.kind}"`,
          );
        }
        // Bounds checks only apply to 'for' steps (prompted-for has no forClause)
        if (activeStep.kind === 'for') {
          const fc = activeStep.forClause;
          if (resolvedIndex < fc.start) {
            throw new Error(
              `--index ${String(resolvedIndex)} is below FOR start ${String(fc.start)} for step "${parsed.step}"`,
            );
          }
          if ('end' in fc && resolvedIndex > fc.end) {
            throw new Error(
              `--index ${String(resolvedIndex)} exceeds FOR end ${String(fc.end)} for step "${parsed.step}"`,
            );
          }
        }
      }

      // Use sentinel entry (0) for non-active frames to avoid entry prediction issues
      const targetFrameKey = buildFrameKey(parsed.step, resolvedIndex);
      const isActiveFrame =
        targetFrameKey === (activeState.activeFrameKey ?? buildFrameKey(activeState.step));
      const entryForCompletion = isActiveFrame ? (activeState.activeEntry ?? 1) : SENTINEL_ENTRY;

      cursor = toRuntimeTarget(
        parsed.step,
        parsed.substep,
        resolvedIndex,
        entryForCompletion,
        targetFrameKey,
      );
    } else {
      cursor = activeCursorTarget(activeState);
    }
    const targetSubstep = explicitTarget ? cursor.substep : activeState.substep;
    const completionKey = buildCompletionKey(cursor.frameKey, cursor.entry, targetSubstep);
    let existing = await lifecycleService.getResolvedCompletion(activeState.id, completionKey);

    // Cross-check sentinel/exact keys to prevent coexisting completions for the same frame/substep
    if (!existing && cursor.entry !== SENTINEL_ENTRY) {
      // Look up the target frame's entry (not the active frame's) for correct cross-check
      const targetFrameEntry =
        activeState.activeFrameKey === cursor.frameKey
          ? (activeState.activeEntry ?? 1)
          : (activeState.frameEntries?.[cursor.frameKey] ?? 1);
      const crossEntry = cursor.entry === SENTINEL_ENTRY ? targetFrameEntry : SENTINEL_ENTRY;
      const crossKey = buildCompletionKey(cursor.frameKey, crossEntry, targetSubstep);
      existing = await lifecycleService.getResolvedCompletion(activeState.id, crossKey);
    }
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
      output.status('completion_duplicate', `Completion already recorded for ${cursor.at}`, {
        at: cursor.at,
        frameKey: cursor.frameKey,
        entry: cursor.entry,
      });
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
      cwd,
      ...(explicitTarget ? { frameKeyOverride: cursor.frameKey } : {}),
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

  const actionType = parseActionType(extractLastAction(rawSnapshot));

  // Store OUTPUTS for PASS transitions (best-effort, non-fatal).
  if (config.lastResult === 'pass') {
    // Build the per-step runtime frame (Step, Index, context.current.*) so that
    // OUTPUTS expressions referencing loop/step variables resolve correctly.
    const preTransitionStepVars = buildStepVariables(
      previousState.step,
      previousState.substep,
      previousState.forStack,
      currentStep.kind === 'for' ? currentStep.forClause : undefined,
      previousState.templateVars,
    );
    await persistPassOutputs({
      cwd,
      currentStep,
      currentSubstepId: previousState.substep,
      previousStepId: previousState.step,
      updatedStepId: actorUpdatedState.step,
      actionType,
      templateVarsBefore: preTransitionStepVars,
      templateVarsAfter: actorUpdatedState.templateVars,
    });
  }

  const ensuredAfterTransition = await lifecycleService.ensureActiveEntry(
    activeState.id,
    previousState,
    actorUpdatedState,
  );
  const updatedState = ensuredAfterTransition.state;

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
