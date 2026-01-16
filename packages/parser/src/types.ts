import { type Action, MAX_STEP_NUMBER } from './schemas.js';

export { MAX_STEP_NUMBER };

/** Aggregation modifier for substep transitions: ALL (pessimistic) or ANY (optimistic) */
export type AggregationModifier = 'ALL' | 'ANY' | null;

/**
 * Error thrown when parsing encounters invalid runbook syntax.
 *
 * This error indicates structural problems in the runbook markdown,
 * such as invalid step numbering, duplicate IDs, unsupported header levels,
 * or malformed transitions.
 */
export class RunbookSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunbookSyntaxError';
  }
}

/**
 * Parsed representation of a conditional transition line.
 *
 * Represents PASS/FAIL or YES/NO conditional transitions extracted
 * from runbook content, with optional aggregation modifiers.
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
