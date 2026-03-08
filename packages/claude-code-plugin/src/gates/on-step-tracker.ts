import type { HookInput, GateResult } from '../shared/index.js';
import { trackStepDispatch } from '../workflow/hooks/step-tracker.js';

/**
 * Workflow Step Tracker Gate
 *
 * Wraps trackStepDispatch logic as a configurable gate.
 * Validates that Step/Task tool descriptions are non-empty and forwards
 * them to the rundown CLI for workflow state tracking.
 * @param input - Hook input containing tool name and description
 * @returns Gate result with block decision on violation, or empty on success
 */
export function execute(input: HookInput): GateResult {
  const result = trackStepDispatch(input);

  if (result.violation) {
    return {
      decision: 'block',
      reason: result.violation,
    };
  }

  return {};
}
