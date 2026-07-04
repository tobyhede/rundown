// __tests__/workflow/hooks/delegation-dispatch.concurrency.test.ts
// Real-Session (no Session mock) concurrency regression for #470 defect 1:
// two concurrent PreToolUse(Task) dispatches recording tokens for different
// agents must BOTH survive in .claude/session/state.json.
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashDelegationToken } from '@rundown-org/core';
import type { HookInput, DelegationActiveTokensMetadata } from '../../../src/shared/index.js';

// Mock ONLY the best-effort status enrichment (it shells out to the rundown
// CLI); Session stays REAL so this test exercises the on-disk RMW.
jest.unstable_mockModule('../../../src/workflow/hooks/rundown.js', () => ({
  rundown: jest.fn(() => {
    throw new Error('status unavailable in test');
  }),
}));

const { handleDelegationDispatch } = await import(
  '../../../src/workflow/hooks/delegation-dispatch.js'
);
const { Session } = await import('../../../src/session.js');

const TOKEN_A = 'rdtk_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOKEN_B = 'rdtk_BBCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function dispatchInput(cwd: string, agentId: string, token: string): HookInput {
  return {
    hook_event_name: 'PreToolUse',
    cwd,
    tool_name: 'Task',
    agent_id: agentId,
    tool_input: { prompt: `Delegated work\nRD_CLAIM_TOKEN=${token}` },
  };
}

describe('concurrent delegation-token recording (#470 defect 1)', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'rd-dispatch-race-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('concurrent dispatches for two agents both persist their token entries', async () => {
    await Promise.all([
      handleDelegationDispatch(dispatchInput(cwd, 'agent-1', TOKEN_A)),
      handleDelegationDispatch(dispatchInput(cwd, 'agent-2', TOKEN_B)),
    ]);

    const meta = await new Session(cwd).get('metadata');
    const map = meta.delegation_active_tokens as DelegationActiveTokensMetadata;
    expect(Object.keys(map).sort()).toEqual(['agent-1', 'agent-2']);
    expect(map['agent-1']!.tokenHash).toBe(hashDelegationToken(TOKEN_A));
    expect(map['agent-2']!.tokenHash).toBe(hashDelegationToken(TOKEN_B));
  });
});
