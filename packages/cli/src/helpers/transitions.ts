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
  RunbookCompletionService,
  SessionService,
  ExecutionLifecycleService,
  formatTransitionAction,
  parseStepIdFromString,
  type ActionType,
  buildFrameKey,
  deriveExecutionAt,
  deriveActiveFrame,
  activeFrame,
  inactiveFrame,
  completionEntryForFrame,
  type Frame,
  type RunbookActorService,
  type ResolvedStep,
  type RunbookState,
  type RunbookCompletedPayload,
  type RunbookStoppedPayload,
  type StepTransitionedPayload,
  type ErrorOccurredPayload,
  type ClaimId,
  type RunId,
  isRunId,
} from '@rundown-org/core';
import { createCliRunbookActorService } from './actor-service-factory.js';
import { resolvedStepHasSubsteps } from '@rundown-org/parser';
import { resolveIndexOption } from './index-option.js';
import { getRunbookFromState } from './runbook-loader.js';
import {
  drainResolvedCompletions,
  findStepOrThrow,
  runExecutionLoop,
  type ExecutionTerminalReleaseMode,
} from '../services/execution.js';
import type { OutputEmitter } from '../services/output-emitter.js';
import { createBridgedEmitter } from './execution-emitter.js';
import {
  orchestrateTransition,
  type TransitionEventSink,
  type TransitionOrchestrationPolicy,
} from './transition-orchestrator.js';
import { resolveActiveRunbook, type ActiveRunbookResolution } from './active-runbook-resolver.js';
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
        releaseRunbook: true,
      },
      onComplete: {
        releaseRunbook: true,
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
        releaseRunbook: true,
      },
      onComplete: {
        releaseRunbook: true,
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
  /** Current working directory */
  cwd: string;
  /** How terminal follow-on execution should release this runbook from session targeting. */
  terminalReleaseMode: ExecutionTerminalReleaseMode;
}

/** Result of resolving the runbook target and building transition execution context. */
export type BuildTransitionContextResult =
  | { readonly kind: 'ready'; readonly ctx: TransitionContext }
  | Extract<ActiveRunbookResolution, { kind: 'none' | 'stale_claim' }>;

/**
 * Build full transition context from resolved state.
 *
 * Loads runbook and parses steps.
 *
 * @param output - Output emitter for CLI output
 * @param cwd - Current working directory
 * @param options - Optional explicit claim-id target
 * @param options.claimId - Claim id to resolve instead of the default stack
 * @returns `{ kind: 'ready', ctx }` when a target is resolved; `{ kind: 'none' }` when
 *   there is no active runbook; `{ kind: 'stale_claim' }` when the active claim is stale.
 * @throws {Error} if state is missing runbookSrc (corrupted state)
 */
export async function buildTransitionContext(
  output: OutputEmitter,
  cwd: string,
  options: { readonly claimId?: ClaimId } = {},
): Promise<BuildTransitionContextResult> {
  const manager = new RunbookStateManager(cwd);
  const actorService = createCliRunbookActorService(manager);
  const sessionService = new SessionService(manager);
  const lifecycleService = new ExecutionLifecycleService(manager);
  const active = await resolveActiveRunbook(sessionService, options);

  switch (active.kind) {
    case 'claim':
    case 'default':
      break;
    case 'none':
    case 'stale_claim':
      return active;
    default: {
      const _exhaustive: never = active;
      return _exhaustive;
    }
  }

  const state = active.state;
  const terminalReleaseMode: ExecutionTerminalReleaseMode =
    active.kind === 'claim' ? 'release-runbook' : 'stack-pop';
  const readonlySteps = getRunbookFromState(state, cwd);
  const steps = [...readonlySteps]; // Convert to mutable array for TransitionContext

  return {
    kind: 'ready',
    ctx: {
      output,
      manager,
      actorService,
      sessionService,
      lifecycleService,
      state,
      steps,
      cwd,
      terminalReleaseMode,
    },
  };
}

interface RuntimeTarget {
  step: string;
  substep?: string;
  iteration?: number;
  frame: Frame;
  at: string;
}

function toRuntimeTarget(
  step: string,
  substep: string | undefined,
  iteration: number | undefined,
  frame: Frame,
): RuntimeTarget {
  return {
    step,
    substep,
    iteration,
    frame,
    at: deriveExecutionAt(step, substep, iteration),
  };
}

function activeCursorTarget(state: RunbookState): RuntimeTarget {
  const active = deriveActiveFrame(state);
  const frameKey = state.activeFrameKey ?? active.frameKey;
  return toRuntimeTarget(
    active.step,
    state.substep,
    active.iteration,
    activeFrame(frameKey, state.activeEntry ?? 1),
  );
}

function findRunningInlineChildRunId(state: RunbookState): RunId | undefined {
  if (!state.substep) return undefined;
  const active = deriveActiveFrame(state);
  const frameKey = state.activeFrameKey ?? active.frameKey;
  const substepState = state.substepStates?.find(
    (entry) => entry.id === state.substep && entry.frameKey === frameKey,
  );
  if (substepState?.status !== 'running') return undefined;
  const childRunId = substepState.inline?.childRunId;
  return isRunId(childRunId) ? childRunId : undefined;
}

async function reactivateRunningInlineChild(
  ctx: TransitionContext,
  parentState: RunbookState,
): Promise<boolean> {
  const childRunId = findRunningInlineChildRunId(parentState);
  if (!childRunId) return false;

  const childState = await ctx.manager.load(childRunId);
  if (childState?.lifecycle !== 'running') return false;
  const linkage = childState.parentLinkage;
  if (
    linkage?.kind !== 'inline' ||
    linkage.parentRunId !== parentState.id ||
    linkage.parentStep !== parentState.step ||
    linkage.parentStepId !== parentState.substep
  ) {
    return false;
  }

  const active = await ctx.sessionService.getActive();
  if (active?.id !== childRunId) {
    await ctx.sessionService.pushRunbook(childRunId);
  }
  return true;
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
 * @param ctx - Runtime transition context containing output, services, current state, parsed steps, and cwd
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
  const { output, manager, actorService, state, steps, cwd, lifecycleService } = ctx;
  const stateIsFresh = await actorService.assertFreshState(state.id, steps);
  if (!stateIsFresh) {
    throw new Error('Runbook state is stale or mismatched with current definition');
  }
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

      const targetFrameKey = buildFrameKey(parsed.step, resolvedIndex);
      const active = deriveActiveFrame(activeState);
      const activeFrameKey = activeState.activeFrameKey ?? active.frameKey;
      const activeEntry = activeState.activeEntry ?? 1;
      const frame =
        targetFrameKey === activeFrameKey
          ? activeFrame(targetFrameKey, activeEntry)
          : inactiveFrame(targetFrameKey);

      cursor = toRuntimeTarget(parsed.step, parsed.substep, resolvedIndex, frame);
    } else {
      cursor = activeCursorTarget(activeState);
    }
    const targetSubstep = explicitTarget ? cursor.substep : activeState.substep;
    if (!targetSubstep) {
      throw new Error('Substep completion requires an active or explicit substep target');
    }
    if (!explicitTarget && (await reactivateRunningInlineChild(ctx, activeState))) {
      output.flush();
      return 'continue';
    }
    const completionService = new RunbookCompletionService(manager, lifecycleService, actorService);
    const recorded = await completionService.recordManualCompletion({
      runbookId: activeState.id,
      currentState: activeState,
      targetStep: cursor.step,
      targetSubstep,
      targetIteration: cursor.iteration,
      targetFrame: cursor.frame,
      result: config.lastResult,
      agentId: 'manual',
    });
    if (recorded.status === 'duplicate') {
      output.status('completion_duplicate', `Completion already recorded for ${cursor.at}`, {
        at: cursor.at,
        frameKey: cursor.frame.frameKey,
        entry: completionEntryForFrame(cursor.frame),
      });
    }

    const emitter = createBridgedEmitter(activeState, output);
    const drained = await drainResolvedCompletions({
      actorService,
      manager,
      sessionService: ctx.sessionService,
      lifecycleService,
      emitter,
      runbookId: activeState.id,
      steps,
      currentState: activeState,
      transitionPolicy: config.policy,
      computeActionResult: config.computeActionResult,
      ...(explicitTarget ? { frameOverride: cursor.frame } : {}),
    });
    if (drained.status === 'done') {
      output.flush();
      return 'continue';
    }
    if (drained.status === 'stopped') {
      output.flush();
      return 'stopped';
    }
    if (drained.status === 'failed') {
      throw new Error(drained.message);
    }
    if (drained.status === 'not_active') {
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
      { terminalReleaseMode: ctx.terminalReleaseMode, output },
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

  const syncResult = await actorService.sendAndSync(activeState.id, steps, {
    type: config.eventType,
  });
  if (!syncResult) {
    throw new Error('Failed to dispatch transition to runbook engine');
  }
  const { state: actorUpdatedState, snapshot: rawSnapshot } = syncResult;

  const ensuredAfterTransition = await lifecycleService.ensureActiveEntry(
    activeState.id,
    previousState,
    actorUpdatedState,
  );
  const updatedState = ensuredAfterTransition.state;

  const commandSink: TransitionEventSink = {
    onErrorOccurred: (payload: ErrorOccurredPayload) => {
      output.error(payload.message, payload.code);
    },
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
    sessionService: ctx.sessionService,
    sink: commandSink,
    runbookId: activeState.id,
    steps,
    currentStep,
    previousState,
    updatedState,
    snapshot: rawSnapshot,
    result: config.lastResult,
    computeActionResult: config.computeActionResult,
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
    { terminalReleaseMode: ctx.terminalReleaseMode, output },
  );

  output.flush();
  if (loopResult === 'stopped') {
    return 'stopped';
  }
  return 'continue';
}
