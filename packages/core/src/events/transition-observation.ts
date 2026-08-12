import type { ActionBlockData } from '../cli/types.js';
import {
  asTerminalSnapshotOrDefault,
  isRunbookComplete,
  isRunbookStopped,
} from '../runbook/snapshot-utils.js';
import { countNumberedSteps } from '../runbook/step-utils.js';
import { stepIdToString, type StepId } from '../runbook/step-id.js';
import { buildStepPosition, derivePositionAt } from '../runbook/targeting.js';
import {
  deriveStoppedReason,
  deriveTransitionMessage,
  extractInternalFailureMessage,
  extractLastAction,
  extractLastMessage,
  extractRetryDisplayCount,
  extractRetryMax,
  isInternalFailureLastAction,
  parseActionType,
  type ActionType,
} from '../runbook/transition-kernel.js';
import { isAggregationLastAction } from '../runbook/last-action.js';
import type { ResolvedStep, RunbookState } from '../runbook/types.js';
import type {
  ErrorOccurredPayload,
  RunbookCompletedPayload,
  RunbookStoppedPayload,
  StepPosition,
  StepTransitionedPayload,
} from './types.js';

/** Payload event variants derived after a machine transition has synchronized. */
export type TransitionObservationEvent =
  | { readonly type: 'ERROR_OCCURRED'; readonly payload: ErrorOccurredPayload }
  | { readonly type: 'STEP_TRANSITIONED'; readonly payload: StepTransitionedPayload }
  | { readonly type: 'RUNBOOK_COMPLETED'; readonly payload: RunbookCompletedPayload }
  | { readonly type: 'RUNBOOK_STOPPED'; readonly payload: RunbookStoppedPayload };

/** Input for deriving post-transition observation payloads. */
export interface TransitionObservationInput {
  /** Resolved runbook steps used for position calculations. */
  readonly steps: readonly ResolvedStep[];
  /** The execution unit whose result caused the transition. */
  readonly currentStep: ResolvedStep;
  /** Persisted state before the machine event was sent. */
  readonly previousState: RunbookState;
  /** Persisted state after actor synchronization and active-entry bookkeeping. */
  readonly updatedState: RunbookState;
  /** Raw XState snapshot returned by `RunbookActorService.sendAndSync()`. */
  readonly snapshot: unknown;
  /** Result signal that triggered the machine transition. */
  readonly result: 'pass' | 'fail';
  /** Optional display-result policy for direct `rd pass` / `rd fail` commands. */
  readonly computeActionResult?: (actionType: ActionType) => boolean;
  /** Display command associated with the transition, when command-driven. */
  readonly command?: string;
}

/** Core-derived observation result for a synchronized machine transition. */
export type TransitionObservation =
  | {
      readonly status: 'continue';
      readonly state: RunbookState;
      readonly action: ActionType;
      readonly from: string;
      readonly at: string;
      readonly events: readonly TransitionObservationEvent[];
    }
  | {
      readonly status: 'done';
      readonly action: ActionType;
      readonly from: string;
      readonly at: string;
      readonly message?: string;
      readonly events: readonly TransitionObservationEvent[];
    }
  | {
      readonly status: 'stopped';
      readonly action: ActionType;
      readonly from: string;
      readonly at: string;
      readonly message?: string;
      readonly events: readonly TransitionObservationEvent[];
    };

interface TransitionPositions {
  readonly from: StepPosition;
  readonly to: StepPosition;
}

function buildTransitionPositions(
  previousState: RunbookState,
  updatedState: RunbookState,
  steps: readonly ResolvedStep[],
): TransitionPositions {
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

function buildStepTransitionedPayload({
  actionType,
  positions,
  actionResult,
  command,
  retryAttempt,
  retryMax,
  aggregated,
}: {
  readonly actionType: ActionType;
  readonly positions: TransitionPositions;
  readonly actionResult: boolean;
  readonly command?: string;
  readonly retryAttempt: number;
  readonly retryMax: number;
  readonly aggregated: boolean;
}): StepTransitionedPayload {
  const toPos = positions.to;
  return {
    action: actionType,
    from: derivePositionAt(positions.from),
    at: derivePositionAt(toPos),
    result: actionResult ? 'PASS' : 'FAIL',
    ...(command ? { command } : {}),
    ...(actionType === 'RETRY' ? { retryAttempt, retryMax } : {}),
    ...(toPos.for ? { forIndex: toPos.for.index, forEnd: toPos.for.end } : {}),
    ...(aggregated ? { aggregated: true } : {}),
  };
}

/**
 * Derive post-transition event payloads from the synchronized machine snapshot.
 *
 * This function performs no persistence and no external side effects. Front ends
 * consume the returned event list and render it through their own emitters.
 *
 * @param input - Previous state, updated state, snapshot, steps, and triggering result
 * @returns Typed observation result and ordered payload events
 */
export function deriveTransitionObservation(
  input: TransitionObservationInput,
): TransitionObservation {
  const lastAction = extractLastAction(input.snapshot);
  const actionType = parseActionType(lastAction);
  const retryMax = extractRetryMax(input.snapshot);
  const retryAttempt = extractRetryDisplayCount(input.snapshot, input.updatedState.retryCount);
  const aggregated = isAggregationLastAction(lastAction);
  const positions = buildTransitionPositions(input.previousState, input.updatedState, input.steps);
  const from = derivePositionAt(positions.from);
  const at = derivePositionAt(positions.to);
  const actionResult = input.computeActionResult
    ? input.computeActionResult(actionType)
    : input.result === 'pass';
  const events: TransitionObservationEvent[] = [];

  if (!isInternalFailureLastAction(lastAction)) {
    events.push({
      type: 'STEP_TRANSITIONED',
      payload: buildStepTransitionedPayload({
        actionType,
        positions,
        actionResult,
        command: input.command,
        retryAttempt,
        retryMax,
        aggregated,
      }),
    });
  }

  const terminalSnapshot = asTerminalSnapshotOrDefault(input.snapshot);
  const complete = isRunbookComplete(terminalSnapshot);
  const stopped = isRunbookStopped(terminalSnapshot);

  if (complete) {
    const message =
      extractLastMessage(input.snapshot) ??
      deriveTransitionMessage(input.result, input.currentStep, input.previousState.retryCount);
    events.push({
      type: 'RUNBOOK_COMPLETED',
      payload: {
        message,
        finalPosition: positions.to,
      },
    });
    return { status: 'done', action: actionType, from, at, message, events };
  }

  if (stopped) {
    const message =
      extractInternalFailureMessage(lastAction) ??
      extractLastMessage(input.snapshot) ??
      deriveTransitionMessage(input.result, input.currentStep, input.previousState.retryCount);
    const reason = deriveStoppedReason(lastAction);

    if (isInternalFailureLastAction(lastAction)) {
      const internalMessage = extractInternalFailureMessage(lastAction);
      if (internalMessage !== undefined) {
        events.push({
          type: 'ERROR_OCCURRED',
          payload: {
            message: internalMessage,
            ...(lastAction.type === 'RETRY_ERROR' ? { code: lastAction.code } : {}),
            ...(lastAction.type === 'INLINE_LAUNCH_FAILED'
              ? {
                  code:
                    lastAction.reason === 'inline_launch_forbidden'
                      ? 'INLINE_LAUNCH_FORBIDDEN'
                      : 'INLINE_CHILD_LAUNCH_FAILED',
                }
              : {}),
          },
        });
      }
    }

    events.push({
      type: 'RUNBOOK_STOPPED',
      payload: {
        message,
        position: positions.from,
        reason,
      },
    });
    return { status: 'stopped', action: actionType, from, at, message, events };
  }

  return {
    status: 'continue',
    state: input.updatedState,
    action: actionType,
    from,
    at,
    events,
  };
}

/** Input for deriving a terminal event from an authoritative drain status. */
export interface TerminalDrainObservationInput {
  /** Resolved runbook steps used for position calculations. */
  readonly steps: readonly ResolvedStep[];
  /** The execution unit whose completion drove the terminal drain. */
  readonly currentStep: ResolvedStep;
  /** Persisted state before the terminal completion was applied. */
  readonly previousState: RunbookState;
  /** Persisted state after the terminal completion was applied. */
  readonly updatedState: RunbookState;
  /** Raw XState snapshot for the terminal completion (used for message/reason). */
  readonly snapshot: unknown;
  /** Authoritative terminal status reported by the drain. */
  readonly status: 'done' | 'stopped';
  /** Result signal that triggered the completion. */
  readonly result: 'pass' | 'fail';
}

/**
 * Derive the terminal observation event for a drain pass that reached a terminal
 * lifecycle through the persisted `state.lifecycle` even though the matching
 * per-completion snapshot did not surface a terminal status.
 *
 * `RunbookCompletionService.applyNextResolvedCompletion` derives terminal from
 * the applied completion's `state.lifecycle` (the machine context's assigned
 * lifecycle field), while {@link deriveTransitionObservation} derives terminal
 * from the XState snapshot's top-level `status`/`value`. These two signals are
 * independent and can legitimately diverge, so when the apply is the
 * authoritative terminal source the seam still needs the matching terminal event
 * to keep agent-facing output symmetric with the terminal release.
 *
 * @param input - Steps, the completed unit, surrounding states, snapshot,
 *   authoritative terminal status, and the triggering result
 * @returns The `RUNBOOK_COMPLETED` or `RUNBOOK_STOPPED` event matching `status`
 */
export function deriveTerminalDrainObservationEvent(
  input: TerminalDrainObservationInput,
): TransitionObservationEvent {
  const positions = buildTransitionPositions(input.previousState, input.updatedState, input.steps);
  if (input.status === 'done') {
    const message =
      extractLastMessage(input.snapshot) ??
      deriveTransitionMessage(input.result, input.currentStep, input.previousState.retryCount);
    return {
      type: 'RUNBOOK_COMPLETED',
      payload: { message, finalPosition: positions.to },
    };
  }
  const lastAction = extractLastAction(input.snapshot);
  const message =
    extractInternalFailureMessage(lastAction) ??
    extractLastMessage(input.snapshot) ??
    deriveTransitionMessage(input.result, input.currentStep, input.previousState.retryCount);
  const reason = deriveStoppedReason(lastAction);
  return {
    type: 'RUNBOOK_STOPPED',
    payload: { message, position: positions.from, reason },
  };
}

/** Input for reconciling a fenced observation against its committed lifecycle. */
export interface FencedTerminalReconciliationInput {
  /** Observation derived from the committed snapshot. */
  readonly observation: TransitionObservation;
  /** All resolved runbook steps. */
  readonly steps: readonly ResolvedStep[];
  /** Step the transition started from. */
  readonly currentStep: ResolvedStep;
  /** Persisted state before the machine event was sent. */
  readonly previousState: RunbookState;
  /** Committed state whose `lifecycle` decided the terminal release. */
  readonly updatedState: RunbookState;
  /** Raw XState snapshot for the committed mutation. */
  readonly snapshot: unknown;
  /** Result signal that triggered the machine transition. */
  readonly result: 'pass' | 'fail';
}

/** A fenced observation aligned with the lifecycle the fence actually released on. */
export interface ReconciledFencedTerminal {
  /** Authoritative status: terminal whenever the committed lifecycle is terminal. */
  readonly status: 'continue' | 'done' | 'stopped';
  /** Observation events, topped up with the terminal event when one was missing. */
  readonly events: readonly TransitionObservationEvent[];
}

/**
 * Align a fenced transition's reported status with the lifecycle it released on.
 *
 * The execution fence folds its terminal session release into the same
 * transaction as the state write and decides it from the committed
 * `state.lifecycle`, while the reported status comes from
 * {@link deriveTransitionObservation}, which reads the snapshot's top-level
 * `status`/`value`. This keeps the two answers consistent: whatever the fence
 * released on is what the caller is told.
 *
 * Reachability differs by caller, and the guard is deliberately kept at all of
 * them rather than only where divergence is proven:
 *
 * - Drain callers: divergence is real and documented. See
 *   {@link deriveTerminalDrainObservationEvent} — a drain derives terminal from
 *   the applied completion's `state.lifecycle` while the observation derives it
 *   from the snapshot, and the two are independent signals.
 * - Direct actor callers (`PASS`/`FAIL`/`EXECUTE_COMMAND`): not known to be
 *   reachable. `COMPLETE`/`STOPPED` are top-level `type: 'final'` states whose
 *   entry actions assign `context.lifecycle`, so entering them sets the
 *   terminal value, the terminal status, and the context field together. The
 *   guard asserts that invariant rather than repairing an observed defect.
 *
 * Only ever tops the observation UP to terminal, never down, so a caller whose
 * signals already agree is unaffected.
 *
 * @param input - The derived observation plus the context for a terminal event.
 * @returns The authoritative status and the events to emit.
 */
export function reconcileFencedTerminalObservation(
  input: FencedTerminalReconciliationInput,
): ReconciledFencedTerminal {
  if (input.observation.status !== 'continue') {
    return { status: input.observation.status, events: input.observation.events };
  }
  const lifecycle = input.updatedState.lifecycle;
  if (lifecycle !== 'completed' && lifecycle !== 'stopped') {
    return { status: 'continue', events: input.observation.events };
  }
  const status = lifecycle === 'completed' ? 'done' : 'stopped';
  return {
    status,
    events: [
      ...input.observation.events,
      deriveTerminalDrainObservationEvent({
        steps: input.steps,
        currentStep: input.currentStep,
        previousState: input.previousState,
        updatedState: input.updatedState,
        snapshot: input.snapshot,
        status,
        result: input.result,
      }),
    ],
  };
}

/** Input for deriving `rd goto` action display from core position helpers. */
export interface GotoActionBlockInput {
  /** All resolved runbook steps, used to calculate total numbered steps. */
  readonly steps: readonly ResolvedStep[];
  /** State before the GOTO machine event. */
  readonly previousState: RunbookState;
  /** State after the GOTO machine event. */
  readonly updatedState: RunbookState;
  /** Validated GOTO target supplied to the machine event. */
  readonly target: StepId;
}

/**
 * Derive the action block rendered by `rd goto`.
 *
 * @param input - Previous state, updated state, steps, and target
 * @returns Format-agnostic action block data for CLI rendering
 */
export function deriveGotoActionBlock(input: GotoActionBlockInput): ActionBlockData {
  const totalSteps = countNumberedSteps(input.steps);
  const from = buildStepPosition(
    input.previousState.step,
    totalSteps,
    input.previousState.substep,
    input.previousState.forStack,
  );
  const at = buildStepPosition(
    input.updatedState.step,
    totalSteps,
    input.updatedState.substep,
    input.updatedState.forStack,
  );
  return {
    action: `GOTO ${stepIdToString(input.target)}`,
    from: derivePositionAt(from),
    at: derivePositionAt(at),
  };
}
