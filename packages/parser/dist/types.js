import { MAX_STEP_NUMBER } from './schemas.js';
/**
 * Re-export common types
 */
export { MAX_STEP_NUMBER };
/**
 * Factory function to create a valid StepNumber
 * Returns null if the number is invalid (zero, negative, non-integer, or too large)
 */
export function createStepNumber(n) {
    if (n <= 0 || !Number.isInteger(n) || n > MAX_STEP_NUMBER) {
        return null;
    }
    return n;
}
/**
 * Increment a StepNumber, preserving the brand
 * Returns null if result would exceed maximum
 */
export function incrementStepNumber(sn) {
    return createStepNumber(sn + 1);
}
/**
 * Decrement a StepNumber, preserving the brand
 * Returns null if result would be less than 1
 */
export function decrementStepNumber(sn) {
    return createStepNumber(sn - 1);
}
/**
 * Custom error for workflow parsing/validation failures
 */
export class WorkflowSyntaxError extends Error {
    constructor(message) {
        super(message);
        this.name = 'WorkflowSyntaxError';
    }
}
//# sourceMappingURL=types.js.map