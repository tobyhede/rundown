import { evaluateFailCondition, evaluatePassCondition } from './transition-handler.js';
import type { InternalFailureLastAction, LastAction, Step, ResolvedStep } from './types.js';
import { isLastAction } from './last-action.js';

/**
 * Public stopped-reason codes attached to terminal `RUNBOOK_STOPPED` events.
 *
 * Duplicated locally (rather than imported from `../events/types.js`) to keep
 * `transition-kernel.ts` free of an event-layer dependency. The CLI mapping
 * layer narrows `RunbookStoppedPayload['reason']` through this type.
 */
type StoppedReason =
  | 'policy_denied'
  | 'command_execution_failed'
  | 'fail_transition'
  | 'user_abort'
  | 'delegation_resolution_failed'
  | 'nested_delegation_forbidden'
  | 'inline_launch_failed'
  | 'inline_launch_forbidden'
  | 'retry_error_failed'
  | 'output_capture_failed'
  | 'artifact_resolution_failed'
  | 'for_resolution_failed';

/**
 * Action type derived from structured LastAction.
 *
 * `RETRY_ERROR` is a machine-internal-failure signal emitted when the retry
 * hook cannot complete — `retryDelegation` returned `{ status: 'error' }`,
 * or a retry-hook invariant (missing active frame, missing canonical at)
 * was violated. It is distinct from `STOP` (a pure domain action from
 * authored STOP transitions or `rd stop`): the CLI orchestrator emits
 * `ERROR_OCCURRED` before the terminal RUNBOOK_STOPPED event.
 */
export type ActionType =
  | 'START'
  | 'GOTO'
  | 'RETRY'
  | 'RETRY_ERROR'
  | 'OUTPUT_CAPTURE_FAILED'
  | 'ARTIFACT_RESOLUTION_FAILED'
  | 'FOR_RESOLUTION_FAILED'
  | 'POLICY_DENIED'
  | 'COMMAND_EXECUTION_FAILED'
  | 'DELEGATION_ISSUANCE_FAILED'
  | 'INLINE_LAUNCH_FAILED'
  | 'CONTINUE'
  | 'DEFER'
  | 'COMPLETE'
  | 'STOP'
  | 'NEXT'
  | 'BREAK';

interface SnapshotContext {
  lastAction?: LastAction;
  retryMax?: number;
  iterationRetryCount?: number;
}

/**
 * Narrow an XState snapshot to its context object.
 *
 * @param snapshot - Raw XState snapshot object to inspect
 * @returns The snapshot context if valid, otherwise undefined
 */
function narrowSnapshotContext(snapshot: unknown): SnapshotContext | undefined {
  if (
    snapshot &&
    typeof snapshot === 'object' &&
    'context' in snapshot &&
    snapshot.context &&
    typeof snapshot.context === 'object'
  ) {
    return snapshot.context;
  }
  return undefined;
}

/**
 * Extract the lastAction from an XState snapshot in a type-safe way.
 *
 * @param snapshot - Raw XState snapshot object to inspect
 * @returns The validated LastAction if present in the snapshot context, otherwise undefined
 */
export function extractLastAction(snapshot: unknown): LastAction | undefined {
  const ctx = narrowSnapshotContext(snapshot);
  if (ctx && 'lastAction' in ctx) {
    return isLastAction(ctx.lastAction) ? ctx.lastAction : undefined;
  }
  return undefined;
}

/**
 * Extract the retryMax from an XState snapshot in a type-safe way.
 *
 * @param snapshot - Raw XState snapshot object to inspect
 * @returns The retry limit from the snapshot context, or 0 if not present
 */
export function extractRetryMax(snapshot: unknown): number {
  const ctx = narrowSnapshotContext(snapshot);
  if (ctx && 'retryMax' in ctx && typeof ctx.retryMax === 'number') {
    return ctx.retryMax;
  }
  return 0;
}

/**
 * Extract retry counter for RETRY action display.
 *
 * Iteration-level retry counts take precedence when present.
 *
 * @param snapshot - Raw XState snapshot object to inspect
 * @param retryCount - Fallback retry count from persisted state
 * @returns The iteration-level retry count if positive, otherwise the fallback retryCount
 */
export function extractRetryDisplayCount(snapshot: unknown, retryCount: number): number {
  const ctx = narrowSnapshotContext(snapshot);
  if (ctx && 'iterationRetryCount' in ctx && typeof ctx.iterationRetryCount === 'number') {
    const iterationRetryCount = ctx.iterationRetryCount;
    if (iterationRetryCount > 0) return iterationRetryCount;
  }
  return retryCount;
}

/**
 * Extract the lastMessage from an XState snapshot.
 *
 * @param snapshot - Raw XState snapshot object to inspect
 * @returns The last message string if present, otherwise undefined
 */
export function extractLastMessage(snapshot: unknown): string | undefined {
  const ctx = narrowSnapshotContext(snapshot);
  if (ctx && 'lastMessage' in ctx) {
    const msg = (ctx as Record<string, unknown>).lastMessage;
    return typeof msg === 'string' ? msg : undefined;
  }
  return undefined;
}

/**
 * Format action for display, adding retry details.
 *
 * @param lastAction - The structured action to format, or undefined for default CONTINUE
 * @param retryCount - Current retry attempt number
 * @param retryMax - Maximum retry attempts allowed
 * @returns Human-readable action string (e.g. "RETRY (2/3)", "GOTO 5.1")
 */
export function formatActionForDisplay(
  lastAction: LastAction | undefined,
  retryCount: number,
  retryMax: number,
): string {
  if (!lastAction) return 'CONTINUE';

  switch (lastAction.type) {
    case 'RETRY':
      return `RETRY (${String(retryCount)}/${String(retryMax)})`;
    case 'GOTO': {
      const gotoTarget = lastAction.substep
        ? `GOTO ${lastAction.target}.${lastAction.substep}`
        : `GOTO ${lastAction.target}`;
      return lastAction.at !== undefined ? `${gotoTarget} AT ${String(lastAction.at)}` : gotoTarget;
    }
    default:
      return lastAction.type;
  }
}

/**
 * Format a transition event payload's action for display.
 *
 * Reconstructs the human-readable action string from the canonical
 * ActionType and structured metadata fields.
 *
 * @param action - Canonical action type
 * @param at - Destination step ID (used for GOTO display)
 * @param retryAttempt - Current retry attempt (for RETRY display)
 * @param retryMax - Maximum retries (for RETRY display)
 * @param forIndex - FOR loop iteration (for GOTO AT display)
 * @returns Human-readable action string
 */
export function formatTransitionAction(
  action: ActionType,
  at?: string,
  retryAttempt?: number,
  retryMax?: number,
  forIndex?: number,
): string {
  switch (action) {
    case 'RETRY':
      return retryAttempt !== undefined && retryMax !== undefined
        ? `RETRY (${String(retryAttempt)}/${String(retryMax)})`
        : 'RETRY';
    case 'GOTO': {
      const base = at ? `GOTO ${at}` : 'GOTO';
      return forIndex !== undefined ? `${base} AT ${String(forIndex)}` : base;
    }
    default:
      return action;
  }
}

/**
 * Derive action type from structured LastAction.
 *
 * @param lastAction - The structured action to classify, or undefined for default CONTINUE
 * @returns The canonical ActionType category for the given action
 */
export function parseActionType(lastAction: LastAction | undefined): ActionType {
  // Absent lastAction is the neutral pre-action state. This is intentionally
  // distinct from an explicit 'START' tag, which the machine emits to mark
  // initial entry — the latter must propagate as itself.
  if (!lastAction) return 'CONTINUE';
  switch (lastAction.type) {
    case 'START':
      return 'START';
    case 'GOTO':
      return 'GOTO';
    case 'RETRY':
      return 'RETRY';
    case 'RETRY_ERROR':
      return 'RETRY_ERROR';
    case 'OUTPUT_CAPTURE_FAILED':
      return 'OUTPUT_CAPTURE_FAILED';
    case 'ARTIFACT_RESOLUTION_FAILED':
      return 'ARTIFACT_RESOLUTION_FAILED';
    case 'FOR_RESOLUTION_FAILED':
      return 'FOR_RESOLUTION_FAILED';
    case 'POLICY_DENIED':
      return 'POLICY_DENIED';
    case 'COMMAND_EXECUTION_FAILED':
      return 'COMMAND_EXECUTION_FAILED';
    case 'DELEGATION_ISSUANCE_FAILED':
      return 'DELEGATION_ISSUANCE_FAILED';
    case 'INLINE_LAUNCH_FAILED':
      return 'INLINE_LAUNCH_FAILED';
    case 'DEFER':
      return 'DEFER';
    case 'COMPLETE':
      return 'COMPLETE';
    case 'STOP':
      return 'STOP';
    case 'NEXT':
      return 'NEXT';
    case 'BREAK':
      return 'BREAK';
    case 'CONTINUE':
      return 'CONTINUE';
    default: {
      // Exhaustiveness check: if a future LastAction variant is added
      // without a corresponding case, the type system catches it here.
      const _exhaustive: never = lastAction;
      return _exhaustive;
    }
  }
}

/**
 * Resolve fallback transition message from step transitions when snapshot has no message.
 *
 * @param result - Whether the step passed or failed
 * @param step - The step whose transitions to evaluate for a message
 * @param retryCount - Current retry count, used to evaluate retry-gated transitions
 * @returns The transition message if the matching condition provides one, otherwise undefined
 */
export function deriveTransitionMessage(
  result: 'pass' | 'fail',
  step: Step | ResolvedStep,
  retryCount: number,
): string | undefined {
  return result === 'pass'
    ? evaluatePassCondition(step, retryCount).message
    : evaluateFailCondition(step, retryCount).message;
}

/**
 * True when the action represents a machine-internal failure signal rather
 * than an authored runbook action.
 *
 * @param lastAction - Last action extracted from a machine snapshot
 * @returns true for internal failure variants
 */
export function isInternalFailureLastAction(
  lastAction: LastAction | undefined,
): lastAction is InternalFailureLastAction {
  return (
    lastAction?.type === 'RETRY_ERROR' ||
    lastAction?.type === 'OUTPUT_CAPTURE_FAILED' ||
    lastAction?.type === 'ARTIFACT_RESOLUTION_FAILED' ||
    lastAction?.type === 'FOR_RESOLUTION_FAILED' ||
    lastAction?.type === 'COMMAND_EXECUTION_FAILED' ||
    lastAction?.type === 'DELEGATION_ISSUANCE_FAILED' ||
    lastAction?.type === 'INLINE_LAUNCH_FAILED'
  );
}

/**
 * Derive a public stopped reason from a typed lastAction.
 *
 * Maps machine-internal failure variants to their corresponding public reason
 * codes; everything else falls through to the generic `fail_transition` so
 * authored STOP actions still report the historical reason.
 *
 * @param lastAction - Last action extracted from the terminal snapshot
 * @returns Public RUNBOOK_STOPPED reason
 */
export function deriveStoppedReason(lastAction: LastAction | undefined): StoppedReason {
  if (lastAction?.type === 'POLICY_DENIED') return 'policy_denied';
  if (lastAction?.type === 'COMMAND_EXECUTION_FAILED') return 'command_execution_failed';
  if (lastAction?.type === 'RETRY_ERROR') return 'retry_error_failed';
  if (lastAction?.type === 'OUTPUT_CAPTURE_FAILED') return 'output_capture_failed';
  if (lastAction?.type === 'ARTIFACT_RESOLUTION_FAILED') {
    return 'artifact_resolution_failed';
  }
  if (lastAction?.type === 'FOR_RESOLUTION_FAILED') return 'for_resolution_failed';
  if (lastAction?.type === 'DELEGATION_ISSUANCE_FAILED') return lastAction.reason;
  if (lastAction?.type === 'INLINE_LAUNCH_FAILED') return lastAction.reason;
  return 'fail_transition';
}

/**
 * Extract a user-facing terminal failure message from typed internal failures.
 *
 * @param lastAction - Last action extracted from the terminal snapshot
 * @returns Message for internal failures, otherwise undefined
 */
export function extractInternalFailureMessage(
  lastAction: LastAction | undefined,
): string | undefined {
  if (lastAction?.type === 'COMMAND_EXECUTION_FAILED') return lastAction.message;
  if (lastAction?.type === 'OUTPUT_CAPTURE_FAILED') return lastAction.message;
  if (lastAction?.type === 'ARTIFACT_RESOLUTION_FAILED') return lastAction.message;
  if (lastAction?.type === 'FOR_RESOLUTION_FAILED') return lastAction.message;
  if (lastAction?.type === 'DELEGATION_ISSUANCE_FAILED') return lastAction.message;
  if (lastAction?.type === 'INLINE_LAUNCH_FAILED') return lastAction.message;
  if (lastAction?.type === 'RETRY_ERROR') return lastAction.message;
  return undefined;
}
