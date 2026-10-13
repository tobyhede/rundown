// src/workflow/hooks/delegation-dispatch.ts

import type { ClaimTicket } from '@rundown-org/core';
import { CLAIM_TICKET_MARKER, findClaimTicketMarkers, type HookInput } from '../../shared/index.js';

/**
 * Result from delegation dispatch handling.
 *
 * At most one field is set: a dispatch is either blocked or sent with the
 * claim instructions appended to its prompt.
 */
export interface DelegationDispatchResult {
  /** The prompt to dispatch instead: the agent's, with the claim instructions appended. */
  prompt?: string;
  /** Violation message if dispatch should be blocked */
  violation?: string;
}

/**
 * The claim instructions appended to a sub-agent's prompt for its ticket.
 *
 * @param ticket - The Claim Ticket the prompt marks.
 * @returns Markdown instructions naming the claim command and the protocol.
 */
export function claimInstructions(ticket: ClaimTicket): string {
  return [
    '## Rundown delegation',
    '',
    'You own one delegated Rundown child run. Follow the `rundown:running-runbooks` skill (Claimed Delegations).',
    '',
    '1. Claim it exactly once:',
    '',
    '   ```bash',
    `   rundown claim ${ticket}`,
    '   ```',
    '',
    '   The plugin stamps your agent id on `rundown claim` and `rundown release`; do not pass `--agent-id` yourself.',
    "2. `claim` prints the child's `runbook_started` event with the child's own `owner_token`, shown once. Keep it, and its `runbookId`.",
    '3. Drive the child with `rundown pass|fail --token <owner_token> --step <step>` (plus `--index <n>` inside a FOR loop), taking the step from each `step_entered`, until it reports `runbook_completed` or `runbook_stopped`.',
    '4. If any command is refused `DELEGATION_CANCELLED` or `PARENT_RUN_FINISHED`, run `rundown stop --token <owner_token>` and stop: nothing will collect the result.',
    '5. If you cannot finish the child (you lost its `owner_token`), run `rundown release <runbookId>` and stop. The parent collects it as a fail.',
    '',
    "Never use another run's token, never run `rundown collect`, and never run `rundown stop --run`. You cannot stop while the child is running and its parent still counts it: finish it or release it first.",
  ].join('\n');
}

/**
 * Handle a PreToolUse(Agent/Task) hook event (#907, ADR 0005).
 *
 * Looks for the Claim Ticket marker (`RD_CLAIM_TICKET=rdt_…`, see
 * `shared/claim-ticket-marker.ts`) in the prompt and the description. One
 * marked ticket: the dispatch proceeds with the claim instructions appended to
 * the sub-agent's prompt, so the sub-agent, not the orchestrator, reads them.
 * A dispatch marking several tickets, or a marker whose value is not a Claim
 * Ticket, is blocked: each ticket goes to its own sub-agent, copied verbatim.
 * No marker: the dispatch is untouched. Nothing is recorded; the ticket is
 * never logged.
 *
 * @param input - Hook input received from Claude Code for the event
 * @returns The prompt to dispatch, a violation, or an empty result (allow as is)
 */
export function handleDelegationDispatch(input: HookInput): Promise<DelegationDispatchResult> {
  const prompt = typeof input.tool_input?.prompt === 'string' ? input.tool_input.prompt : '';
  const description =
    typeof input.tool_input?.description === 'string' ? input.tool_input.description : '';
  const found = findClaimTicketMarkers(`${prompt}\n${description}`);
  if (found.malformed > 0) {
    return Promise.resolve({
      violation: `Rundown blocked this dispatch: a ${CLAIM_TICKET_MARKER}= line does not carry a Claim Ticket (rdt_ followed by 43 characters). Copy the ticket verbatim from the step_entered children that issued it.`,
    });
  }
  if (found.tickets.length > 1) {
    return Promise.resolve({
      violation: `Rundown blocked this dispatch: it marks ${String(found.tickets.length)} Claim Tickets. Dispatch one sub-agent per ticket, each prompt carrying one ${CLAIM_TICKET_MARKER}= line.`,
    });
  }
  const ticket = found.tickets.at(0);
  if (ticket === undefined) return Promise.resolve({});
  return Promise.resolve({ prompt: `${prompt}\n\n${claimInstructions(ticket)}` });
}
