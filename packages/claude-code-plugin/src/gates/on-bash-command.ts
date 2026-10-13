import type { GateResult, HookInput } from '../shared/types.js';
import { handleBashCommand } from '../workflow/hooks/stamp-agent-id.js';

/**
 * Bash Command Gate (#907, ADR 0005)
 *
 * Routes PreToolUse(Bash) events to {@link handleBashCommand}: a `rundown
 * claim` / `rundown release` it reads with confidence runs with the calling
 * sub-agent's `--agent-id` stamped on it, and such a claim outside a
 * sub-agent is denied. Every other command passes byte for byte, with no
 * output, so the user's Bash permission rules match it as typed. A rewrite
 * carries no permission decision either: Claude Code applies the user's
 * rules to the stamped command.
 *
 * The decision is a pure function of the command, with no error path, and
 * this module loads nothing from `@rundown-org/core`.
 *
 * @param input - Hook input containing Bash tool metadata
 * @returns Gate result: block on deny; `updatedInput` on a rewrite; or empty
 */
export function execute(input: HookInput): Promise<GateResult> {
  const decision = handleBashCommand(input);
  switch (decision.kind) {
    case 'allow':
      return Promise.resolve({});
    case 'deny':
      return Promise.resolve({ decision: 'block', reason: decision.reason });
    case 'rewrite':
      return Promise.resolve({ updatedInput: { ...input.tool_input, command: decision.command } });
    default: {
      const exhaustive: never = decision;
      return exhaustive;
    }
  }
}
