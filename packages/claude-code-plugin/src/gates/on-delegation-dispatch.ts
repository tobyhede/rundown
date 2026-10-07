import type { HookInput, GateResult } from '../shared/index.js';
import { handleDelegationDispatch } from '../workflow/hooks/delegation-dispatch.js';

/**
 * Delegation Dispatch Gate
 *
 * Routes PreToolUse(Agent/Task) events to {@link handleDelegationDispatch} and
 * translates its result into a gate decision: `violation` blocks, `context`
 * enriches, otherwise the tool use is allowed.
 *
 * The handler is inert under the one-writer model (#901), so today this gate
 * always allows. TODO(#907): when the handler detects a Claim Ticket marker
 * again (spec § Plugin), the context branch below carries the rewritten claim
 * instructions; a recording failure that must fail closed is reintroduced
 * there, not here.
 *
 * @param input - Hook input containing Agent/Task tool metadata
 * @returns Gate result: block on violation; context on detection; or empty
 * @throws {Error} Propagates handler errors to the dispatcher's fail-open backstop
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
