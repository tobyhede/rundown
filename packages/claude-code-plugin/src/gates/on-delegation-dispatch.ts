import {
  CLAIM_TICKET_MARKER,
  type HookInput,
  type GateResult,
  logger,
  getErrorMessage,
} from '../shared/index.js';
import { handleDelegationDispatch } from '../workflow/hooks/delegation-dispatch.js';

/**
 * Delegation Dispatch Gate (#907)
 *
 * Routes PreToolUse(Agent/Task) events to {@link handleDelegationDispatch} and
 * translates its result into a gate decision: a violation blocks; a rewritten
 * prompt is dispatched in place of the agent's (`updatedInput`, keeping every
 * other tool-input field); otherwise the tool use is untouched.
 *
 * It fails CLOSED only for a dispatch that names the Claim Ticket marker: if
 * the handler throws on one, the dispatch is blocked rather than sent without
 * its claim instructions. Any other Agent/Task call is never blocked here.
 *
 * @param input - Hook input containing Agent/Task tool metadata
 * @returns Gate result: block on violation; `updatedInput` on a marked ticket; or empty
 */
export async function execute(input: HookInput): Promise<GateResult> {
  let result: Awaited<ReturnType<typeof handleDelegationDispatch>>;
  try {
    result = await handleDelegationDispatch(input);
  } catch (error) {
    if (!JSON.stringify(input.tool_input ?? {}).includes(CLAIM_TICKET_MARKER)) throw error;
    try {
      await logger.error('Delegation dispatch failed; failing closed', {
        error: getErrorMessage(error),
      });
    } catch {
      // Preserve fail-closed behavior even if logging itself fails.
    }
    return {
      decision: 'block',
      reason:
        'Rundown could not add the claim instructions to this delegated dispatch, so it was not sent. Retry the dispatch.',
    };
  }

  if (result.violation) {
    return { decision: 'block', reason: result.violation };
  }
  if (result.prompt !== undefined) {
    return { updatedInput: { ...input.tool_input, prompt: result.prompt } };
  }
  return {};
}
