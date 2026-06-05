import { describe, it, expect } from '@jest/globals';
import { assertClaimId, type RunbookState, type SessionService } from '@rundown-org/core';
import { resolveActiveRunbook } from '../../src/helpers/active-runbook-resolver.js';

const parent = { id: 'parent', lifecycle: 'running' } as RunbookState;
const child = { id: 'child', lifecycle: 'running' } as RunbookState;

describe('resolveActiveRunbook', () => {
  it('resolves explicit claim id before default stack', async () => {
    const claimId = assertClaimId('rdclm_abcdefghijklmnopqrstu1');
    const sessionService = {
      getActiveForClaimId: async () => ({
        status: 'claimed' as const,
        claim: {
          kind: 'claim-record',
          claimId,
          childRunId: 'child',
          tokenHash: `sha256:${'a'.repeat(64)}`,
          parentRunId: 'parent',
          parentStepId: '1.1',
          claimedAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-01T00:00:00.000Z',
        },
        state: child,
      }),
      getActive: async () => parent,
    } as unknown as SessionService;

    const result = await resolveActiveRunbook(sessionService, { claimId });

    expect(result.kind).toBe('claim');
    if (result.kind === 'claim') {
      expect(result.state.id).toBe('child');
    }
  });

  it('does not fall back when explicit claim id is missing', async () => {
    const claimId = assertClaimId('rdclm_abcdefghijklmnopqrstu1');
    const sessionService = {
      getActiveForClaimId: async () => ({ status: 'missing' as const, claimId }),
      getActive: async () => parent,
    } as unknown as SessionService;

    const result = await resolveActiveRunbook(sessionService, { claimId });

    expect(result.kind).toBe('stale_claim');
    if (result.kind === 'stale_claim') {
      expect(result.message).toContain('Claim id');
    }
  });

  it('preserves terminal claim resolution with final child state', async () => {
    const claimId = assertClaimId('rdclm_abcdefghijklmnopqrstu1');
    const terminalChild = { ...child, lifecycle: 'completed' } as RunbookState;
    const sessionService = {
      getActiveForClaimId: async () => ({
        status: 'terminal' as const,
        claim: {
          kind: 'claim-record',
          claimId,
          childRunId: 'child',
          tokenHash: `sha256:${'a'.repeat(64)}`,
          parentRunId: 'parent',
          parentStepId: '1.1',
          claimedAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-01T00:00:00.000Z',
        },
        lifecycle: 'completed' as const,
        state: terminalChild,
      }),
      getActive: async () => parent,
    } as unknown as SessionService;

    const result = await resolveActiveRunbook(sessionService, { claimId });

    expect(result.kind).toBe('terminal_claim');
    if (result.kind === 'terminal_claim') {
      expect(result.lifecycle).toBe('completed');
      expect(result.state.id).toBe('child');
    }
  });

  it('resolves default stack when no claim id is supplied', async () => {
    const sessionService = {
      getActive: async () => parent,
    } as unknown as SessionService;

    const result = await resolveActiveRunbook(sessionService, {});

    expect(result).toEqual({ kind: 'default', state: parent });
  });
});
