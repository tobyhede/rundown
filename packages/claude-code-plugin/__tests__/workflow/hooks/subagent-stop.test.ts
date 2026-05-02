// __tests__/workflow/hooks/subagent-stop.test.ts
import { createHash } from 'node:crypto';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { createMockHookInput } from '../../helpers/test-utils.js';

// Mock Session module
import { createSessionMock, setGet } from '../../helpers/session-mock.js';

const session = createSessionMock();
const mockSet = session.set;

jest.unstable_mockModule('../../../src/session.js', () => ({
  Session: jest.fn().mockImplementation(() => session),
}));

const { handleSubagentStop } = await import('../../../src/workflow/hooks/subagent-stop.js');

const VALID_TOKEN = 'rdtk_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const VALID_TOKEN_HASH = `sha256:${createHash('sha256').update(VALID_TOKEN).digest('hex')}`;

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

  it('consumes legacy global delegation token and returns claim-id closure violation', async () => {
    setGet(session, 'metadata', {
      delegation_active_token: VALID_TOKEN,
      other_key: 'preserved',
    });

    const input = createLegacySubagentStopInput();
    const result = await handleSubagentStop(input);

    expect(result).toEqual({ violation: CLAIM_VIOLATION });
    expect(mockSet).toHaveBeenCalledWith('metadata', { other_key: 'preserved' });
  });

  it('consumes only stopping agent token and preserves sibling metadata', async () => {
    const siblingTokenHash = `sha256:${createHash('sha256').update('rdtk_OTHER00000000000000000000000').digest('hex')}`;
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
  });
});
