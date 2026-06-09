import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hashDelegationToken } from '@rundown-org/core';
import { handleDelegatedBashGuard } from '../../../src/workflow/hooks/delegated-bash-guard.js';
import { Session } from '../../../src/session.js';

describe('handleDelegatedBashGuard', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'rundown-delegated-bash-'));
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

  it('blocks bare rd pass in a delegated subagent Bash command', async () => {
    await markDelegated();

    await expect(
      handleDelegatedBashGuard({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        cwd,
        agent_id: 'agent-1',
        tool_input: { command: 'rd pass' },
      }),
    ).resolves.toEqual({
      violation: expect.stringContaining('rd pass --claim-id'),
    });
  });

  it('allows rd pass with an explicit space-form claim id', async () => {
    await markDelegated();

    await expect(
      handleDelegatedBashGuard({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        cwd,
        agent_id: 'agent-1',
        tool_input: { command: 'rd pass --claim-id rdclm_abcdefghijklmnopQRSTUV' },
      }),
    ).resolves.toEqual({});
  });

  it('allows rd pass with an explicit equals-form claim id', async () => {
    await markDelegated();

    await expect(
      handleDelegatedBashGuard({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        cwd,
        agent_id: 'agent-1',
        tool_input: { command: 'rd pass --claim-id=rdclm_abcdefghijklmnopQRSTUV' },
      }),
    ).resolves.toEqual({});
  });

  it('allows bare rd pass when the current agent has no delegated token metadata', async () => {
    await markDelegated('other-agent');

    await expect(
      handleDelegatedBashGuard({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        cwd,
        agent_id: 'agent-1',
        tool_input: { command: 'rd pass' },
      }),
    ).resolves.toEqual({});
  });

  it('blocks bare rd pass via the legacy delegation_active_token string metadata', async () => {
    const session = new Session(cwd);
    // Legacy shape: a bare string flag rather than the per-agent map.
    await session.set('metadata', { delegation_active_token: 'rdtk_legacy-marker' });

    await expect(
      handleDelegatedBashGuard({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        cwd,
        // No agent_id — legacy path is agent-agnostic.
        tool_input: { command: 'rd pass' },
      }),
    ).resolves.toEqual({
      violation: expect.stringContaining('--claim-id'),
    });
  });

  it('returns {} for a non-Bash tool even with a bare transition string', async () => {
    await markDelegated();

    await expect(
      handleDelegatedBashGuard({
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        cwd,
        agent_id: 'agent-1',
        tool_input: { command: 'rd pass' },
      }),
    ).resolves.toEqual({});
  });

  it('returns {} for a non-PreToolUse event', async () => {
    await markDelegated();

    await expect(
      handleDelegatedBashGuard({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        cwd,
        agent_id: 'agent-1',
        tool_input: { command: 'rd pass' },
      }),
    ).resolves.toEqual({});
  });

  it('does not block a chained command whose first token is not a bare transition (known parse limitation)', async () => {
    await markDelegated();

    // The guard parses only the first token of the first line. `echo x && rd pass`
    // has `echo` as its first token, so it is NOT blocked here. This is an
    // accepted limitation: core's transition resolver is the real boundary and
    // will still refuse the unsafe parent transition. See the code comment in
    // isBareRundownTransition.
    await expect(
      handleDelegatedBashGuard({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        cwd,
        agent_id: 'agent-1',
        tool_input: { command: 'echo x && rd pass' },
      }),
    ).resolves.toEqual({});
  });

  it.each([
    'rd fail',
    'rundown pass',
    'rundown fail',
    'rd yes',
    'rd ok',
    'rd no',
  ])('blocks bare transition alias %s', async (command) => {
    await markDelegated();

    await expect(
      handleDelegatedBashGuard({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        cwd,
        agent_id: 'agent-1',
        tool_input: { command },
      }),
    ).resolves.toEqual({
      violation: expect.stringContaining('--claim-id'),
    });
  });
});
