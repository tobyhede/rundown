// __tests__/workflow/hooks/subagent-stop.test.ts
import { createHash } from 'node:crypto';
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { setExecSync } from '../../../src/workflow/hooks/rundown.js';
import { createMockHookInput, createMockExecSync } from '../../helpers/test-utils.js';
import type {
  DelegationStatus,
  ParentLinkage,
  RunbookPosition,
  RunbookStatus,
} from '../../../src/workflow/hooks/subagent-stop.js';

// Mock Session module
const mockGet = jest.fn();
const mockSet = jest.fn();

jest.unstable_mockModule('../../../src/session.js', () => ({
  Session: jest.fn().mockImplementation(() => ({
    get: mockGet,
    set: mockSet,
  })),
}));

const { handleSubagentStop, classifyOutcome, parseDelegations } = await import(
  '../../../src/workflow/hooks/subagent-stop.js'
);

const VALID_TOKEN = 'rdtk_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const VALID_TOKEN_HASH = `sha256:${createHash('sha256').update(VALID_TOKEN).digest('hex')}`;
const OTHER_TOKEN_HASH = `sha256:${createHash('sha256').update('rdtk_OTHER00000000000000000000000').digest('hex')}`;

/** Helper to create a mock that returns `rd status --json` output. */
function createStatusMock(status: Record<string, unknown>) {
  return createMockExecSync(JSON.stringify(status));
}

describe('handleSubagentStop', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockResolvedValue({});
    mockSet.mockResolvedValue(undefined);
    setExecSync(jest.fn() as never);
  });

  afterEach(() => {
    setExecSync(jest.fn() as never);
  });

  describe('event filtering', () => {
    it('returns empty result for non-SubagentStop events', async () => {
      const input = createMockHookInput('PostToolUse');
      const result = await handleSubagentStop(input);
      expect(result).toEqual({});
    });
  });

  describe('no delegation token', () => {
    it('returns empty when no delegation_active_token in session', async () => {
      mockGet.mockResolvedValue({});
      const input = createMockHookInput('SubagentStop');
      const result = await handleSubagentStop(input);
      expect(result).toEqual({});
    });

    it('does not call rd status when no token', async () => {
      mockGet.mockResolvedValue({});
      const mockExec = createMockExecSync('{}');
      setExecSync(mockExec as never);

      const input = createMockHookInput('SubagentStop');
      await handleSubagentStop(input);

      expect(mockExec).not.toHaveBeenCalled();
    });
  });

  describe('token consumption', () => {
    it('clears delegation_active_token from session (consume-once)', async () => {
      mockGet.mockResolvedValue({
        delegation_active_token: VALID_TOKEN,
        other_key: 'preserved',
      });
      setExecSync(createStatusMock({ active: false, stashed: false }) as never);

      const input = createMockHookInput('SubagentStop');
      await handleSubagentStop(input);

      expect(mockSet).toHaveBeenCalledWith('metadata', { other_key: 'preserved' });
    });

    it('clears token regardless of child runbook state', async () => {
      mockGet.mockResolvedValue({ delegation_active_token: VALID_TOKEN });
      setExecSync(
        createStatusMock({
          active: true,
          stashed: false,
          file: 'child.runbook.md',
        }) as never,
      );

      const input = createMockHookInput('SubagentStop');
      await handleSubagentStop(input);

      expect(mockSet).toHaveBeenCalledWith('metadata', {});
    });
  });

  describe('child runbook claimed but idle (parentLinkage correlation)', () => {
    it('classifies claimed-idle via parentLinkage.tokenHash match', async () => {
      mockGet.mockResolvedValue({ delegation_active_token: VALID_TOKEN });
      setExecSync(
        createStatusMock({
          active: true,
          stashed: false,
          file: 'child.runbook.md',
          position: { current: '1', total: 3 },
          step: { name: '1. Starting step' },
          parentLinkage: {
            kind: 'delegation',
            tokenHash: VALID_TOKEN_HASH,
            parentRunId: 'parent-run-1',
            parentStepId: '1.1',
            parentStep: '1',
          },
        }) as never,
      );

      const input = createMockHookInput('SubagentStop');
      const result = await handleSubagentStop(input);

      expect(result.context).toContain('Delegation Not Resolved');
      expect(result.context).toContain('child.runbook.md');
      expect(result.context).toContain('1. Starting step');
      expect(result.context).not.toContain('Delegation Step Complete');
    });
  });

  describe('parent state surfacing on completion', () => {
    it('surfaces full step info when parent advanced to new step', async () => {
      mockGet.mockResolvedValue({ delegation_active_token: VALID_TOKEN });
      setExecSync(
        createStatusMock({
          active: true,
          stashed: false,
          file: 'parent.runbook.md',
          position: { current: '4', total: 10 },
          step: {
            name: '4. Collate review findings',
            description: 'Aggregate results from all reviews',
          },
        }) as never,
      );

      const input = createMockHookInput('SubagentStop');
      const result = await handleSubagentStop(input);

      expect(result.context).toContain('Delegation Step Complete');
      expect(result.context).toContain('parent.runbook.md');
      expect(result.context).toContain(
        '4. Collate review findings — Aggregate results from all reviews',
      );
      expect(result.context).toContain('step 4 of 10');
    });

    it('includes delegation guidance when parent step has unresolved substeps', async () => {
      mockGet.mockResolvedValue({ delegation_active_token: VALID_TOKEN });
      setExecSync(
        createStatusMock({
          active: true,
          stashed: false,
          file: 'parent.runbook.md',
          position: { current: '4', total: 4, unresolved: 1 },
          step: {
            name: '4. Collate review findings',
            description: 'Delegate a subagent to collate the review findings',
          },
        }) as never,
      );

      const input = createMockHookInput('SubagentStop');
      const result = await handleSubagentStop(input);

      expect(result.context).toContain('Delegation Step Complete');
      expect(result.context).toContain('1 unresolved substep requiring delegation');
      expect(result.context).toContain(
        'Run `rd delegate` to create a delegation token, then dispatch a subagent to claim it.',
      );
      expect(result.context).not.toContain('Proceed with the current step');
    });

    it('pluralizes substeps when multiple are unresolved', async () => {
      mockGet.mockResolvedValue({ delegation_active_token: VALID_TOKEN });
      setExecSync(
        createStatusMock({
          active: true,
          stashed: false,
          file: 'parent.runbook.md',
          position: { current: '3', total: 5, unresolved: 3 },
          step: { name: '3. Deploy services' },
        }) as never,
      );

      const input = createMockHookInput('SubagentStop');
      const result = await handleSubagentStop(input);

      expect(result.context).toContain('3 unresolved substeps requiring delegation');
      expect(result.context).not.toContain('substep requiring');
    });

    it('shows generic proceed message when parent step has no unresolved substeps', async () => {
      mockGet.mockResolvedValue({ delegation_active_token: VALID_TOKEN });
      setExecSync(
        createStatusMock({
          active: true,
          stashed: false,
          file: 'parent.runbook.md',
          position: { current: '4', total: 10 },
          step: { name: '4. Final step' },
        }) as never,
      );

      const input = createMockHookInput('SubagentStop');
      const result = await handleSubagentStop(input);

      expect(result.context).toContain('Delegation Step Complete');
      expect(result.context).toContain('Proceed with the current step');
      expect(result.context).not.toContain('unresolved');
    });

    it('surfaces remaining delegations when siblings still unresolved', async () => {
      mockGet.mockResolvedValue({ delegation_active_token: VALID_TOKEN });
      setExecSync(
        createStatusMock({
          active: true,
          stashed: false,
          file: 'parent.runbook.md',
          position: { current: '3', total: 10 },
          step: { name: '3. Delegate subagents' },
          delegations: [
            {
              substep: '3.1',
              runbook: 'review-code.runbook.md',
              state: 'claimed',
              childRunId: 'run-1',
              tokenHash: VALID_TOKEN_HASH,
            },
            {
              substep: '3.2',
              runbook: 'review-structural.runbook.md',
              state: 'claimed',
              childRunId: 'run-2',
              tokenHash: OTHER_TOKEN_HASH,
            },
            {
              substep: '3.3',
              runbook: 'review-build.runbook.md',
              state: 'pending',
              tokenHash: `sha256:${createHash('sha256').update('rdtk_THIRD000000000000000000000000').digest('hex')}`,
            },
          ],
        }) as never,
      );

      const input = createMockHookInput('SubagentStop');
      const result = await handleSubagentStop(input);

      expect(result.context).toContain('Delegation Completed');
      expect(result.context).not.toContain('Delegation Step Complete');
      expect(result.context).toContain('2 delegations still unresolved');
      expect(result.context).toContain('review-structural.runbook.md');
      expect(result.context).toContain('review-build.runbook.md');
      expect(result.context).not.toContain('review-code.runbook.md');
      expect(result.context).toContain('3. Delegate subagents');
    });

    it('treats cancelled sibling delegations as resolved', async () => {
      mockGet.mockResolvedValue({ delegation_active_token: VALID_TOKEN });
      setExecSync(
        createStatusMock({
          active: true,
          stashed: false,
          file: 'parent.runbook.md',
          position: { current: '4', total: 10 },
          step: { name: '4. Next step' },
          delegations: [
            {
              substep: '3.1',
              runbook: 'child-a.runbook.md',
              state: 'claimed',
              childRunId: 'run-1',
              tokenHash: VALID_TOKEN_HASH,
            },
            {
              substep: '3.2',
              runbook: 'child-b.runbook.md',
              state: 'cancelled',
              tokenHash: OTHER_TOKEN_HASH,
            },
          ],
        }) as never,
      );

      const input = createMockHookInput('SubagentStop');
      const result = await handleSubagentStop(input);

      // Our delegation filtered out, sibling is cancelled — no pending siblings
      expect(result.context).toContain('Delegation Step Complete');
      expect(result.context).not.toContain('Remaining delegations');
    });

    it('returns empty when parent is inactive (entire runbook finished)', async () => {
      mockGet.mockResolvedValue({ delegation_active_token: VALID_TOKEN });
      setExecSync(createStatusMock({ active: false, stashed: false }) as never);

      const input = createMockHookInput('SubagentStop');
      const result = await handleSubagentStop(input);

      expect(result).toEqual({});
    });
  });

  describe('child runbook stashed', () => {
    it('treats stashed runbook as incomplete', async () => {
      mockGet.mockResolvedValue({ delegation_active_token: VALID_TOKEN });
      setExecSync(
        createStatusMock({
          active: false,
          stashed: true,
          file: 'child.runbook.md',
          step: { name: '2. Review' },
          position: { current: '2', total: 4 },
        }) as never,
      );

      const input = createMockHookInput('SubagentStop');
      const result = await handleSubagentStop(input);

      expect(result.context).toContain('Delegation Stashed');
      expect(result.context).toContain('stashed without being completed');
      expect(result.context).toContain('child.runbook.md');
      expect(result.context).toContain('2. Review');
      expect(result.context).toContain('rd pop');
    });
  });

  describe('delegation never claimed', () => {
    it('reports unclaimed when our token matches a pending delegation', async () => {
      mockGet.mockResolvedValue({ delegation_active_token: VALID_TOKEN });
      setExecSync(
        createStatusMock({
          active: true,
          stashed: false,
          file: 'parent.runbook.md',
          step: { name: '3. Deploy' },
          delegations: [
            {
              substep: '3.1',
              runbook: 'child.runbook.md',
              state: 'pending',
              tokenHash: VALID_TOKEN_HASH,
            },
          ],
        }) as never,
      );

      const input = createMockHookInput('SubagentStop');
      const result = await handleSubagentStop(input);

      expect(result.context).toContain('Delegation Never Claimed');
      expect(result.context).toContain('substep 3.1');
      expect(result.context).toContain('child.runbook.md');
    });
  });

  describe('status check failure', () => {
    it('returns fallback context when rd status --json fails', async () => {
      mockGet.mockResolvedValue({ delegation_active_token: VALID_TOKEN });
      const mockExec = jest.fn().mockImplementation(() => {
        throw new Error('CLI error');
      });
      setExecSync(mockExec as never);

      const input = createMockHookInput('SubagentStop');
      const result = await handleSubagentStop(input);

      expect(result.context).toContain('Unable to verify child runbook state');
      expect(result.context).toContain('rd status');
    });
  });

  describe('parser robustness (malformed status fields)', () => {
    it('degrades gracefully when position is missing required fields', async () => {
      mockGet.mockResolvedValue({ delegation_active_token: VALID_TOKEN });
      setExecSync(
        createStatusMock({
          active: true,
          stashed: false,
          file: 'parent.runbook.md',
          // Missing `current` and `total` — RunbookPositionBodySchema rejects,
          // parsePosition returns undefined, banner simply omits position line.
          position: { substep: '1.1' },
          step: { name: '4. Collate review findings' },
        }) as never,
      );

      const input = createMockHookInput('SubagentStop');
      const result = await handleSubagentStop(input);

      expect(result.context).toContain('Delegation Step Complete');
      expect(result.context).toContain('4. Collate review findings');
      expect(result.context).not.toContain('step undefined');
    });

    it('degrades gracefully when step has wrong types', async () => {
      mockGet.mockResolvedValue({ delegation_active_token: VALID_TOKEN });
      setExecSync(
        createStatusMock({
          active: true,
          stashed: false,
          file: 'parent.runbook.md',
          position: { current: '2', total: 5 },
          step: { name: 42, description: true },
        }) as never,
      );

      const input = createMockHookInput('SubagentStop');
      const result = await handleSubagentStop(input);

      // Invalid step → undefined; position still renders.
      expect(result.context).toContain('Delegation Step Complete');
      expect(result.context).toContain('step 2 of 5');
    });

    it('does not throw when status is null', async () => {
      mockGet.mockResolvedValue({ delegation_active_token: VALID_TOKEN });
      setExecSync(createMockExecSync('null') as never);

      const input = createMockHookInput('SubagentStop');
      // Should return a result object (unknown fallback), not throw.
      await expect(handleSubagentStop(input)).resolves.toEqual(
        expect.objectContaining({ context: expect.stringContaining('Unable to verify') }),
      );
    });
  });

  describe('last_assistant_message is not parsed', () => {
    it('does not use agent output to determine result', async () => {
      mockGet.mockResolvedValue({ delegation_active_token: VALID_TOKEN });
      // Child completed — should return empty regardless of message content
      setExecSync(createStatusMock({ active: false, stashed: false }) as never);

      const input = createMockHookInput('SubagentStop', {
        last_assistant_message: 'STATUS: FAIL\nEverything broke',
      });
      const result = await handleSubagentStop(input);

      expect(result).toEqual({});
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
