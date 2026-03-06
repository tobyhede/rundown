import type { Step, SubstepState, Action, StepId, Transitions } from './types.js';

/**
 * Result of evaluating a step condition (PASS or FAIL).
 *
 * Indicates what action should be taken based on the condition evaluation:
 * - retry: Increment retry count and re-attempt the step
 * - stopped: Halt the runbook (with optional message)
 * - goto: Jump to a specific step
 * - continue: Proceed to the next step
 * - complete: Mark the runbook as complete
 * - defer: Defer to parent aggregation state
 */
export interface ConditionResult {
  /** The action to take based on the condition evaluation */
  action: 'retry' | 'stopped' | 'goto' | 'continue' | 'complete' | 'defer';
  /** New retry count (only set when action is 'retry') */
  newRetryCount?: number;
  /** Target step for GOTO action */
  gotoTarget?: StepId;
  /** Message to display (typically for STOP action) */
  message?: string;
}

/**
 * Evaluate a transition with its retry property.
 *
 * Common logic for handling retry on any transition (pass or fail, step or substep).
 *
 * @param transition - The transition object with retry and action
 * @param currentRetryCount - Current retry count
 * @returns A ConditionResult indicating the action to take
 */
function evaluateTransition(
  transition: { retry: number; action: Action },
  currentRetryCount: number,
): ConditionResult {
  const { retry, action } = transition;

  // Check if we should retry
  if (retry > 0 && currentRetryCount < retry) {
    return {
      action: 'retry',
      newRetryCount: currentRetryCount + 1,
    };
  }

  // Retries exhausted (or no retries) - execute the action
  return evaluateAction(action);
}

/**
 * Evaluate the FAIL condition for a step.
 *
 * Determines the appropriate action when a step fails based on its
 * defined FAIL transition with retry property.
 *
 * @param step - The step whose FAIL condition to evaluate
 * @param currentRetryCount - The current retry count for this step
 * @returns A ConditionResult indicating the action to take
 */
export function evaluateFailCondition(step: Step, currentRetryCount: number): ConditionResult {
  if (!step.transitions) {
    return {
      action: 'stopped',
      message: 'No FAIL condition defined for step',
    };
  }

  return evaluateTransition(step.transitions.fail, currentRetryCount);
}

/**
 * Evaluate the PASS condition for a step.
 *
 * Determines the appropriate action when a step passes based on its
 * defined PASS transition with retry property.
 *
 * @param step - The step whose PASS condition to evaluate
 * @param currentRetryCount - Current retry count (defaults to 0)
 * @returns A ConditionResult indicating the action to take
 */
export function evaluatePassCondition(step: Step, currentRetryCount = 0): ConditionResult {
  if (!step.transitions) {
    return { action: 'continue' };
  }

  return evaluateTransition(step.transitions.pass, currentRetryCount);
}

/**
 * Determine whether aggregated iteration/substep results should be treated as passing.
 *
 * Pure predicate shared between the transition handler (runtime evaluation) and
 * the compiler (XState guard closures) to keep ALL/ANY logic in one place.
 *
 * - ALL mode (`aggregation = 'ALL'` or `'none'`): passes only when no failures exist
 * - ANY mode (`aggregation = 'ANY'`): passes when at least one result passed
 *
 * @param hasFailed - Whether any result was a failure
 * @param passCount - Number of passing results
 * @param aggregation - Aggregation mode: 'ALL', 'ANY', or 'none' (uses ALL semantics)
 * @returns True if the aggregated outcome should be treated as PASS
 * @see {@link evaluateAggregation}
 */
export function shouldAggregationPass(
  hasFailed: boolean,
  passCount: number,
  aggregation: 'ALL' | 'ANY' | 'none',
): boolean {
  return aggregation !== 'ANY' ? !hasFailed : passCount > 0; // 'none' defaults to ALL (pessimistic)
}

/**
 * Evaluate ALL/ANY aggregation logic given pre-computed pass/fail indicators.
 *
 * @param hasFailed - Whether any result was a failure
 * @param passCount - Number of passing results
 * @param transitions - The transitions defining aggregation behavior (all/any)
 * @param currentRetryCount - Current retry count
 * @returns A ConditionResult indicating the action to take
 */
function evaluateAggregation(
  hasFailed: boolean,
  passCount: number,
  transitions: Transitions,
  currentRetryCount: number,
): ConditionResult {
  return evaluateTransition(
    shouldAggregationPass(hasFailed, passCount, transitions.aggregation)
      ? transitions.pass
      : transitions.fail,
    currentRetryCount,
  );
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
 * @param currentRetryCount - Current retry count (defaults to 0)
 * @returns A ConditionResult if all substeps are done, null otherwise
 */
export function evaluateSubstepAggregation(
  substepStates: readonly SubstepState[],
  transitions: Transitions,
  currentRetryCount = 0,
): ConditionResult | null {
  const allDone = substepStates.every((s) => s.status === 'done');
  if (!allDone) return null;

  const passCount = substepStates.filter((s) => s.result === 'pass').length;
  const hasFailed = substepStates.some((s) => s.result === 'fail');
  return evaluateAggregation(hasFailed, passCount, transitions, currentRetryCount);
}

/**
 * Evaluate aggregation conditions across iteration results.
 *
 * When all iterations of a FOR loop are complete, determines the parent step's outcome
 * based on the aggregation mode (ALL or ANY) defined in transitions:
 * - ALL mode: Pass if all iterations passed, fail if any failed
 * - ANY mode: Pass if any iteration passed, fail only if all failed
 *
 * @param iterationResults - The per-iteration outcomes ('pass' or 'fail')
 * @param transitions - The transitions defining aggregation behavior (all/any)
 * @param currentRetryCount - Current retry count (defaults to 0)
 * @returns A ConditionResult if iterations exist, null if empty
 */
export function evaluateIterationAggregation(
  iterationResults: readonly ('pass' | 'fail')[],
  transitions: Transitions,
  currentRetryCount = 0,
): ConditionResult | null {
  if (iterationResults.length === 0) return null;

  const passCount = iterationResults.filter((r) => r === 'pass').length;
  const hasFailed = iterationResults.some((r) => r === 'fail');
  return evaluateAggregation(hasFailed, passCount, transitions, currentRetryCount);
}

/**
 * Evaluate a terminal action.
 *
 * Handles evaluation of CONTINUE, STOP, COMPLETE, or GOTO actions.
 *
 * @param action - The action to evaluate (CONTINUE, STOP, COMPLETE, GOTO)
 * @returns A ConditionResult indicating the action to take
 */
function evaluateAction(action: Action): ConditionResult {
  switch (action.type) {
    case 'CONTINUE':
      return { action: 'continue' };
    case 'DEFER':
      return { action: 'defer' };
    case 'STOP':
      return { action: 'stopped', message: action.message };
    case 'COMPLETE':
      return { action: 'complete', message: action.message };
    case 'GOTO':
      return { action: 'goto', gotoTarget: action.target };
    case 'NEXT':
      // FOR loop: advance to next iteration (compiler handles the actual loop logic)
      return { action: 'continue' };
    case 'BREAK':
      // FOR loop: exit loop immediately (compiler handles the actual exit logic)
      return { action: 'continue' };
    default: {
      // Handle unknown action types (should not occur with valid schema)
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

/**
 * Evaluate a non-retry transition action.
 *
 * Handles evaluation of CONTINUE, STOP, COMPLETE, or GOTO actions.
 * This is an alias to evaluateAction for backwards compatibility.
 *
 * @param action - The non-retry action to evaluate
 * @returns A ConditionResult indicating the action to take
 * @deprecated Use evaluateAction instead
 */
export function evaluateNonRetryAction(action: Action): ConditionResult {
  return evaluateAction(action);
}
