import { type HookInput, type GateResult } from '../shared/index.js';
import { trackStepDispatch } from '../workflow/hooks/step-tracker.js';

/**
 * Workflow Step Tracker Gate
 *
 * Wraps trackStepDispatch logic as a configurable gate.
 * Enforces StepId prefix on Step tool descriptions when workflow is active.
 */
export function execute(input: HookInput): GateResult {
  const result = trackStepDispatch(input);

  if (result.violation) {
    return {
      decision: 'block',
      reason: result.violation
    };
  }

  return {};
}
