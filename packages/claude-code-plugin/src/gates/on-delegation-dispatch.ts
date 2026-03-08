import type { HookInput, GateResult } from '../shared/index.js';
import { handleDelegationDispatch } from '../workflow/hooks/delegation-dispatch.js';

/**
 * Delegation Dispatch Gate
 *
 * Detects delegation markers in PreToolUse(Task) events and enriches
 * subagent prompts with claim instructions.
 *
 * @param input - Hook input containing Task tool metadata
 * @returns Gate result: block on violation, context on marker detection, or empty
 * @throws {Error} Propagates errors from handleDelegationDispatch if session I/O fails
 */
export async function execute(input: HookInput): Promise<GateResult> {
  const result = await handleDelegationDispatch(input);

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
