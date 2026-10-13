// src/shared/claim-ticket-marker.ts
import { isClaimTicket, type ClaimTicket } from '@rundown-org/core';

/**
 * The Claim Ticket marker (#907): the one line an orchestrating agent puts in
 * a sub-agent's Agent/Task prompt to hand it a delegated child —
 * `RD_CLAIM_TICKET=rdt_…` on a line of its own. The PreToolUse(Agent|Task)
 * hook detects it and appends the claim instructions to the prompt. Skills,
 * docs and tests name the format through this module only.
 *
 * @module shared/claim-ticket-marker
 */

/** The marker's key. */
export const CLAIM_TICKET_MARKER = 'RD_CLAIM_TICKET';

/** One marker line: the key, `=`, and a value up to the end of the line. */
const MARKER_LINE = /^[ \t>*-]*RD_CLAIM_TICKET=[ \t]*(\S*)[ \t]*$/gm;

/**
 * Write the marker line for a ticket.
 *
 * @param ticket - The Claim Ticket to hand over.
 * @returns `RD_CLAIM_TICKET=<ticket>`.
 */
export function formatClaimTicketMarker(ticket: ClaimTicket): string {
  return `${CLAIM_TICKET_MARKER}=${ticket}`;
}

/** What {@link findClaimTicketMarkers} found in a text. */
export interface ClaimTicketMarkers {
  /** The distinct well-formed tickets marked, in order of first appearance. */
  readonly tickets: readonly ClaimTicket[];
  /** How many marker lines carried a value that is not a Claim Ticket. */
  readonly malformed: number;
}

/**
 * Find every Claim Ticket marker line in a text.
 *
 * A line counts when, after optional list or quote punctuation, it is exactly
 * `RD_CLAIM_TICKET=<value>`. The value must be a well-formed Claim Ticket to
 * be returned; any other value is only counted, never echoed.
 *
 * @param text - A prompt or description.
 * @returns The distinct tickets marked, and how many markers were malformed.
 */
export function findClaimTicketMarkers(text: string): ClaimTicketMarkers {
  const tickets: ClaimTicket[] = [];
  let malformed = 0;
  for (const match of text.matchAll(MARKER_LINE)) {
    const value = match[1];
    if (!isClaimTicket(value)) {
      malformed += 1;
      continue;
    }
    if (!tickets.includes(value)) tickets.push(value);
  }
  return { tickets, malformed };
}
