import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hashDelegationToken } from '@rundown-org/core';
import { execute } from '../../src/gates/on-delegated-bash-guard.js';
import { Session } from '../../src/session.js';

describe('on-delegated-bash-guard gate execute', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'rundown-gate-bash-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  async function markDelegated(agentId = 'agent-1'): Promise<void> {
    const session = new Session(cwd);
    await session.set('metadata', {
      delegation_active_tokens: {
        [agentId]: {
          kind: 'delegation-active-token',
          agent_id: agentId,
          tokenHash: hashDelegationToken('rdtk_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'),
          createdAt: '2026-06-08T00:00:00.000Z',
        },
      },
    });
  }

  it('maps a violation to a block decision', async () => {
    await markDelegated();

    await expect(
      execute({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        cwd,
        agent_id: 'agent-1',
        tool_input: { command: 'rd pass' },
      }),
    ).resolves.toEqual({
      decision: 'block',
      reason: expect.stringContaining('rd pass --claim-id'),
    });
  });

  it('maps no violation to an empty (continue) result', async () => {
    await markDelegated();

    await expect(
      execute({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        cwd,
        agent_id: 'agent-1',
        tool_input: { command: 'rd pass --claim-id rdclm_abcdefghijklmnopQRSTUV' },
      }),
    ).resolves.toEqual({});
  });
});
