import type { Step, SubstepState, StepId, Transitions } from './types.js';
export interface ConditionResult {
    action: 'retry' | 'stopped' | 'goto' | 'continue' | 'complete';
    newRetryCount?: number;
    gotoTarget?: StepId;
    message?: string;
}
/**
 * Evaluate the FAIL condition for a step.
 */
export declare function evaluateFailCondition(step: Step, currentRetryCount: number): ConditionResult;
/**
 * Evaluate the PASS condition for a step.
 */
export declare function evaluatePassCondition(step: Step): ConditionResult;
/**
 * Evaluate aggregation conditions across substep results.
 */
export declare function evaluateSubstepAggregation(substepStates: readonly SubstepState[], transitions: Transitions): ConditionResult | null;
//# sourceMappingURL=transition-handler.d.ts.map