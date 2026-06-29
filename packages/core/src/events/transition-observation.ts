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
 * `RunbookCompletionService.drainResolvedCompletions` derives terminal from the
 * applied completion's `state.lifecycle` (the machine context's assigned
 * lifecycle field), while {@link deriveTransitionObservation} derives terminal
 * from the XState snapshot's top-level `status`/`value`. These two signals are
 * independent and can legitimately diverge, so when the drain is the
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
