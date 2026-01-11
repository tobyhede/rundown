import { type Action, MAX_STEP_NUMBER } from './schemas.js';

export { MAX_STEP_NUMBER };

export type AggregationModifier = 'ALL' | 'ANY' | null;

export class WorkflowSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowSyntaxError';
  }
}

export interface ParsedConditional {
  type: 'pass' | 'fail';
  action: Action;
  modifier: AggregationModifier;
  raw: string;
}
