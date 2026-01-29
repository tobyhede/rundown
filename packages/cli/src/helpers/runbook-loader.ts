/**
 * Shared helper for loading runbook content from state.
 *
 * Enforces that state.runbookSrc must be present. Template variables are
 * expanded at run time and frozen in state, ensuring resume operations
 * (pass, fail, goto, complete, pop, status) use the original rendered content.
 *
 * @module
 * @throws Error if runbookSrc is missing (indicates corrupted state)
 */

import { parseRunbookDocument, type Step } from '@rundown-org/core';
import type { RunbookState } from '@rundown-org/core';

/**
 * Load and parse runbook steps from state.
 *
 * @param state - Runbook state containing runbookSrc
 * @param _cwd - Unused, kept for signature compatibility
 * @returns Parsed steps from runbookSrc
 * @throws Error if runbookSrc is missing (corrupted state)
 *
 * @example
 * ```typescript
 * const steps = getRunbookFromState(state, cwd);
 * const currentStep = steps.find(s => s.name === state.step);
 * ```
 */
export function getRunbookFromState(
  state: RunbookState,
  _cwd: string
): Step[] {
  if (!state.runbookSrc) {
    throw new Error(
      `State file ${state.id} is missing runbookSrc. ` +
      `This indicates corrupted state. Delete and re-run the runbook.`
    );
  }
  return parseRunbookDocument(state.runbookSrc, state.runbook).steps;
}
