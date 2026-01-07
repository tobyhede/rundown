import { type Action, type StepNumber, MAX_STEP_NUMBER } from './schemas.js';
/**
 * Re-export common types
 */
export { type StepNumber, MAX_STEP_NUMBER };
/**
 * Factory function to create a valid StepNumber
 * Returns null if the number is invalid (zero, negative, non-integer, or too large)
 */
export declare function createStepNumber(n: number): StepNumber | null;
/**
 * Increment a StepNumber, preserving the brand
 * Returns null if result would exceed maximum
 */
export declare function incrementStepNumber(sn: StepNumber): StepNumber | null;
/**
 * Decrement a StepNumber, preserving the brand
 * Returns null if result would be less than 1
 */
export declare function decrementStepNumber(sn: StepNumber): StepNumber | null;
/**
 * Aggregation modifier for transitions
 */
export type AggregationModifier = 'ALL' | 'ANY' | null;
/**
 * Custom error for workflow parsing/validation failures
 */
export declare class WorkflowSyntaxError extends Error {
    constructor(message: string);
}
/**
 * Condition type in parsed conditionals
 */
export type ConditionKind = 'pass' | 'fail' | 'yes' | 'no';
/**
 * Parsed conditional line (internal to parser)
 */
export interface ParsedConditional {
    type: ConditionKind;
    action: Action;
    modifier: AggregationModifier;
    raw: string;
}
//# sourceMappingURL=types.d.ts.map