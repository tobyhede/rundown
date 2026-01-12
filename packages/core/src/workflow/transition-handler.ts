import type { Step, SubstepState, Action, NonRetryAction, StepId, Transitions } from './types.js';

/**
 * Result of evaluating a step condition (PASS or FAIL).
 *
 * Indicates what action should be taken based on the condition evaluation:
 * - retry: Increment retry count and re-attempt the step
 * - stopped: Halt the workflow (with optional message)
 * - goto: Jump to a specific step
 * - continue: Proceed to the next step
 * - complete: Mark the workflow as complete
 */
export interface ConditionResult {
  /** The action to take based on the condition evaluation */
  action: 'retry' | 'stopped' | 'goto' | 'continue' | 'complete';
  /** New retry count (only set when action is 'retry') */
  newRetryCount?: number;
  /** Target step for GOTO action */
  gotoTarget?: StepId;
  /** Message to display (typically for STOP action) */
  message?: string;
}

/**
 * Evaluate the FAIL condition for a step.
 *
 * Determines the appropriate action when a step fails based on its
 * defined FAIL transition (RETRY, STOP, GOTO, CONTINUE, or COMPLETE).
 *
 * @param step - The step whose FAIL condition to evaluate
 * @param currentRetryCount - The current retry count for this step
 * @returns A ConditionResult indicating the action to take
 */
export function evaluateFailCondition(
  step: Step,
  currentRetryCount: number
): ConditionResult {
  if (!step.transitions) {
    return {
      action: 'stopped',
      message: 'No FAIL condition defined for step'
    };
  }

  const failAction = step.transitions.fail.action;

  switch (failAction.type) {
    case 'RETRY': {
      const newCount = currentRetryCount + 1;

      if (newCount > failAction.max) {
        return evaluateNonRetryAction(failAction.then);
      }

      return {
        action: 'retry',
        newRetryCount: newCount
      };
    }

    case 'STOP':
      return {
        action: 'stopped',
        message: failAction.message
      };

    case 'GOTO':
      return {
        action: 'goto',
        gotoTarget: failAction.target
      };

    case 'CONTINUE':
    case 'COMPLETE':
      return { action: 'continue' };

    default:
      return {
        action: 'stopped',
        message: 'Unknown FAIL action'
      };
  }
}

/**
 * Evaluate the PASS condition for a step.
 *
 * Determines the appropriate action when a step passes based on its
 * defined PASS transition (COMPLETE, GOTO, STOP, CONTINUE, or RETRY).
 *
 * @param step - The step whose PASS condition to evaluate
 * @returns A ConditionResult indicating the action to take
 */
export function evaluatePassCondition(step: Step): ConditionResult {
  if (!step.transitions) {
    return { action: 'continue' };
  }

  const passAction = step.transitions.pass.action;

  switch (passAction.type) {
    case 'COMPLETE':
      return { action: 'complete' };

    case 'GOTO':
      return {
        action: 'goto',
        gotoTarget: passAction.target
      };

    case 'STOP':
      return {
        action: 'stopped',
        message: passAction.message
      };

    case 'CONTINUE':
    case 'RETRY':
      return { action: 'continue' };

    default:
      return { action: 'continue' };
  }
}

/**
 * Evaluate aggregation conditions across substep results.
 *
 * When all substeps are complete, determines the parent step's outcome
 * based on the aggregation mode (ALL or ANY) defined in transitions:
 * - ALL mode: Pass if all substeps passed, fail if any failed
 * - ANY mode: Pass if any substep passed, fail only if all failed
 *
 * @param substepStates - The current state of all substeps
 * @param transitions - The transitions defining aggregation behavior (all/any)
 * @returns A ConditionResult if all substeps are done, null otherwise
 */
export function evaluateSubstepAggregation(
  substepStates: readonly SubstepState[],
  transitions: Transitions
): ConditionResult | null {
  const allDone = substepStates.every(s => s.status === 'done');
  if (!allDone) return null;

  const passCount = substepStates.filter(s => s.result === 'pass').length;

  if (transitions.all) {
    const anyFailed = substepStates.some(s => s.result === 'fail');
    if (anyFailed) return evaluateAction(transitions.fail.action);
    return evaluateAction(transitions.pass.action);
  } else {
    if (passCount > 0) return evaluateAction(transitions.pass.action);
    return evaluateAction(transitions.fail.action);
  }
}

function evaluateNonRetryAction(action: NonRetryAction): ConditionResult {
  switch (action.type) {
    case 'CONTINUE':
      return { action: 'continue' };
    case 'STOP':
      return { action: 'stopped', message: action.message };
    case 'COMPLETE':
      return { action: 'complete' };
    case 'GOTO':
      return { action: 'goto', gotoTarget: action.target };
  }
}

function evaluateAction(action: Action): ConditionResult {
  if (action.type === 'RETRY') return { action: 'retry' };
  return evaluateNonRetryAction(action);
}