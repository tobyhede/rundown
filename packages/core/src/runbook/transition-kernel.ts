import { evaluateFailCondition, evaluatePassCondition } from './transition-handler.js';
import type { LastAction, Step } from './types.js';

/**
 * Action type derived from structured LastAction.
 */
export type ActionType = 'GOTO' | 'RETRY' | 'CONTINUE' | 'COMPLETE' | 'STOP';

interface SnapshotContext {
  lastAction?: LastAction;
  retryMax?: number;
  iterationRetryCount?: number;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isLastAction(value: unknown): value is LastAction {
  if (!isObjectRecord(value) || typeof value.type !== 'string') return false;

  switch (value.type) {
    case 'START':
    case 'CONTINUE':
    case 'COMPLETE':
    case 'STOP':
    case 'RETRY':
    case 'NEXT':
    case 'BREAK':
      return true;
    case 'GOTO':
      if (typeof value.target !== 'string') return false;
      if ('substep' in value && value.substep !== undefined && typeof value.substep !== 'string') {
        return false;
      }
      if (
        'at' in value &&
        value.at !== undefined &&
        typeof value.at !== 'number' &&
        typeof value.at !== 'string'
      ) {
        return false;
      }
      return true;
    default:
      return false;
  }
}

/**
 * Extract the lastAction from an XState snapshot in a type-safe way.
 */
export function extractLastAction(snapshot: unknown): LastAction | undefined {
  if (
    snapshot &&
    typeof snapshot === 'object' &&
    'context' in snapshot &&
    snapshot.context &&
    typeof snapshot.context === 'object' &&
    'lastAction' in snapshot.context
  ) {
    const action = (snapshot.context as SnapshotContext).lastAction;
    return isLastAction(action) ? action : undefined;
  }
  return undefined;
}

/**
 * Extract the retryMax from an XState snapshot in a type-safe way.
 */
export function extractRetryMax(snapshot: unknown): number {
  if (
    snapshot &&
    typeof snapshot === 'object' &&
    'context' in snapshot &&
    snapshot.context &&
    typeof snapshot.context === 'object' &&
    'retryMax' in snapshot.context
  ) {
    return (snapshot.context as SnapshotContext).retryMax ?? 0;
  }
  return 0;
}

/**
 * Extract retry counter for RETRY action display.
 *
 * Iteration-level retry counts take precedence when present.
 */
export function extractRetryDisplayCount(snapshot: unknown, retryCount: number): number {
  if (
    snapshot &&
    typeof snapshot === 'object' &&
    'context' in snapshot &&
    snapshot.context &&
    typeof snapshot.context === 'object' &&
    'iterationRetryCount' in snapshot.context
  ) {
    const iterationRetryCount = (snapshot.context as SnapshotContext).iterationRetryCount ?? 0;
    if (iterationRetryCount > 0) return iterationRetryCount;
  }
  return retryCount;
}

/**
 * Extract the lastMessage from an XState snapshot.
 */
export function extractLastMessage(snapshot: unknown): string | undefined {
  if (
    snapshot &&
    typeof snapshot === 'object' &&
    'context' in snapshot &&
    snapshot.context &&
    typeof snapshot.context === 'object' &&
    'lastMessage' in snapshot.context
  ) {
    const msg = (snapshot.context as Record<string, unknown>).lastMessage;
    return typeof msg === 'string' ? msg : undefined;
  }
  return undefined;
}

/**
 * Format action for display, adding retry details.
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
 * Derive action type from structured LastAction.
 */
export function parseActionType(lastAction: LastAction | undefined): ActionType {
  if (!lastAction) return 'CONTINUE';
  switch (lastAction.type) {
    case 'GOTO':
      return 'GOTO';
    case 'RETRY':
      return 'RETRY';
    case 'COMPLETE':
      return 'COMPLETE';
    case 'STOP':
      return 'STOP';
    default:
      return 'CONTINUE';
  }
}

/**
 * Resolve fallback transition message from step transitions when snapshot has no message.
 */
export function deriveTransitionMessage(
  result: 'pass' | 'fail',
  step: Step,
  retryCount: number,
): string | undefined {
  return result === 'pass'
    ? evaluatePassCondition(step, retryCount).message
    : evaluateFailCondition(step, retryCount).message;
}
