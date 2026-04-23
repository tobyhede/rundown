import {
  asTerminalSnapshotOrDefault,
  buildStepPosition,
  countNumberedSteps,
  derivePositionAt,
  deriveTransitionMessage,
  extractLastAction,
  extractLastMessage,
  extractRetryDisplayCount,
  extractRetryMax,
  isRunbookComplete,
  isRunbookStopped,
  parseActionType,
  type ExecutionEventEmitter,
  type RunbookCompletedPayload,
  type RunbookState,
  type RunbookStateManager,
  type RunbookStoppedPayload,
  type SessionService,
  type ResolvedStep,
  type StepPosition,
  type StepTransitionedPayload,
} from '@rundown-org/core';

/** Side-effect policy applied when a runbook reaches a terminal state. */
export interface TerminalSideEffectsPolicy {
  /** Whether to pop the runbook from the session stack. */
  popRunbook: boolean;
}

/** Policy governing side effects for each terminal outcome. */
export interface TransitionOrchestrationPolicy {
  /** Side effects when the runbook completes successfully. */
  onComplete: TerminalSideEffectsPolicy;
  /** Side effects when the runbook is stopped (failure). */
  onStopped: TerminalSideEffectsPolicy;
}

/** Event sink for transition lifecycle events. */
export interface TransitionEventSink {
  /** Called when a step transition occurs. */
  onStepTransitioned(payload: StepTransitionedPayload): void;
  /** Called when the runbook completes successfully. */
  onRunbookCompleted(payload: RunbookCompletedPayload): void;
  /** Called when the runbook is stopped (failure). */
  onRunbookStopped(payload: RunbookStoppedPayload): void;
}

/**
 * Create a {@link TransitionEventSink} that delegates to an event emitter.
 *
 * @param emitter - Event emitter with an `emit` method for forwarding transition events
 * @returns TransitionEventSink that forwards step-transitioned, runbook-completed, and runbook-stopped events
 */
export function transitionSinkFromEmitter(
  emitter: Pick<ExecutionEventEmitter, 'emit'>,
): TransitionEventSink {
  return {
    onStepTransitioned: (payload) => {
      emitter.emit('STEP_TRANSITIONED', payload);
    },
    onRunbookCompleted: (payload) => {
      emitter.emit('RUNBOOK_COMPLETED', payload);
    },
    onRunbookStopped: (payload) => {
      emitter.emit('RUNBOOK_STOPPED', payload);
    },
  };
}

interface OrchestrateTransitionArgs {
  /** State manager for persisting runbook state updates. */
  manager: RunbookStateManager;
  /** Session service for managing the active runbook stack. */
  sessionService: SessionService;
  /** Event sink for emitting transition lifecycle events. */
  sink: TransitionEventSink;
  /** Unique identifier of the runbook being executed. */
  runbookId: string;
  /** All steps in the runbook, used for position calculations. */
  steps: ResolvedStep[];
  /** The step that was just evaluated. */
  currentStep: ResolvedStep;
  /** Runbook state before the transition was applied. */
  previousState: RunbookState;
  /** Runbook state after the XState machine processed the event. */
  updatedState: RunbookState;
  /** Raw XState snapshot after the transition, used to extract action and message. */
  snapshot: unknown;
  /** Whether the step passed or failed. */
  result: 'pass' | 'fail';
  /** Whether the action (command execution or prompt response) succeeded. */
  actionResult: boolean;
  /** Policy governing side effects for terminal outcomes. */
  policy: TransitionOrchestrationPolicy;
  /** The command string that triggered this transition, included in events. */
  command?: string;
}

/**
 * Result of orchestrating a single step transition.
 *
 * Discriminated union on `status`:
 * - `continue` — The runbook is still active; `state` holds the updated runbook state.
 * - `done` — The runbook completed successfully; `message` is the completion message.
 * - `stopped` — The runbook was stopped (failure); `message` is the stop reason.
 *
 * Common fields across all variants:
 * - `action` — The transition action type (e.g. "CONTINUE", "GOTO", "STOP").
 * - `from` — Qualified step position before the transition.
 * - `at` — Qualified step position after the transition.
 */
export type OrchestrateTransitionResult =
  | { status: 'continue'; state: RunbookState; action: string; from: string; at: string }
  | { status: 'done'; action: string; from: string; at: string; message?: string }
  | { status: 'stopped'; action: string; from: string; at: string; message?: string };

function buildTransitionPositions(
  previousState: RunbookState,
  updatedState: RunbookState,
  steps: ResolvedStep[],
): { from: StepPosition; to: StepPosition } {
  const totalSteps = countNumberedSteps(steps);
  return {
    from: buildStepPosition(
      previousState.step,
      totalSteps,
      previousState.substep,
      previousState.forStack,
    ),
    to: buildStepPosition(
      updatedState.step,
      totalSteps,
      updatedState.substep,
      updatedState.forStack,
    ),
  };
}

async function applyTerminalSideEffects(
  sessionService: SessionService,
  policy: TerminalSideEffectsPolicy,
): Promise<void> {
  if (policy.popRunbook) {
    await sessionService.popRunbook();
  }
}

/**
 * Persist transition state, emit transition/terminal events, and apply side effects.
 *
 * This is the shared transition application path for command-driven transitions
 * and execution-loop transitions.
 *
 * @param args - Transition context including state manager, step data, and side-effect policy.
 *   See {@link OrchestrateTransitionArgs} for field descriptions.
 * @returns A result indicating whether execution should continue, has completed, or was stopped.
 *   See {@link OrchestrateTransitionResult} for the discriminated union variants.
 */
export async function orchestrateTransition(
  args: OrchestrateTransitionArgs,
): Promise<OrchestrateTransitionResult> {
  const {
    manager,
    sessionService,
    sink,
    runbookId,
    steps,
    currentStep,
    previousState,
    updatedState,
    snapshot,
    result,
    actionResult,
    policy,
    command,
  } = args;

  const retryMax = extractRetryMax(snapshot);
  const lastAction = extractLastAction(snapshot);
  const retryDisplayCount = extractRetryDisplayCount(snapshot, updatedState.retryCount);
  const actionType = parseActionType(lastAction);
  const aggregated = lastAction?.aggregated === true;
  const positions = buildTransitionPositions(previousState, updatedState, steps);
  const fromStr = derivePositionAt(positions.from);
  const atStr = derivePositionAt(positions.to);

  await manager.update(runbookId, {
    lastAction,
    lastResult: result,
  });

  const toPos = positions.to;
  // RETRY_ERROR signals a machine-internal failure (retry hook threw /
  // invariant violated). It is already surfaced via ERROR_OCCURRED +
  // RUNBOOK_STOPPED (see execution.ts `applyResultTransition`). Emitting
  // it through STEP_TRANSITIONED would widen the external action enum
  // beyond the scenario schema (CONTINUE/DEFER/GOTO/STOP/COMPLETE/RETRY/
  // BREAK/NEXT — see packages/cli/src/schemas/scenarios.ts). The terminal
  // RUNBOOK_STOPPED emission below still fires.
  if (actionType !== 'RETRY_ERROR') {
    sink.onStepTransitioned({
      action: actionType,
      from: fromStr,
      at: atStr,
      result: actionResult ? 'PASS' : 'FAIL',
      command,
      ...(actionType === 'RETRY' ? { retryAttempt: retryDisplayCount, retryMax } : {}),
      ...(toPos.for ? { forIndex: toPos.for.index, forEnd: toPos.for.end } : {}),
      ...(aggregated ? { aggregated: true } : {}),
    });
  }

  const terminalSnapshot = asTerminalSnapshotOrDefault(snapshot);
  const isComplete = isRunbookComplete(terminalSnapshot);
  const isStopped = isRunbookStopped(terminalSnapshot);

  if (isComplete) {
    const message =
      extractLastMessage(snapshot) ??
      deriveTransitionMessage(result, currentStep, previousState.retryCount);

    await manager.update(runbookId, {
      lifecycle: 'completed',
    });
    sink.onRunbookCompleted({
      message,
      finalPosition: positions.to,
    });

    await applyTerminalSideEffects(sessionService, policy.onComplete);
    return { status: 'done', action: actionType, from: fromStr, at: atStr, message };
  }

  if (isStopped) {
    const message =
      extractLastMessage(snapshot) ??
      deriveTransitionMessage(result, currentStep, previousState.retryCount);

    await manager.update(runbookId, {
      lifecycle: 'stopped',
    });
    sink.onRunbookStopped({
      message,
      position: positions.from,
      reason: 'fail_transition',
    });

    await applyTerminalSideEffects(sessionService, policy.onStopped);
    return { status: 'stopped', action: actionType, from: fromStr, at: atStr, message };
  }

  const reloaded = await manager.load(runbookId);
  if (!reloaded) {
    return { status: 'stopped', action: actionType, from: fromStr, at: atStr };
  }

  return { status: 'continue', state: reloaded, action: actionType, from: fromStr, at: atStr };
}
