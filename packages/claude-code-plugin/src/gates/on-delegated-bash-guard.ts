import type { HookInput, GateResult } from '../shared/index.js';
import { handleDelegatedBashGuard } from '../workflow/hooks/delegated-bash-guard.js';

/**
 * Blocks obvious bare Rundown transition commands in delegated subagent Bash calls.
 *
 * @param input - Hook input containing Bash tool metadata
 * @returns Gate result that blocks unsafe bare transitions or continues silently
 */
export async function execute(input: HookInput): Promise<GateResult> {
  const result = await handleDelegatedBashGuard(input);
  if (result.violation) {
    return {
      decision: 'block',
      reason: result.violation,
    };
  }
  return {};
}
