import { type Action, type StepNumber, MAX_STEP_NUMBER } from './schemas.js';

/**
 * Re-export common types
 */
export { type StepNumber, MAX_STEP_NUMBER };

/**
 * Factory function to create a valid StepNumber
 * Returns null if the number is invalid (zero, negative, non-integer, or too large)
 */
export function createStepNumber(n: number): StepNumber | null {
  if (n <= 0 || !Number.isInteger(n) || n > MAX_STEP_NUMBER) {
    return null;
  }
  return n as StepNumber;
}

/**
 * Increment a StepNumber, preserving the brand
 * Returns null if result would exceed maximum
 */
export function incrementStepNumber(sn: StepNumber): StepNumber | null {
  return createStepNumber(sn + 1);
}

/**
 * Decrement a StepNumber, preserving the brand
 * Returns null if result would be less than 1
 */
export function decrementStepNumber(sn: StepNumber): StepNumber | null {
  return createStepNumber(sn - 1);
}

/**
 * Aggregation modifier for transitions
 */
export type AggregationModifier = 'ALL' | 'ANY' | null;

/**
 * Custom error for workflow parsing/validation failures
 */
export class WorkflowSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowSyntaxError';
  }
}

/**
 * Parsed conditional line (internal to parser)
 */
export interface ParsedConditional {
  type: 'pass' | 'fail';
  action: Action;
  modifier: AggregationModifier;
  raw: string;
}
