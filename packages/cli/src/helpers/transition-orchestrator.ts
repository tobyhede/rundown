import {
  deriveTransitionObservation,
  type ActionType,
  type ErrorOccurredPayload,
  type ExecutionEventEmitter,
  type RunbookCompletedPayload,
  type RunbookState,
  type RunbookStoppedPayload,
  type RunId,
  type SessionService,
  type ResolvedStep,
  type StepTransitionedPayload,
} from '@rundown-org/core';

/** Side-effect policy applied when a runbook reaches a terminal state. */
export interface TerminalSideEffectsPolicy {
  /** Whether to release this runbook from all session targeting structures. */
  releaseRunbook: boolean;
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
  /** Called when a machine-internal transition failure should be surfaced. */
  onErrorOccurred?(payload: ErrorOccurredPayload): void;
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
 * @returns TransitionEventSink that forwards error, step-transitioned, runbook-completed, and runbook-stopped events
 */
export function transitionSinkFromEmitter(
  emitter: Pick<ExecutionEventEmitter, 'emit'>,
): TransitionEventSink {
  return {
    onErrorOccurred: (payload) => {
      emitter.emit('ERROR_OCCURRED', payload);
    },
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
  /** Session service for managing the active runbook stack. */
  sessionService: SessionService;
  /** Event sink for emitting transition lifecycle events. */
  sink: TransitionEventSink;
  /** Unique identifier of the runbook being executed. */
  runbookId: RunId;
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
  /** Optional display-result policy for direct pass/fail commands. */
  computeActionResult?: (actionType: ActionType) => boolean;
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

async function applyTerminalSideEffects(
  sessionService: SessionService,
  policy: TerminalSideEffectsPolicy,
  runbookId: RunId,
): Promise<void> {
  if (policy.releaseRunbook) {
    // This is the natural pass/fail transition path (explicit teardown —
    // abort/stop/complete — releases claims directly elsewhere). When a claimed
    // child completes here, retain its claim as a terminal tombstone so
    // `rd pass/fail --claim-id` can confirm-or-conflict against the outcome.
    // For an unclaimed top-level runbook there is no matching claim, so this is
    // a no-op. Mirrors `applyExecutionTerminalRelease` in execution.ts.
    await sessionService.releaseRunbook(runbookId, { retainClaimsAsTerminal: true });
  }
}

/**
 * Emit core-projected transition events and apply terminal side effects.
 *
 * This is the shared transition application path for command-driven transitions
 * and execution-loop transitions. Payload derivation is delegated to the core
 * `deriveTransitionObservation` projection; this function is render-only.
 *
 * @param args - Transition context including state, snapshot, steps, and side-effect policy.
 *   See {@link OrchestrateTransitionArgs} for field descriptions.
 * @returns A result indicating whether execution should continue, has completed, or was stopped.
 *   See {@link OrchestrateTransitionResult} for the discriminated union variants.
 */
export async function orchestrateTransition(
  args: OrchestrateTransitionArgs,
): Promise<OrchestrateTransitionResult> {
  const { sessionService, sink, runbookId, policy } = args;
  const observation = deriveTransitionObservation({
    steps: args.steps,
    currentStep: args.currentStep,
    previousState: args.previousState,
    updatedState: args.updatedState,
    snapshot: args.snapshot,
    result: args.result,
    computeActionResult: args.computeActionResult,
    command: args.command,
  });

  for (const event of observation.events) {
    switch (event.type) {
      case 'ERROR_OCCURRED':
        sink.onErrorOccurred?.(event.payload);
        break;
      case 'STEP_TRANSITIONED':
        sink.onStepTransitioned(event.payload);
        break;
      case 'RUNBOOK_COMPLETED':
        sink.onRunbookCompleted(event.payload);
        break;
      case 'RUNBOOK_STOPPED':
        sink.onRunbookStopped(event.payload);
        break;
      default: {
        const _exhaustive: never = event;
        return _exhaustive;
      }
    }
  }

  if (observation.status === 'done') {
    await applyTerminalSideEffects(sessionService, policy.onComplete, runbookId);
    return {
      status: 'done',
      action: observation.action,
      from: observation.from,
      at: observation.at,
      message: observation.message,
    };
  }

  if (observation.status === 'stopped') {
    await applyTerminalSideEffects(sessionService, policy.onStopped, runbookId);
    return {
      status: 'stopped',
      action: observation.action,
      from: observation.from,
      at: observation.at,
      message: observation.message,
    };
  }

  return {
    status: 'continue',
    state: observation.state,
    action: observation.action,
    from: observation.from,
    at: observation.at,
  };
}
