import {
  deriveTransitionObservation,
  type ActionType,
  type ErrorOccurredPayload,
  type ExecutionEventEmitter,
  type RunbookCompletedPayload,
  type RunbookState,
  type RunbookStoppedPayload,
  type ResolvedStep,
  type StepTransitionedPayload,
} from '@rundown-org/core';

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
      emitter.emit({ type: 'ERROR_OCCURRED', payload });
    },
    onStepTransitioned: (payload) => {
      emitter.emit({ type: 'STEP_TRANSITIONED', payload });
    },
    onRunbookCompleted: (payload) => {
      emitter.emit({ type: 'RUNBOOK_COMPLETED', payload });
    },
    onRunbookStopped: (payload) => {
      emitter.emit({ type: 'RUNBOOK_STOPPED', payload });
    },
  };
}

interface OrchestrateTransitionArgs {
  /** Event sink for emitting transition lifecycle events. */
  sink: TransitionEventSink;
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

/**
 * Emit core-projected transition events for one applied transition.
 *
 * This is the shared transition application path for command-driven transitions
 * and execution-loop transitions. Payload derivation is delegated to the core
 * `deriveTransitionObservation` projection; this function is render-only.
 *
 * It performs no session release, which is why it is synchronous. Terminal
 * release is committed inside core's fenced mutation, in the same transaction
 * as the terminal state, so an orchestrator that released as well would release
 * the run twice — once inside the owned transaction and once outside it.
 *
 * @param args - Transition context including state, snapshot, and steps.
 *   See {@link OrchestrateTransitionArgs} for field descriptions.
 * @returns A result indicating whether execution should continue, has completed, or was stopped.
 *   See {@link OrchestrateTransitionResult} for the discriminated union variants.
 */
export function orchestrateTransition(
  args: OrchestrateTransitionArgs,
): OrchestrateTransitionResult {
  const { sink } = args;
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
    return {
      status: 'done',
      action: observation.action,
      from: observation.from,
      at: observation.at,
      message: observation.message,
    };
  }

  if (observation.status === 'stopped') {
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
