import { type Action, MAX_STEP_NUMBER } from './schemas.js';

export { MAX_STEP_NUMBER };

/** Aggregation modifier for substep transitions: ALL (pessimistic) or ANY (optimistic) */
export type AggregationModifier = 'ALL' | 'ANY' | null;

/**
 * Error thrown when parsing encounters invalid workflow syntax.
 *
 * This error indicates structural problems in the workflow markdown,
 * such as invalid step numbering, duplicate IDs, unsupported header levels,
 * or malformed transitions.
 */
export class WorkflowSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowSyntaxError';
  }
}

/**
 * Parsed representation of a conditional transition line.
 *
 * Represents PASS/FAIL or YES/NO conditional transitions extracted
 * from workflow content, with optional aggregation modifiers.
 */
export interface ParsedConditional {
  /** Transition type: preserves original keyword (pass, fail, yes, no) */
  type: 'pass' | 'fail' | 'yes' | 'no';
  /** The action to take when this condition is met */
  action: Action;
  /** Optional aggregation modifier for substep evaluation (ALL or ANY) */
  modifier: AggregationModifier;
  /** The raw action string as it appeared in the source */
  raw: string;
}
