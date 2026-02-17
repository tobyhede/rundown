import type { HookInput, GateResult } from '../shared/index.js';
import { handleSubagentStart } from '../workflow/hooks/subagent-start.js';

/**
 * Workflow Subagent Start Gate
 *
 * Wraps handleSubagentStart logic as a configurable gate.
 * Binds agents to pending tasks when workflow is active.
 *
 * @param input - Hook input containing subagent metadata
 * @returns Gate result: block with reason on violation, context on success, or empty
 */
export function execute(input: HookInput): GateResult {
  const result = handleSubagentStart(input);

  if (result.violation) {
    return {
      decision: 'block',
      reason: result.violation,
    };
  }

  if (result.context) {
    return { additionalContext: result.context };
  }

  return {};
}
