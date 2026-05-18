// __tests__/workflow/hooks/subagent-stop.test.ts
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { createMockHookInput } from '../../helpers/test-utils.js';

const {
  assertDelegationTokenHash: realAssertDelegationTokenHash,
  DELEGATION_TOKEN_PREFIX: realDelegationTokenPrefix,
  hashDelegationToken: realHashDelegationToken,
  isDelegationTokenHash: realIsDelegationTokenHash,
} = await import('@rundown-org/core');

// Mock Session module
import { createSessionMock, setGet } from '../../helpers/session-mock.js';

const session = createSessionMock();
const mockSet = session.set;
const mockListStates = jest.fn<() => Promise<unknown[]>>();
const mockReadConsumedDelegationClosureForCwd =
  jest.fn<(cwd: string, tokenHash: string) => Promise<unknown>>();

jest.unstable_mockModule('../../../src/session.js', () => ({
  Session: jest.fn().mockImplementation(() => session),
}));

jest.unstable_mockModule('@rundown-org/core', () => ({
  assertDelegationTokenHash: jest.fn(realAssertDelegationTokenHash),
  DELEGATION_TOKEN_PREFIX: realDelegationTokenPrefix,
  hashDelegationToken: jest.fn(realHashDelegationToken),
  isDelegationTokenHash: jest.fn(realIsDelegationTokenHash),
  readConsumedDelegationClosureForCwd: mockReadConsumedDelegationClosureForCwd,
}));

const { handleSubagentStop } = await import('../../../src/workflow/hooks/subagent-stop.js');

const VALID_TOKEN = 'rdtk_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const VALID_TOKEN_HASH = realHashDelegationToken(VALID_TOKEN);

const CLAIM_VIOLATION =
  'Delegated Rundown work was active when the subagent stopped. Run `rd status` to discover the active delegation, then close it explicitly: if a claim id was issued (the subagent ran `rd claim`), use `rd pass --claim-id <claim_id>` or `rd fail --claim-id <claim_id>`; if the token was never claimed, retry with `rd delegate --retry` or cancel with `rd abort <token>`.';
const UNKNOWN_CONTEXT =
  'Subagent stopped with an active delegation. Unable to verify child runbook state — check with `rd status`.';

/** Legacy SubagentStop payloads predate `agent_id` and use global token metadata. */
function createLegacySubagentStopInput(
  overrides: Partial<Parameters<typeof createMockHookInput>[1]> = {},
) {
  return createMockHookInput('SubagentStop', {
    agent_id: undefined,
    session_id: undefined,
    ...overrides,
  });
}

describe('handleSubagentStop', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setGet(session, 'metadata', {});
    mockSet.mockResolvedValue(undefined);
    mockListStates.mockResolvedValue([]);
    mockReadConsumedDelegationClosureForCwd.mockResolvedValue({
      status: 'unknown',
      reason: 'missing',
      requiresClosure: true,
    });
  });

  it('returns empty result for non-SubagentStop events', async () => {
    const input = createMockHookInput('PostToolUse');
    const result = await handleSubagentStop(input);
    expect(result).toEqual({});
  });

  it('returns empty when no delegation token is active', async () => {
    const input = createLegacySubagentStopInput();
    const result = await handleSubagentStop(input);
    expect(result).toEqual({});
  });

  it('consumes legacy global delegation token hash and returns claim-id closure violation', async () => {
    setGet(session, 'metadata', {
      delegation_active_token: VALID_TOKEN_HASH,
      other_key: 'preserved',
    });

    const input = createLegacySubagentStopInput();
    const result = await handleSubagentStop(input);

    expect(result).toEqual({ violation: CLAIM_VIOLATION });
    expect(mockSet).toHaveBeenCalledWith('metadata', { other_key: 'preserved' });
  });

  it('normalizes raw legacy global delegation token metadata before validation', async () => {
    setGet(session, 'metadata', {
      delegation_active_token: VALID_TOKEN,
      other_key: 'preserved',
    });

    const input = createLegacySubagentStopInput();
    const result = await handleSubagentStop(input);

    expect(result).toEqual({ violation: CLAIM_VIOLATION });
    expect(mockSet).toHaveBeenCalledWith('metadata', { other_key: 'preserved' });
    expect(mockReadConsumedDelegationClosureForCwd).toHaveBeenCalledWith(
      expect.any(String),
      VALID_TOKEN_HASH,
    );
  });

  it('consumes only stopping agent token and preserves sibling metadata', async () => {
    const siblingTokenHash = realHashDelegationToken(VALID_TOKEN.replace('A', 'B'));
    setGet(session, 'metadata', {
      delegation_active_tokens: {
        'agent-1': {
          kind: 'delegation-active-token',
          agent_id: 'agent-1',
          session_id: 'session-a',
          tokenHash: VALID_TOKEN_HASH,
          createdAt: '2026-04-28T00:00:00.000Z',
        },
        'agent-2': {
          kind: 'delegation-active-token',
          agent_id: 'agent-2',
          session_id: 'session-a',
          tokenHash: siblingTokenHash,
          createdAt: '2026-04-28T00:00:00.000Z',
        },
      },
    });

    const input = createMockHookInput('SubagentStop', {
      agent_id: 'agent-1',
      session_id: 'session-a',
    });
    const result = await handleSubagentStop(input);

    expect(result).toEqual({ violation: CLAIM_VIOLATION });
    expect(mockSet).toHaveBeenCalledWith('metadata', {
      delegation_active_tokens: {
        'agent-2': expect.objectContaining({
          agent_id: 'agent-2',
          tokenHash: siblingTokenHash,
        }),
      },
    });
  });

  it('does not flag delegated subagent when the claimed child already completed', async () => {
    setGet(session, 'metadata', {
      delegation_active_tokens: {
        'agent-1': {
          kind: 'delegation-active-token',
          agent_id: 'agent-1',
          session_id: 'session-a',
          tokenHash: VALID_TOKEN_HASH,
          createdAt: '2026-04-28T00:00:00.000Z',
        },
      },
    });
    mockListStates.mockResolvedValue([
      {
        id: 'parent-id',
        substepStates: [
          {
            id: '1',
            status: 'pending',
            delegation: {
              tokenHash: VALID_TOKEN_HASH,
              childRunId: 'child-id',
              cancelledAt: null,
            },
          },
        ],
      },
      {
        id: 'child-id',
        lifecycle: 'completed',
        parentLinkage: {
          kind: 'delegation',
          parentRunId: 'parent-id',
          parentStepId: '1',
          tokenHash: VALID_TOKEN_HASH,
        },
      },
    ]);
    mockReadConsumedDelegationClosureForCwd.mockResolvedValue({
      status: 'closed',
      reason: 'completed',
      requiresClosure: false,
    });

    const input = createMockHookInput('SubagentStop', {
      agent_id: 'agent-1',
      session_id: 'session-a',
    });
    const result = await handleSubagentStop(input);

    expect(result).toEqual({});
    expect(mockSet).toHaveBeenCalledWith('metadata', {});
  });

  it('does not flag delegated subagent when the claimed child already stopped', async () => {
    setGet(session, 'metadata', {
      delegation_active_tokens: {
        'agent-1': {
          kind: 'delegation-active-token',
          agent_id: 'agent-1',
          session_id: 'session-a',
          tokenHash: VALID_TOKEN_HASH,
          createdAt: '2026-04-28T00:00:00.000Z',
        },
      },
    });
    mockListStates.mockResolvedValue([
      {
        id: 'parent-id',
        substepStates: [
          {
            id: '1',
            status: 'pending',
            delegation: {
              tokenHash: VALID_TOKEN_HASH,
              childRunId: 'child-id',
              cancelledAt: null,
            },
          },
        ],
      },
      {
        id: 'child-id',
        lifecycle: 'stopped',
        parentLinkage: {
          kind: 'delegation',
          parentRunId: 'parent-id',
          parentStepId: '1',
          tokenHash: VALID_TOKEN_HASH,
        },
      },
    ]);
    mockReadConsumedDelegationClosureForCwd.mockResolvedValue({
      status: 'closed',
      reason: 'stopped',
      requiresClosure: false,
    });

    const input = createMockHookInput('SubagentStop', {
      agent_id: 'agent-1',
      session_id: 'session-a',
    });
    const result = await handleSubagentStop(input);

    expect(result).toEqual({});
    expect(mockSet).toHaveBeenCalledWith('metadata', {});
  });

  it('does not flag delegated subagent when the parent delegation was cancelled', async () => {
    setGet(session, 'metadata', {
      delegation_active_tokens: {
        'agent-1': {
          kind: 'delegation-active-token',
          agent_id: 'agent-1',
          session_id: 'session-a',
          tokenHash: VALID_TOKEN_HASH,
          createdAt: '2026-04-28T00:00:00.000Z',
        },
      },
    });
    mockListStates.mockResolvedValue([
      {
        id: 'parent-id',
        substepStates: [
          {
            id: '1',
            status: 'pending',
            delegation: {
              tokenHash: VALID_TOKEN_HASH,
              childRunId: null,
              cancelledAt: '2026-04-28T00:01:00.000Z',
            },
          },
        ],
      },
    ]);
    mockReadConsumedDelegationClosureForCwd.mockResolvedValue({
      status: 'closed',
      reason: 'cancelled',
      requiresClosure: false,
    });

    const input = createMockHookInput('SubagentStop', {
      agent_id: 'agent-1',
      session_id: 'session-a',
    });
    const result = await handleSubagentStop(input);

    expect(result).toEqual({});
    expect(mockSet).toHaveBeenCalledWith('metadata', {});
  });

  it('does not flag delegated subagent when parent was pruned but child already stopped', async () => {
    setGet(session, 'metadata', {
      delegation_active_tokens: {
        'agent-1': {
          kind: 'delegation-active-token',
          agent_id: 'agent-1',
          session_id: 'session-a',
          tokenHash: VALID_TOKEN_HASH,
          createdAt: '2026-04-28T00:00:00.000Z',
        },
      },
    });
    mockListStates.mockResolvedValue([
      {
        id: 'child-id',
        lifecycle: 'stopped',
        parentLinkage: {
          kind: 'delegation',
          parentRunId: 'pruned-parent-id',
          parentStepId: '1',
          tokenHash: VALID_TOKEN_HASH,
        },
      },
    ]);
    mockReadConsumedDelegationClosureForCwd.mockResolvedValue({
      status: 'closed',
      reason: 'stopped',
      requiresClosure: false,
    });

    const input = createMockHookInput('SubagentStop', {
      agent_id: 'agent-1',
      session_id: 'session-a',
    });
    const result = await handleSubagentStop(input);

    expect(result).toEqual({});
    expect(mockSet).toHaveBeenCalledWith('metadata', {});
  });

  it('returns closure violation when token hash is not found in rundown state', async () => {
    setGet(session, 'metadata', {
      delegation_active_tokens: {
        'agent-1': {
          kind: 'delegation-active-token',
          agent_id: 'agent-1',
          session_id: 'session-a',
          tokenHash: VALID_TOKEN_HASH,
          createdAt: '2026-04-28T00:00:00.000Z',
        },
      },
    });
    mockListStates.mockResolvedValue([
      {
        id: 'other-parent-id',
        substepStates: [
          {
            id: '1',
            status: 'pending',
            delegation: {
              tokenHash: `sha256:${'b'.repeat(64)}`,
              childRunId: null,
              cancelledAt: null,
            },
          },
        ],
      },
    ]);

    const input = createMockHookInput('SubagentStop', {
      agent_id: 'agent-1',
      session_id: 'session-a',
    });
    const result = await handleSubagentStop(input);

    expect(result).toEqual({ violation: CLAIM_VIOLATION });
    expect(mockSet).toHaveBeenCalledWith('metadata', {});
    expect(mockReadConsumedDelegationClosureForCwd).toHaveBeenCalledWith(
      expect.any(String),
      VALID_TOKEN_HASH,
    );
  });

  it.each([
    [{ status: 'requires_closure', reason: 'pending', requiresClosure: true }],
    [{ status: 'requires_closure', reason: 'claimed_active', requiresClosure: true }],
    [{ status: 'unknown', reason: 'missing', requiresClosure: true }],
    [{ status: 'unknown', reason: 'corrupt', requiresClosure: true }],
  ])('returns closure violation for read model %#', async (model) => {
    setGet(session, 'metadata', {
      delegation_active_tokens: {
        'agent-1': {
          kind: 'delegation-active-token',
          agent_id: 'agent-1',
          session_id: 'session-a',
          tokenHash: VALID_TOKEN_HASH,
          createdAt: '2026-04-28T00:00:00.000Z',
        },
      },
    });
    mockReadConsumedDelegationClosureForCwd.mockResolvedValue(model);

    const input = createMockHookInput('SubagentStop', {
      agent_id: 'agent-1',
      session_id: 'session-a',
    });
    const result = await handleSubagentStop(input);

    expect(result).toEqual({ violation: CLAIM_VIOLATION });
  });

  it('returns unknown-state context when per-agent token entry is tampered', async () => {
    setGet(session, 'metadata', {
      delegation_active_tokens: {
        'agent-1': {
          kind: 'delegation-active-token',
          // agent_id mismatch with the map key triggers the tampered guard.
          agent_id: 'someone-else',
          session_id: 'session-a',
          tokenHash: VALID_TOKEN_HASH,
          createdAt: '2026-04-28T00:00:00.000Z',
        },
      },
    });

    const input = createMockHookInput('SubagentStop', {
      agent_id: 'agent-1',
      session_id: 'session-a',
    });
    const result = await handleSubagentStop(input);

    expect(result).toEqual({ context: UNKNOWN_CONTEXT });
    // Tampered detection must not mutate session metadata.
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockReadConsumedDelegationClosureForCwd).not.toHaveBeenCalled();
  });
});
