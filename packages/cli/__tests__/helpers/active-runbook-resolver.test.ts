import { describe, it, expect } from '@jest/globals';
import { resolveActiveRunbook } from '../../src/helpers/active-runbook-resolver.js';
import type { AgentOwnerIdentity, RunbookState, SessionService } from '@rundown-org/core';

const parent = { id: 'parent', lifecycle: 'running' } as RunbookState;
const child = { id: 'child', lifecycle: 'running' } as RunbookState;
const identity: AgentOwnerIdentity = {
  kind: 'agent-session',
  agent_id: 'agent-a',
  session_id: 'session-a',
};

describe('resolveActiveRunbook', () => {
  it('prefers owned child over default stack', async () => {
    const sessionService = {
      getActiveForOwner: async () => ({
        status: 'owned' as const,
        identity,
        ownership: {
          kind: 'agent-owned-runbook',
          ownerKey: 'agent:agent-a:session:session-a',
          agent_id: 'agent-a',
          session_id: 'session-a',
          childRunId: 'child',
          tokenHash: `sha256:${'a'.repeat(64)}`,
          parentRunId: 'parent',
          parentStepId: '1',
          claimedAt: '2026-04-28T00:00:00.000Z',
          updatedAt: '2026-04-28T00:00:00.000Z',
        },
        state: child,
      }),
      getActive: async () => parent,
    } as unknown as SessionService;

    const result = await resolveActiveRunbook(sessionService, {
      kind: 'identified',
      identity,
    });

    expect(result.kind).toBe('owned');
    if (result.kind === 'owned') {
      expect(result.state.id).toBe('child');
    }
  });

  it('falls back to default only when identified caller is unowned', async () => {
    const sessionService = {
      getActiveForOwner: async () => ({ status: 'unowned' as const, identity }),
      getActive: async () => parent,
    } as unknown as SessionService;

    const result = await resolveActiveRunbook(sessionService, {
      kind: 'identified',
      identity,
    });

    expect(result).toEqual({ kind: 'default', state: parent });
  });

  it('does not fall back when owned mapping is stale', async () => {
    const staleOwnership = {
      kind: 'agent-owned-runbook' as const,
      ownerKey: 'agent:agent-a:session:session-a',
      agent_id: 'agent-a',
      session_id: 'session-a',
      childRunId: 'missing-child',
      tokenHash: `sha256:${'b'.repeat(64)}`,
      parentRunId: 'parent',
      parentStepId: '1',
      claimedAt: '2026-04-28T00:00:00.000Z',
      updatedAt: '2026-04-28T00:00:00.000Z',
    };
    const sessionService = {
      getActiveForOwner: async () => ({
        status: 'stale' as const,
        identity,
        ownership: staleOwnership,
        reason: 'missing-state' as const,
      }),
      getActive: async () => parent,
    } as unknown as SessionService;

    const result = await resolveActiveRunbook(sessionService, {
      kind: 'identified',
      identity,
    });

    expect(result.kind).toBe('stale_owner');
    if (result.kind === 'stale_owner') {
      expect(result.ownership.childRunId).toBe('missing-child');
    }
  });
});
