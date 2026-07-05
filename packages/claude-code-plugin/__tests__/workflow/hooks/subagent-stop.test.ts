// __tests__/workflow/hooks/subagent-stop.test.ts
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { createMockHookInput } from '../../helpers/test-utils.js';

const {
  assertDelegationTokenHash: realAssertDelegationTokenHash,
  DELEGATION_TOKEN_PREFIX: realDelegationTokenPrefix,
  hashDelegationToken: realHashDelegationToken,
  isDelegationTokenHash: realIsDelegationTokenHash,
} = await import('@rundown-org/core');

const {
  DelegationActiveTokenMetadataSchema: realDelegationActiveTokenMetadataSchema,
  DelegationActiveTokensMetadataSchema: realDelegationActiveTokensMetadataSchema,
} = await import('../../../src/shared/index.js');

// Mock Session module
import { createSessionMock, setGet } from '../../helpers/session-mock.js';

const session = createSessionMock();
const mockSet = session.set;
const mockListStates = jest.fn<() => Promise<unknown[]>>();
const mockReadConsumedDelegationClosureForCwd =
  jest.fn<(cwd: string, tokenHash: string) => Promise<unknown>>();
const mockAssertDelegationTokenHash = jest.fn(realAssertDelegationTokenHash);

/**
 * Result shape mirroring zod's `SafeParseReturnType`, kept intentionally
 * loose (rather than importing zod's generic type) since production code
 * only ever reads `.success` and `.data`.
 */
type SimpleSafeParseResult =
  | { success: true; data: Record<string, unknown> }
  | { success: false; error: unknown };

// Defaults to the real per-agent entry schema so every existing test keeps
// exercising real validation; individual tests override with
// `mockReturnValueOnce` to simulate the entry schema and the outer map
// schema diverging (see the "defense-in-depth" tests below, which exercise
// the same `Object.hasOwn`/superRefine invariant `subagent-stop.ts` line
// 96-98 documents as unreachable through the public API today).
const mockDelegationActiveTokenSafeParse = jest.fn(
  (value: unknown) =>
    realDelegationActiveTokenMetadataSchema.safeParse(value) as SimpleSafeParseResult,
);

jest.unstable_mockModule('../../../src/session.js', () => ({
  Session: jest.fn().mockImplementation(() => session),
}));

jest.unstable_mockModule('@rundown-org/core', () => ({
  assertDelegationTokenHash: mockAssertDelegationTokenHash,
  DELEGATION_TOKEN_PREFIX: realDelegationTokenPrefix,
  hashDelegationToken: jest.fn(realHashDelegationToken),
  isDelegationTokenHash: jest.fn(realIsDelegationTokenHash),
  readConsumedDelegationClosureForCwd: mockReadConsumedDelegationClosureForCwd,
}));

jest.unstable_mockModule('../../../src/shared/index.js', () => ({
  DelegationActiveTokenMetadataSchema: { safeParse: mockDelegationActiveTokenSafeParse },
  DelegationActiveTokensMetadataSchema: realDelegationActiveTokensMetadataSchema,
}));

const { handleSubagentStop } = await import('../../../src/workflow/hooks/subagent-stop.js');

const VALID_TOKEN = 'rdtk_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const VALID_TOKEN_HASH = realHashDelegationToken(VALID_TOKEN);

const CLAIM_VIOLATION =
  'Delegated Rundown work was active when the subagent stopped. Run `rundown status` to discover the active delegation, then close it explicitly in your own lane: if a claim id was issued (the subagent ran `rundown claim`), use `rundown pass --claim-id <claim_id>` or `rundown fail --claim-id <claim_id>`; if the token was never claimed, either claim and close it — `rundown claim <rdtk_…>` then `rundown pass --claim-id <claim_id>` or `rundown fail --claim-id <claim_id>` — or leave it unclaimed and report the token back so the orchestrator can `rundown delegate --retry <token> --run <rd_…>` from its own context. Cancel with `rundown abort <token>`.';
// Mirrors the production TAMPERED_VIOLATION string in subagent-stop.ts.
// Unverifiable/tampered records now FAIL CLOSED (a violation), replacing the
// former advisory UNKNOWN_CONTEXT (#470 defect 2).
const TAMPERED_VIOLATION =
  'Subagent stopped with an active delegation, but its session record could not be verified (corrupt or tampered metadata). Failing closed: run `rundown status` to inspect delegation state and close any open delegation explicitly before stopping.';

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

  it('keeps the legacy global token when closure is still required and returns the claim-id violation (#470)', async () => {
    setGet(session, 'metadata', {
      delegation_active_token: VALID_TOKEN_HASH,
      other_key: 'preserved',
    });

    const input = createLegacySubagentStopInput();
    const result = await handleSubagentStop(input);

    expect(result).toEqual({ violation: CLAIM_VIOLATION });
    // Verify-before-consume: nothing may be persisted until closure is proven.
    expect(mockSet).not.toHaveBeenCalled();
    expect(await session.get('metadata')).toEqual({
      delegation_active_token: VALID_TOKEN_HASH,
      other_key: 'preserved',
    });
  });

  it('tells an unclaimed child to claim and close with either claim-id result', async () => {
    setGet(session, 'metadata', {
      delegation_active_token: VALID_TOKEN_HASH,
    });

    const result = await handleSubagentStop(createLegacySubagentStopInput());

    expect(result.violation).toContain(
      '`rundown claim <rdtk_…>` then `rundown pass --claim-id <claim_id>` or `rundown fail --claim-id <claim_id>`',
    );
  });

  it('normalizes raw legacy global delegation token metadata before validation', async () => {
    setGet(session, 'metadata', {
      delegation_active_token: VALID_TOKEN,
      other_key: 'preserved',
    });

    const input = createLegacySubagentStopInput();
    const result = await handleSubagentStop(input);

    expect(result).toEqual({ violation: CLAIM_VIOLATION });
    // Token kept (closure required) — the raw token is left untouched.
    expect(await session.get('metadata')).toEqual({
      delegation_active_token: VALID_TOKEN,
      other_key: 'preserved',
    });
    expect(mockReadConsumedDelegationClosureForCwd).toHaveBeenCalledWith(
      expect.any(String),
      VALID_TOKEN_HASH,
    );
  });

  it('keeps both the stopping agent token and its sibling while closure is required (#470)', async () => {
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
    // Closure required, so agent-1's entry is NOT consumed; both entries remain.
    const meta = await session.get('metadata');
    expect(Object.keys(meta.delegation_active_tokens as object).sort()).toEqual([
      'agent-1',
      'agent-2',
    ]);
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
    // Closure verified: the entry is consumed, leaving empty metadata.
    expect(await session.get('metadata')).toEqual({});
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
    // Closure verified: the entry is consumed, leaving empty metadata.
    expect(await session.get('metadata')).toEqual({});
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
    // Closure verified: the entry is consumed, leaving empty metadata.
    expect(await session.get('metadata')).toEqual({});
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
    // Closure verified: the entry is consumed, leaving empty metadata.
    expect(await session.get('metadata')).toEqual({});
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
    // Closure unproven (token hash not found in state) → token kept, block re-issues.
    expect(await session.get('metadata')).toEqual({
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

  it('re-fired SubagentStop still blocks while closure is required (idempotent enforcement) (#470)', async () => {
    setGet(session, 'metadata', {
      delegation_active_tokens: {
        'agent-1': {
          kind: 'delegation-active-token',
          agent_id: 'agent-1',
          tokenHash: VALID_TOKEN_HASH,
          createdAt: '2026-07-04T00:00:00.000Z',
        },
      },
    });
    mockReadConsumedDelegationClosureForCwd.mockResolvedValue({
      status: 'requires_closure',
      reason: 'pending',
      requiresClosure: true,
    });

    const input = createMockHookInput('SubagentStop', { agent_id: 'agent-1' });

    const first = await handleSubagentStop(input);
    expect(first).toEqual({ violation: CLAIM_VIOLATION });

    // Re-fire (Claude Code re-invokes SubagentStop with stop_hook_active after a
    // blocked stop). Before the fix the token was already consumed and the
    // second call returned {} — no block, the closure guarantee was gone.
    const second = await handleSubagentStop(input);
    expect(second).toEqual({ violation: CLAIM_VIOLATION });

    const meta = await session.get('metadata');
    expect(meta.delegation_active_tokens).toMatchObject({
      'agent-1': { tokenHash: VALID_TOKEN_HASH },
    });
  });

  it('consumes the token once closure is verified, so a later SubagentStop passes (#470)', async () => {
    setGet(session, 'metadata', {
      delegation_active_tokens: {
        'agent-1': {
          kind: 'delegation-active-token',
          agent_id: 'agent-1',
          tokenHash: VALID_TOKEN_HASH,
          createdAt: '2026-07-04T00:00:00.000Z',
        },
      },
    });
    mockReadConsumedDelegationClosureForCwd.mockResolvedValue({
      status: 'closed',
      reason: 'completed',
      requiresClosure: false,
    });

    const input = createMockHookInput('SubagentStop', { agent_id: 'agent-1' });

    expect(await handleSubagentStop(input)).toEqual({});
    expect(await session.get('metadata')).toEqual({});
    expect(await handleSubagentStop(input)).toEqual({});
  });

  it('keeps the token when the closure read throws (closure unprovable fails closed) (#470)', async () => {
    setGet(session, 'metadata', {
      delegation_active_token: VALID_TOKEN_HASH,
    });
    mockReadConsumedDelegationClosureForCwd.mockRejectedValue(new Error('state unreadable'));

    const result = await handleSubagentStop(createLegacySubagentStopInput());

    expect(result).toEqual({ violation: CLAIM_VIOLATION });
    expect(await session.get('metadata')).toEqual({
      delegation_active_token: VALID_TOKEN_HASH,
    });
  });

  it('fails closed with a violation when per-agent token entry is tampered', async () => {
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

    expect(result).toEqual({ violation: TAMPERED_VIOLATION });
    // Tampered detection must not mutate session metadata, and it fails closed
    // BEFORE the closure check (an unverifiable record is never advanced past).
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockReadConsumedDelegationClosureForCwd).not.toHaveBeenCalled();
  });

  it('returns empty when legacy delegation token value is not a string', async () => {
    setGet(session, 'metadata', {
      delegation_active_token: 12345,
      other_key: 'preserved',
    });

    const input = createLegacySubagentStopInput();
    const result = await handleSubagentStop(input);

    expect(result).toEqual({});
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('fails closed with a violation when legacy delegation token value is not a valid hash or raw token', async () => {
    setGet(session, 'metadata', {
      delegation_active_token: 'not-a-valid-hash-or-token',
      other_key: 'preserved',
    });

    const input = createLegacySubagentStopInput();
    const result = await handleSubagentStop(input);

    expect(result).toEqual({ violation: TAMPERED_VIOLATION });
    // The catch must fire before any metadata mutation.
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('ignores a delegation_active_tokens map keyed "undefined" when the hook payload has no agent_id', async () => {
    setGet(session, 'metadata', {
      delegation_active_tokens: {
        undefined: {
          kind: 'delegation-active-token',
          agent_id: 'undefined',
          tokenHash: realHashDelegationToken(VALID_TOKEN.replace('A', 'B')),
          createdAt: '2026-04-28T00:00:00.000Z',
        },
      },
      delegation_active_token: VALID_TOKEN_HASH,
      other_key: 'preserved',
    });

    // input.agent_id is undefined, so `Object.hasOwn(map, input.agent_id)`
    // would coerce to the string key "undefined" if the map were ever
    // consulted. The `if (input.agent_id)` gate must prevent that map from
    // being consulted at all for legacy (agent_id-less) payloads.
    const input = createLegacySubagentStopInput();
    const result = await handleSubagentStop(input);

    expect(result).toEqual({ violation: CLAIM_VIOLATION });
    // Legacy global token located and closure required → kept; the map keyed
    // "undefined" is left untouched (never consulted for legacy payloads).
    expect(await session.get('metadata')).toEqual({
      delegation_active_tokens: {
        undefined: expect.objectContaining({ agent_id: 'undefined' }),
      },
      delegation_active_token: VALID_TOKEN_HASH,
      other_key: 'preserved',
    });
    expect(mockReadConsumedDelegationClosureForCwd).toHaveBeenCalledWith(
      expect.any(String),
      VALID_TOKEN_HASH,
    );
  });

  it('falls back to legacy consumption when delegation_active_tokens is not a plain object map', async () => {
    setGet(session, 'metadata', {
      delegation_active_tokens: 'not-a-map',
      delegation_active_token: VALID_TOKEN_HASH,
      other_key: 'preserved',
    });

    const input = createMockHookInput('SubagentStop', {
      agent_id: 'agent-1',
      session_id: 'session-a',
    });
    const result = await handleSubagentStop(input);

    expect(result).toEqual({ violation: CLAIM_VIOLATION });
    // Falls back to the legacy global token, which is kept while closure is
    // required; the non-map value is left untouched.
    expect(await session.get('metadata')).toEqual({
      delegation_active_tokens: 'not-a-map',
      delegation_active_token: VALID_TOKEN_HASH,
      other_key: 'preserved',
    });
  });

  it('falls back to legacy locate when the requesting agent has no entry in the map', async () => {
    setGet(session, 'metadata', {
      delegation_active_tokens: {
        'agent-2': {
          kind: 'delegation-active-token',
          agent_id: 'agent-2',
          session_id: 'session-a',
          tokenHash: realHashDelegationToken(VALID_TOKEN.replace('A', 'B')),
          createdAt: '2026-04-28T00:00:00.000Z',
        },
      },
    });

    const input = createMockHookInput('SubagentStop', {
      agent_id: 'agent-1',
      session_id: 'session-a',
    });
    const result = await handleSubagentStop(input);

    expect(result).toEqual({});
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('fails closed with a violation when per-agent re-validation diverges from map-level validation (defense-in-depth)', async () => {
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
    // The map-level schema (line 76) already validated this entry; force the
    // redundant per-entry re-validation (line 85) to disagree, proving the
    // guard actually protects against a future schema/logic divergence.
    mockDelegationActiveTokenSafeParse.mockReturnValueOnce({
      success: false,
      error: new Error('schema/assert divergence'),
    });

    const input = createMockHookInput('SubagentStop', {
      agent_id: 'agent-1',
      session_id: 'session-a',
    });
    const result = await handleSubagentStop(input);

    expect(result).toEqual({ violation: TAMPERED_VIOLATION });
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('fails closed with a violation when re-validated entry agent_id diverges from the map key (defense-in-depth)', async () => {
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
    // Simulates the (otherwise schema-prevented) case where the re-parsed
    // entry's agent_id no longer matches the map key / requesting agent.
    mockDelegationActiveTokenSafeParse.mockReturnValueOnce({
      success: true,
      data: {
        kind: 'delegation-active-token',
        agent_id: 'someone-else',
        session_id: 'session-a',
        tokenHash: VALID_TOKEN_HASH,
        createdAt: '2026-04-28T00:00:00.000Z',
      },
    });

    const input = createMockHookInput('SubagentStop', {
      agent_id: 'agent-1',
      session_id: 'session-a',
    });
    const result = await handleSubagentStop(input);

    expect(result).toEqual({ violation: TAMPERED_VIOLATION });
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('fails closed with a violation when tokenHash re-assertion throws despite a schema-valid entry (defense-in-depth)', async () => {
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
    // Per the source comment at consumeDelegationTokenForAgent's tokenHash
    // assertion: the schema already validates tokenHash, so this throw is
    // unreachable today absent a future schema/assert divergence. Force it
    // to prove the wrapping catch still closes safely (tampered, not thrown).
    mockAssertDelegationTokenHash.mockImplementationOnce(() => {
      throw new Error('hash re-assertion diverged from schema validation');
    });

    const input = createMockHookInput('SubagentStop', {
      agent_id: 'agent-1',
      session_id: 'session-a',
    });
    const result = await handleSubagentStop(input);

    expect(result).toEqual({ violation: TAMPERED_VIOLATION });
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('proceeds to closure check when the entry has no session_id even though the input does', async () => {
    setGet(session, 'metadata', {
      delegation_active_tokens: {
        'agent-1': {
          kind: 'delegation-active-token',
          agent_id: 'agent-1',
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

    // Reaches the closure check (no session_id conflict); closure required by
    // default, so the token is kept.
    expect(result).toEqual({ violation: CLAIM_VIOLATION });
    expect(await session.get('metadata')).toEqual({
      delegation_active_tokens: {
        'agent-1': {
          kind: 'delegation-active-token',
          agent_id: 'agent-1',
          tokenHash: VALID_TOKEN_HASH,
          createdAt: '2026-04-28T00:00:00.000Z',
        },
      },
    });
  });

  it('fails closed with a violation when entry session_id conflicts with input session_id', async () => {
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

    const input = createMockHookInput('SubagentStop', {
      agent_id: 'agent-1',
      session_id: 'session-b',
    });
    const result = await handleSubagentStop(input);

    expect(result).toEqual({ violation: TAMPERED_VIOLATION });
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('does not consume delegation state for non-SubagentStop events even when an active token exists', async () => {
    setGet(session, 'metadata', {
      delegation_active_token: VALID_TOKEN_HASH,
      other_key: 'preserved',
    });

    const input = createMockHookInput('PostToolUse');
    const result = await handleSubagentStop(input);

    expect(result).toEqual({});
    expect(mockSet).not.toHaveBeenCalled();
  });
});
