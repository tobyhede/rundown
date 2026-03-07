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
  /**
   * Create a new RunbookSyntaxError with the given message.
   *
   * @param message - Description of the syntax violation encountered
   */
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
  /** Retry count (0 = no retry, N = stay at step N times before action) */
  retry: number;
  /** The action to take after retries exhausted (or immediately if retry=0) */
  action: Action;
  /** Optional aggregation modifier for substep evaluation (ALL or ANY) */
  modifier: AggregationModifier;
  /** The raw action string as it appeared in the source */
  raw: string;
}

/** Return type for parseConditional: single conditional, array (for DEFER shorthand), or null */
export type ParseConditionalResult = ParsedConditional | ParsedConditional[] | null;
