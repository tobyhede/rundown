// __tests__/workflow/hooks/subagent-stop.test.ts
import { createHash } from 'node:crypto';
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { setExecSync } from '../../../src/workflow/hooks/rundown.js';
import { createMockHookInput } from '../../helpers/test-utils.js';
import { mockExecFileSync } from '../../helpers/execfile-mock.js';
import type {
  DelegationStatus,
  ParentLinkage,
  RunbookPosition,
  RunbookStatus,
} from '../../../src/workflow/hooks/subagent-stop.js';

// Mock Session module
import { createSessionMock, setGet } from '../../helpers/session-mock.js';

const session = createSessionMock();
const mockSet = session.set;

jest.unstable_mockModule('../../../src/session.js', () => ({
  Session: jest.fn().mockImplementation(() => session),
}));

const { handleSubagentStop, classifyOutcome, parseDelegations } = await import(
  '../../../src/workflow/hooks/subagent-stop.js'
);

const VALID_TOKEN = 'rdtk_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const VALID_TOKEN_HASH = `sha256:${createHash('sha256').update(VALID_TOKEN).digest('hex')}`;
const OTHER_TOKEN_HASH = `sha256:${createHash('sha256').update('rdtk_OTHER00000000000000000000000').digest('hex')}`;

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
    setExecSync(mockExecFileSync(''));
  });

  afterEach(() => {
    setExecSync(mockExecFileSync(''));
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

  it('consumes active delegation token and returns claim-id closure violation', async () => {
    setGet(session, 'metadata', {
      delegation_active_token: VALID_TOKEN,
      other_key: 'preserved',
    });
    const mockExec = mockExecFileSync('{}');
    setExecSync(mockExec);

    const input = createLegacySubagentStopInput();
    const result = await handleSubagentStop(input);

    expect(result).toEqual({
      violation:
        'Delegated Rundown work must be closed explicitly with rd pass --claim-id <claim_id> or rd fail --claim-id <claim_id>.',
    });
    expect(mockSet).toHaveBeenCalledWith('metadata', { other_key: 'preserved' });
    expect(mockExec).not.toHaveBeenCalled();
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

    expect(result).toEqual({
      violation:
        'Delegated Rundown work must be closed explicitly with rd pass --claim-id <claim_id> or rd fail --claim-id <claim_id>.',
    });
    expect(mockSet).toHaveBeenCalledWith('metadata', {
      delegation_active_tokens: {
        'agent-2': expect.objectContaining({
          agent_id: 'agent-2',
          tokenHash: siblingTokenHash,
        }),
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Unit tests — branch logic, no Session/rundown mocks, plain fixtures.
// ---------------------------------------------------------------------------

/** Build a minimal active RunbookStatus for classifyOutcome tests. */
function activeStatus(
  overrides: {
    delegations?: readonly DelegationStatus[];
    hadInvalidDelegations?: boolean;
    parentLinkage?: ParentLinkage;
    position?: RunbookPosition;
  } = {},
): RunbookStatus {
  const { delegations = [], hadInvalidDelegations = false, parentLinkage, position } = overrides;
  return {
    kind: 'active',
    file: position?.file ?? 'parent.runbook.md',
    position: position?.position,
    step: position?.step,
    delegations,
    hadInvalidDelegations,
    ...(parentLinkage ? { parentLinkage } : {}),
  };
}

describe('classifyOutcome (unit)', () => {
  describe('inactive', () => {
    it('returns completed with parent undefined', () => {
      const outcome = classifyOutcome({ kind: 'inactive' }, VALID_TOKEN_HASH);
      expect(outcome.kind).toBe('completed');
      if (outcome.kind === 'completed') {
        expect(outcome.parent).toBeUndefined();
      }
    });
  });

  describe('stashed', () => {
    it('returns child_stashed carrying the stashed status', () => {
      const status: RunbookStatus = {
        kind: 'stashed',
        file: 'child.runbook.md',
        step: { name: '2. Review' },
        position: { current: '2', total: 4 },
      };
      const outcome = classifyOutcome(status, VALID_TOKEN_HASH);
      expect(outcome.kind).toBe('child_stashed');
      if (outcome.kind === 'child_stashed') {
        expect(outcome.status.file).toBe('child.runbook.md');
      }
    });
  });

  describe('active: parentLinkage correlation', () => {
    it('returns child_claimed_idle when parentLinkage.tokenHash matches', () => {
      const status = activeStatus({
        parentLinkage: {
          kind: 'delegation',
          tokenHash: VALID_TOKEN_HASH,
          parentRunId: 'parent-run-1',
          parentStepId: '1.1',
        },
      });
      const outcome = classifyOutcome(status, VALID_TOKEN_HASH);
      expect(outcome.kind).toBe('child_claimed_idle');
    });

    it('returns unknown when claimed-idle invariant is violated (child has outgoing delegations)', () => {
      const status = activeStatus({
        parentLinkage: {
          kind: 'delegation',
          tokenHash: VALID_TOKEN_HASH,
          parentRunId: 'parent-run-1',
          parentStepId: '1.1',
        },
        delegations: [
          {
            state: 'pending',
            substep: '2.1',
            runbook: 'grandchild.runbook.md',
            tokenHash: OTHER_TOKEN_HASH,
          },
        ],
      });
      const outcome = classifyOutcome(status, VALID_TOKEN_HASH);
      expect(outcome.kind).toBe('unknown');
    });

    it('returns unknown when parentLinkage is inline (no tokenHash to match)', () => {
      const status = activeStatus({
        parentLinkage: {
          kind: 'inline',
          parentRunId: 'parent-run-1',
          parentStepId: '1.1',
        },
      });
      const outcome = classifyOutcome(status, VALID_TOKEN_HASH);
      expect(outcome.kind).toBe('unknown');
    });

    it('returns unknown when parentLinkage.tokenHash does not match ours', () => {
      const status = activeStatus({
        parentLinkage: {
          kind: 'delegation',
          tokenHash: OTHER_TOKEN_HASH,
          parentRunId: 'parent-run-1',
          parentStepId: '1.1',
        },
      });
      const outcome = classifyOutcome(status, VALID_TOKEN_HASH);
      expect(outcome.kind).toBe('unknown');
    });

    it('returns unknown when parentLinkage is malformed', () => {
      const status = activeStatus({ parentLinkage: { kind: 'malformed' } });
      const outcome = classifyOutcome(status, VALID_TOKEN_HASH);
      expect(outcome.kind).toBe('unknown');
    });
  });

  describe('active: no parentLinkage (parent resumed path)', () => {
    it('returns completed with parent when no matching delegation and no invalid entries', () => {
      const status = activeStatus();
      const outcome = classifyOutcome(status, VALID_TOKEN_HASH);
      expect(outcome.kind).toBe('completed');
      if (outcome.kind === 'completed') {
        expect(outcome.parent).toBeDefined();
        expect(outcome.parent?.delegations).toEqual([]);
      }
    });

    it('returns unknown when no match and hadInvalidDelegations is true', () => {
      const status = activeStatus({ hadInvalidDelegations: true });
      const outcome = classifyOutcome(status, VALID_TOKEN_HASH);
      expect(outcome.kind).toBe('unknown');
    });

    it('returns unclaimed when our token matches a pending delegation', () => {
      const pending: DelegationStatus = {
        state: 'pending',
        substep: '3.1',
        runbook: 'child.runbook.md',
        tokenHash: VALID_TOKEN_HASH,
      };
      const status = activeStatus({ delegations: [pending] });
      const outcome = classifyOutcome(status, VALID_TOKEN_HASH);
      expect(outcome.kind).toBe('unclaimed');
      if (outcome.kind === 'unclaimed') {
        expect(outcome.delegation.substep).toBe('3.1');
      }
    });

    it('returns completed with filtered siblings when our token matches a claimed delegation', () => {
      const ours: DelegationStatus = {
        state: 'claimed',
        substep: '3.1',
        runbook: 'child-a.runbook.md',
        childRunId: 'run-1',
        tokenHash: VALID_TOKEN_HASH,
      };
      const sibling: DelegationStatus = {
        state: 'pending',
        substep: '3.2',
        runbook: 'child-b.runbook.md',
        tokenHash: OTHER_TOKEN_HASH,
      };
      const status = activeStatus({ delegations: [ours, sibling] });
      const outcome = classifyOutcome(status, VALID_TOKEN_HASH);
      expect(outcome.kind).toBe('completed');
      if (outcome.kind === 'completed') {
        expect(outcome.parent?.delegations).toEqual([sibling]);
      }
    });

    it('returns completed (not unclaimed) when our token matches a cancelled delegation', () => {
      const ours: DelegationStatus = {
        state: 'cancelled',
        substep: '3.1',
        runbook: 'child.runbook.md',
        tokenHash: VALID_TOKEN_HASH,
      };
      const outcome = classifyOutcome(activeStatus({ delegations: [ours] }), VALID_TOKEN_HASH);
      expect(outcome.kind).toBe('completed');
    });

    it('pins ordering: ours-lookup precedes hadInvalidDelegations guard, siblings filtered', () => {
      // Regression guard: if hadInvalidDelegations were checked above the ours
      // lookup, this fixture would return unknown. Today it returns completed
      // with the sibling preserved and ours filtered out via toParentState.
      const ours: DelegationStatus = {
        state: 'claimed',
        substep: '3.1',
        runbook: 'child-ours.runbook.md',
        childRunId: 'run-ours',
        tokenHash: VALID_TOKEN_HASH,
      };
      const sibling: DelegationStatus = {
        state: 'pending',
        substep: '3.2',
        runbook: 'sibling.runbook.md',
        tokenHash: OTHER_TOKEN_HASH,
      };
      const status = activeStatus({
        delegations: [ours, sibling],
        hadInvalidDelegations: true,
      });
      const outcome = classifyOutcome(status, VALID_TOKEN_HASH);
      expect(outcome.kind).toBe('completed');
      if (outcome.kind === 'completed') {
        expect(outcome.parent?.delegations).toEqual([sibling]);
        expect(outcome.parent?.delegations).not.toContainEqual(ours);
      }
    });
  });
});

describe('parseDelegations (unit)', () => {
  const VALID_ENTRY: DelegationStatus = {
    state: 'pending',
    substep: '1.1',
    runbook: 'child.runbook.md',
    tokenHash: VALID_TOKEN_HASH,
  };

  describe('non-array inputs', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['string', 'not-an-array'],
      ['number', 42],
      ['object', { nope: true }],
    ])('treats %s as absent, not invalid', (_label, input) => {
      expect(parseDelegations(input)).toEqual({ entries: [], hadInvalid: false });
    });
  });

  describe('empty array', () => {
    it('returns no entries and hadInvalid false', () => {
      expect(parseDelegations([])).toEqual({ entries: [], hadInvalid: false });
    });
  });

  describe('all-valid array', () => {
    it('preserves entries and reports hadInvalid false', () => {
      const result = parseDelegations([VALID_ENTRY]);
      expect(result.hadInvalid).toBe(false);
      expect(result.entries).toEqual([VALID_ENTRY]);
    });
  });

  describe('mixed valid and invalid', () => {
    it('drops entries missing tokenHash and sets hadInvalid true', () => {
      const stale = {
        state: 'claimed',
        substep: '1.2',
        runbook: 'stale.runbook.md',
        childRunId: 'run-stale',
        // Missing tokenHash — pre-migration session state.
      };
      const result = parseDelegations([VALID_ENTRY, stale]);
      expect(result.hadInvalid).toBe(true);
      expect(result.entries).toEqual([VALID_ENTRY]);
    });
  });

  describe('primitive entries', () => {
    it('rejects primitives and sets hadInvalid true', () => {
      const result = parseDelegations([null, 42, 'bogus']);
      expect(result.hadInvalid).toBe(true);
      expect(result.entries).toEqual([]);
    });
  });
});
