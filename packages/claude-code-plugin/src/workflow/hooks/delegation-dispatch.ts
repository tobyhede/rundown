// src/workflow/hooks/delegation-dispatch.ts

import type { ClaimTicket } from '@rundown-org/core';
import { CLAIM_TICKET_MARKER, findClaimTicketMarkers } from '../../shared/claim-ticket-marker.js';
import type { HookInput } from '../../shared/types.js';

/**
 * What the PreToolUse(Agent|Task) hook does with a dispatch.
 *
 * - `untouched` — no marker: the dispatch runs as the agent wrote it.
 * - `claim` — one marked ticket: the dispatch runs with `prompt`, the agent's
 *   prompt with the claim instructions appended.
 * - `blocked` — a malformed marker or several tickets: the dispatch does not
 *   run, and `reason` tells the agent why.
 */
export type DelegationDispatchDecision =
  | { readonly kind: 'untouched' }
  | { readonly kind: 'claim'; readonly prompt: string }
  | { readonly kind: 'blocked'; readonly reason: string };

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
    '   The plugin stamps your agent id on `rundown claim` and `rundown release` when you run them as plain commands, as shown; do not pass `--agent-id` yourself. Rundown refuses a claim it did not stamp.',
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
 * The decision is a pure function of the tool input and cannot fail.
 *
 * @param input - Hook input received from Claude Code for the event
 * @returns The dispatch decision
 */
export function handleDelegationDispatch(input: HookInput): DelegationDispatchDecision {
  const prompt = typeof input.tool_input?.prompt === 'string' ? input.tool_input.prompt : '';
  const description =
    typeof input.tool_input?.description === 'string' ? input.tool_input.description : '';
  const found = findClaimTicketMarkers(`${prompt}\n${description}`);
  if (found.malformed > 0) {
    return {
      kind: 'blocked',
      reason: `Rundown blocked this dispatch: a line names ${CLAIM_TICKET_MARKER} but is not a marker. Put the marker on a line of its own, exactly ${CLAIM_TICKET_MARKER}=<ticket> with no code formatting or other text, and copy the ticket (rdt_ followed by 43 characters) verbatim from the step_entered children that issued it.`,
    };
  }
  if (found.tickets.length > 1) {
    return {
      kind: 'blocked',
      reason: `Rundown blocked this dispatch: it marks ${String(found.tickets.length)} Claim Tickets. Dispatch one sub-agent per ticket, each prompt carrying one ${CLAIM_TICKET_MARKER}= line.`,
    };
  }
  const ticket = found.tickets.at(0);
  if (ticket === undefined) return { kind: 'untouched' };
  return { kind: 'claim', prompt: `${prompt}\n\n${claimInstructions(ticket)}` };
}
