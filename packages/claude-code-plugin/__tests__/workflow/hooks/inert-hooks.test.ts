// __tests__/workflow/hooks/inert-hooks.test.ts
//
// Pins the T1 (#901) contract for the two delegation hooks: both are INERT and
// allow unconditionally. The multi-writer machinery they drove (RD_CLAIM_TOKEN
// markers, token-hash session metadata, the SubagentStop closure gate) was
// deleted with the one-writer core. TODO(#907) rebuilds them over Claim
// Tickets and `--agent-id`; when it does, these cases are replaced, not kept.
import { describe, expect, it } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../../../src/session.js';
import type { HookInput } from '../../../src/shared/index.js';
import { handleDelegationDispatch } from '../../../src/workflow/hooks/delegation-dispatch.js';
import { handleSubagentStop } from '../../../src/workflow/hooks/subagent-stop.js';

const LEGACY_TOKEN = 'rdtk_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TICKET = `rdt_${'B'.repeat(43)}`;

describe('handleDelegationDispatch (inert until #907)', () => {
  it.each<[string, HookInput]>([
    [
      'Task carrying a legacy RD_CLAIM_TOKEN marker',
      {
        hook_event_name: 'PreToolUse',
        cwd: '/test',
        tool_name: 'Task',
        agent_id: 'agent-1',
        tool_input: { prompt: `Do work. RD_CLAIM_TOKEN=${LEGACY_TOKEN}` },
      },
    ],
    [
      'Agent carrying a Claim Ticket in the prompt',
      {
        hook_event_name: 'PreToolUse',
        cwd: '/test',
        tool_name: 'Agent',
        tool_input: { prompt: `Claim with rundown claim ${TICKET}` },
      },
    ],
    [
      'Agent with a marker only in the description',
      {
        hook_event_name: 'PreToolUse',
        cwd: '/test',
        tool_name: 'Agent',
        tool_input: { description: `RD_CLAIM_TOKEN=${LEGACY_TOKEN}`, prompt: 'plain' },
      },
    ],
    ['Task with no marker', { hook_event_name: 'PreToolUse', cwd: '/test', tool_name: 'Task' }],
    ['a non-delegation tool', { hook_event_name: 'PreToolUse', cwd: '/test', tool_name: 'Bash' }],
    ['a non-PreToolUse event', { hook_event_name: 'PostToolUse', cwd: '/test', tool_name: 'Task' }],
  ])('allows %s with no context and no violation', async (_label, input) => {
    await expect(handleDelegationDispatch(input)).resolves.toStrictEqual({});
  });
});

describe('handleSubagentStop (inert until #907)', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'rd-inert-stop-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('allows a stop with no session state present', async () => {
    const input: HookInput = { hook_event_name: 'SubagentStop', cwd, agent_id: 'agent-1' };
    await expect(handleSubagentStop(input)).resolves.toStrictEqual({});
  });

  it('allows a stop even when stale delegation metadata survives in the session file', async () => {
    // A workspace written by a pre-#901 build may still carry the per-agent
    // token map. The inert hook neither reads nor consumes it: no block, and the
    // metadata is left exactly as found (nothing writes it until #907 decides
    // the new shape).
    const session = new Session(cwd);
    const staleMetadata = {
      delegation_active_tokens: {
        'agent-1': {
          kind: 'delegation-active-token',
          agent_id: 'agent-1',
          tokenHash: `sha256:${'a'.repeat(64)}`,
          createdAt: '2026-06-08T00:00:00.000Z',
        },
      },
    };
    await session.set('metadata', staleMetadata);

    const input: HookInput = { hook_event_name: 'SubagentStop', cwd, agent_id: 'agent-1' };
    await expect(handleSubagentStop(input)).resolves.toStrictEqual({});
    await expect(session.get('metadata')).resolves.toEqual(staleMetadata);
  });

  it('allows a stop_hook_active re-fire and a non-SubagentStop event alike', async () => {
    await expect(
      handleSubagentStop({ hook_event_name: 'SubagentStop', cwd, stop_hook_active: true }),
    ).resolves.toStrictEqual({});
    await expect(handleSubagentStop({ hook_event_name: 'Stop', cwd })).resolves.toStrictEqual({});
  });
});
