// src/workflow/hooks/delegation-dispatch.ts

import type { HookInput } from '../../shared/index.js';

/**
 * Result from delegation dispatch handling.
 */
export interface DelegationDispatchResult {
  /** Context to inject into the subagent prompt */
  context?: string;
  /** Violation message if dispatch should be blocked */
  violation?: string;
}

/**
 * Handle a PreToolUse(Agent/Task) hook event.
 *
 * INERT under the one-writer model (#901): the delegation-token machinery this
 * handler used to drive (`RD_CLAIM_TOKEN` marker detection, token-hash
 * recording in session metadata, `rundown claim <token>` instructions) was
 * deleted with the multi-writer core. Every call allows the tool use with no
 * context and no violation.
 *
 * TODO(#907): per spec § Plugin, this hook keeps detecting a Claim Ticket
 * marker in the Agent/Task prompt and injects the claim instructions
 * rewritten for tickets and `--token`; a sibling PreToolUse hook on Bash
 * stamps `--agent-id` onto `rundown claim` / `rundown release` and refuses
 * `claim` outside a sub-agent (no `agent_id` on the hook input).
 *
 * @param _input - Hook input received from Claude Code for the event (unused while inert)
 * @returns An empty result: allow, with no context
 */
export function handleDelegationDispatch(_input: HookInput): Promise<DelegationDispatchResult> {
  return Promise.resolve({});
}
