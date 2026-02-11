import { type HookInput, type GateResult } from '../shared/index.js';
import { handleSubagentStop } from '../workflow/hooks/subagent-stop.js';

/**
 * Workflow Subagent Stop Gate
 *
 * Wraps handleSubagentStop logic as a configurable gate.
 * Handles agent completion and advances workflow state.
 */
export function execute(input: HookInput): GateResult {
  const result = handleSubagentStop(input);

  if (result.violation) {
    return {
      decision: 'block',
      reason: result.violation
    };
  }

  if (result.context) {
    return { additionalContext: result.context };
  }

  return {};
}
