import { type HookInput, type GateResult, logger, getErrorMessage } from '../shared/index.js';
import { handleBashCommand } from '../workflow/hooks/stamp-agent-id.js';

/**
 * Bash Command Gate (#907, ADR 0005)
 *
 * Routes PreToolUse(Bash) events to {@link handleBashCommand}: a `rundown
 * claim` or `rundown release` runs with the calling sub-agent's `--agent-id`
 * stamped on it, and a `claim` outside a sub-agent is denied. Every other
 * command passes untouched.
 *
 * This is an ENFORCEMENT gate: it fails CLOSED. A command the handler fails
 * to read is denied rather than run unstamped, so the dispatcher's fail-open
 * catch can never let a claim through without its agent id.
 *
 * @param input - Hook input containing Bash tool metadata
 * @returns Gate result: block on deny; `updatedInput` on a rewrite; or empty
 */
export async function execute(input: HookInput): Promise<GateResult> {
  try {
    const decision = handleBashCommand(input);
    switch (decision.kind) {
      case 'allow':
        return {};
      case 'deny':
        return { decision: 'block', reason: decision.reason };
      case 'rewrite':
        return { updatedInput: { ...input.tool_input, command: decision.command } };
      default: {
        const _exhaustive: never = decision;
        return _exhaustive;
      }
    }
  } catch (error) {
    try {
      await logger.error('Bash command gate failed; failing closed', {
        error: getErrorMessage(error),
      });
    } catch {
      // Do not let logging failures bypass the blocking decision.
    }
    return {
      decision: 'block',
      reason:
        'Rundown could not read this command to stamp your agent id on `rundown claim` / `rundown release`, so it was not run. Run the rundown command on its own.',
    };
  }
}
