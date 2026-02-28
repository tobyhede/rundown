import type { HookInput, GateResult } from '../shared/index.js';
import { handleSubagentStop } from '../workflow/hooks/subagent-stop.js';

/**
 * Workflow Subagent Stop Gate
 *
 * Wraps handleSubagentStop logic as a configurable gate.
 * Handles delegation abort on agent failure.
 *
 * @param input - Hook input containing subagent lifecycle metadata
 * @returns Gate result: block on violation, context on abort, or empty
 * @throws Propagates errors from handleSubagentStop if session I/O fails
 */
export async function execute(input: HookInput): Promise<GateResult> {
  const result = await handleSubagentStop(input);

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
