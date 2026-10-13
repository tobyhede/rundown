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

/**
 * One exact marker line: optional list or quote punctuation, the key, `=`, and
 * a single value running to the end of the line.
 */
const MARKER_LINE = /^[ \t>*-]*RD_CLAIM_TICKET=[ \t]*(\S*)[ \t]*$/;

/** Line breaks a prompt may use: LF, CRLF, or a lone CR. */
const LINE_BREAK = /\r\n|\n|\r/;

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
  /**
   * How many lines name the marker's key without being a well-formed marker:
   * a value that is not a Claim Ticket, or a near miss such as the marker in
   * inline code, with trailing text, or mid-sentence.
   */
  readonly malformed: number;
}

/**
 * Find every Claim Ticket marker line in a text.
 *
 * A line counts when, after optional list or quote punctuation, it is exactly
 * `RD_CLAIM_TICKET=<value>` (any line ending, CRLF included). Every other line
 * that names `RD_CLAIM_TICKET` is a near miss, counted as malformed so the
 * dispatch is blocked rather than sent without its claim instructions. A
 * value must be a well-formed Claim Ticket to be returned; any other value is
 * only counted, never echoed.
 *
 * @param text - A prompt or description.
 * @returns The distinct tickets marked, and how many markers were malformed.
 */
export function findClaimTicketMarkers(text: string): ClaimTicketMarkers {
  const tickets: ClaimTicket[] = [];
  let malformed = 0;
  for (const line of text.split(LINE_BREAK)) {
    if (!line.includes(CLAIM_TICKET_MARKER)) continue;
    const value = MARKER_LINE.exec(line)?.[1];
    if (!isClaimTicket(value)) {
      malformed += 1;
      continue;
    }
    if (!tickets.includes(value)) tickets.push(value);
  }
  return { tickets, malformed };
}
