// __tests__/workflow/hooks/delegation-dispatch.test.ts
//
// The PreToolUse(Agent|Task) hook (#907): a prompt carrying one Claim Ticket
// marker is dispatched with the claim instructions appended, so the sub-agent
// reads them; several tickets, or a malformed marker, block the dispatch.
import { describe, expect, it } from '@jest/globals';
import { parseClaimTicket } from '@rundown-org/core';
import { dispatch } from '../../../src/dispatcher.js';
import { buildHookOutput } from '../../../src/hook-output.js';
import {
  CLAIM_TICKET_MARKER,
  findClaimTicketMarkers,
  formatClaimTicketMarker,
} from '../../../src/shared/claim-ticket-marker.js';
import type { HookInput } from '../../../src/shared/index.js';

const TICKET = parseClaimTicket(`rdt_${'A'.repeat(43)}`);
const OTHER = parseClaimTicket(`rdt_${'B'.repeat(43)}`);

function agent(prompt: string, extra: Record<string, unknown> = {}): HookInput {
  return {
    hook_event_name: 'PreToolUse',
    cwd: '/repo',
    tool_name: 'Agent',
    tool_input: {
      description: '1.1 review-file',
      prompt,
      subagent_type: 'general-purpose',
      ...extra,
    },
  };
}

describe('the Claim Ticket marker', () => {
  it('is one RD_CLAIM_TICKET=<ticket> line', () => {
    expect(CLAIM_TICKET_MARKER).toBe('RD_CLAIM_TICKET');
    expect(formatClaimTicketMarker(TICKET)).toBe(`RD_CLAIM_TICKET=${TICKET}`);
  });

  it('is found on its own line, even in a list or quote, and only once per ticket', () => {
    const text = `Review the file.\n- ${formatClaimTicketMarker(TICKET)}\n> RD_CLAIM_TICKET=${TICKET}\n`;
    expect(findClaimTicketMarkers(text)).toEqual({ tickets: [TICKET], malformed: 0 });
  });

  it('is not found mid-sentence, and a value that is not a ticket is counted, not returned', () => {
    expect(findClaimTicketMarkers(`see RD_CLAIM_TICKET=${TICKET} above`)).toEqual({
      tickets: [],
      malformed: 1,
    });
    expect(findClaimTicketMarkers('RD_CLAIM_TICKET=rdt_short')).toEqual({
      tickets: [],
      malformed: 1,
    });
  });
});

describe('near-miss markers (review finding H6)', () => {
  it('accepts a marker line ending in CRLF', () => {
    expect(
      findClaimTicketMarkers(`Review it.\r\nRD_CLAIM_TICKET=${TICKET}\r\nThanks.\r\n`),
    ).toEqual({
      tickets: [TICKET],
      malformed: 0,
    });
  });

  it.each([
    ['inline code', `\`RD_CLAIM_TICKET=${TICKET}\``],
    ['trailing text', `RD_CLAIM_TICKET=${TICKET} (your ticket)`],
    ['a mid-sentence marker', `Your ticket: RD_CLAIM_TICKET=${TICKET}`],
    ['a spaced key', `RD_CLAIM_TICKET = ${TICKET}`],
  ])('counts %s as malformed, never silently ignoring it', (_label, line) => {
    expect(findClaimTicketMarkers(`Review it.\n${line}\n`)).toEqual({ tickets: [], malformed: 1 });
  });

  it('blocks a dispatch whose only marker is a near miss', async () => {
    const result = await dispatch(agent(`Review it.\n\`RD_CLAIM_TICKET=${TICKET}\``));
    expect(result.blockReason).toMatch(/RD_CLAIM_TICKET/);
    expect(result.blockReason).not.toContain(TICKET);
  });
});

describe('PreToolUse(Agent|Task) dispatch', () => {
  it('appends the claim instructions to a marked prompt, keeping every other field', async () => {
    const prompt = `Review the plan.\n${formatClaimTicketMarker(TICKET)}`;
    const input = agent(prompt);

    const output = buildHookOutput(input, await dispatch(input));

    const updated = output.hookSpecificOutput!.updatedInput!;
    expect(output.hookSpecificOutput).not.toHaveProperty('permissionDecision');
    expect(updated).toMatchObject({
      description: '1.1 review-file',
      subagent_type: 'general-purpose',
    });
    const injected = String(updated.prompt);
    expect(injected.startsWith(prompt)).toBe(true);
    expect(injected).toContain(`rundown claim ${TICKET}`);
    expect(injected).toContain('stamps your agent id');
    expect(injected).toContain('--token <owner_token> --step');
    expect(injected).toContain('rundown release <runbookId>');
    expect(injected).not.toMatch(/--claim-id|rundown stash|rundown pop|rundown delegate|abort/);
  });

  it('works for Task, and for a marker carried in the description', async () => {
    const input: HookInput = {
      hook_event_name: 'PreToolUse',
      cwd: '/repo',
      tool_name: 'Task',
      tool_input: { description: formatClaimTicketMarker(TICKET), prompt: 'Do it.' },
    };
    const result = await dispatch(input);
    expect(String(result.updatedInput?.prompt)).toContain(`rundown claim ${TICKET}`);
  });

  it('blocks a dispatch marking two tickets: one sub-agent per ticket', async () => {
    const input = agent(`${formatClaimTicketMarker(TICKET)}\n${formatClaimTicketMarker(OTHER)}`);
    const result = await dispatch(input);
    expect(result.blockReason).toMatch(/one sub-agent per ticket/);
    expect(result.updatedInput).toBeUndefined();
  });

  it('blocks a malformed marker without echoing it', async () => {
    const result = await dispatch(agent('RD_CLAIM_TICKET=rdt_typo123'));
    expect(result.blockReason).toMatch(/is not a marker/);
    expect(result.blockReason).not.toContain('rdt_typo123');
  });

  it('leaves an unmarked dispatch, and a bare ticket in prose, untouched', async () => {
    expect(await dispatch(agent('Plain task.'))).toEqual({});
    expect(await dispatch(agent(`The ticket ${TICKET} is mentioned in passing.`))).toEqual({});
  });
});
