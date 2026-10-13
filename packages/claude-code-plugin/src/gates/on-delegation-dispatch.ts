import type { GateResult, HookInput } from '../shared/types.js';
import { handleDelegationDispatch } from '../workflow/hooks/delegation-dispatch.js';

/**
 * Delegation Dispatch Gate (#907)
 *
 * Routes PreToolUse(Agent/Task) events to {@link handleDelegationDispatch} and
 * translates its decision into a gate result: `blocked` blocks; `claim`
 * dispatches the rewritten prompt in place of the agent's (`updatedInput`,
 * keeping every other tool-input field); `untouched` leaves the tool use as
 * is. The handler is a pure function of the tool input, so there is no error
 * path to fail open or closed.
 *
 * @param input - Hook input containing Agent/Task tool metadata
 * @returns Gate result: block, `updatedInput` on a marked ticket, or empty
 */
export function execute(input: HookInput): Promise<GateResult> {
  const decision = handleDelegationDispatch(input);
  switch (decision.kind) {
    case 'untouched':
      return Promise.resolve({});
    case 'blocked':
      return Promise.resolve({ decision: 'block', reason: decision.reason });
    case 'claim':
      return Promise.resolve({ updatedInput: { ...input.tool_input, prompt: decision.prompt } });
    default: {
      const exhaustive: never = decision;
      return exhaustive;
    }
  }
}
