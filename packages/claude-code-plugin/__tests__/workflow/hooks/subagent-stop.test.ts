// __tests__/workflow/hooks/subagent-stop.test.ts
import { createHash } from 'node:crypto';
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { setExecSync } from '../../../src/workflow/hooks/rundown.js';
import { createMockHookInput, createMockExecSync } from '../../helpers/test-utils.js';

// Mock Session module
const mockGet = jest.fn();
const mockSet = jest.fn();

jest.unstable_mockModule('../../../src/session.js', () => ({
  Session: jest.fn().mockImplementation(() => ({
    get: mockGet,
    set: mockSet,
  })),
}));

const { handleSubagentStop } = await import('../../../src/workflow/hooks/subagent-stop.js');

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

  describe('child runbook completed', () => {
    it('returns empty when session is inactive (child popped)', async () => {
      mockGet.mockResolvedValue({ delegation_active_token: VALID_TOKEN });
      setExecSync(createStatusMock({ active: false, stashed: false }) as never);

      const input = createMockHookInput('SubagentStop');
      const result = await handleSubagentStop(input);

      expect(result).toEqual({});
    });

    it('surfaces parent state when our delegation claimed and no siblings remain', async () => {
      mockGet.mockResolvedValue({ delegation_active_token: VALID_TOKEN });
      setExecSync(
        createStatusMock({
          active: true,
          stashed: false,
          file: 'parent.runbook.md',
          delegations: [
            {
              substep: '3.1',
              runbook: 'child.runbook.md',
              state: 'claimed',
              childRunId: 'run-1',
              tokenHash: VALID_TOKEN_HASH,
            },
          ],
        }) as never,
      );

      const input = createMockHookInput('SubagentStop');
      const result = await handleSubagentStop(input);

      expect(result.context).toContain('Delegation Step Complete');
      expect(result.context).toContain('parent.runbook.md');
    });

    it('surfaces parent state when no delegations remain (parent resumed)', async () => {
      mockGet.mockResolvedValue({ delegation_active_token: VALID_TOKEN });
      setExecSync(
        createStatusMock({
          active: true,
          stashed: false,
          file: 'parent.runbook.md',
        }) as never,
      );

      const input = createMockHookInput('SubagentStop');
      const result = await handleSubagentStop(input);

      expect(result.context).toContain('Delegation Step Complete');
      expect(result.context).toContain('parent.runbook.md');
    });

    it('treats unrecognized delegations as child with nested delegations', async () => {
      mockGet.mockResolvedValue({ delegation_active_token: VALID_TOKEN });
      setExecSync(
        createStatusMock({
          active: true,
          stashed: false,
          file: 'child.runbook.md',
          delegations: [
            {
              substep: '1.1',
              runbook: 'grandchild.runbook.md',
              state: 'pending',
              tokenHash: OTHER_TOKEN_HASH,
            },
          ],
        }) as never,
      );

      const input = createMockHookInput('SubagentStop');
      const result = await handleSubagentStop(input);

      // Delegations present but none match our token — child with nested delegations
      expect(result.context).toContain('Delegation Incomplete');
      expect(result.context).toContain('child.runbook.md');
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

    it('surfaces remaining delegations when siblings still pending', async () => {
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
      expect(result.context).toContain('2 delegations still pending');
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

    it('preserves delegations when active+stashed (active child + stashed parent)', async () => {
      mockGet.mockResolvedValue({ delegation_active_token: VALID_TOKEN });
      setExecSync(
        createStatusMock({
          active: true,
          stashed: true,
          file: 'child.runbook.md',
          step: { name: '3. Deploy' },
          position: { current: '3', total: 5 },
          delegations: [
            {
              substep: '3.1',
              runbook: 'grandchild.runbook.md',
              state: 'claimed',
              childRunId: 'run-gc-1',
              tokenHash: OTHER_TOKEN_HASH,
            },
          ],
        }) as never,
      );

      const input = createMockHookInput('SubagentStop');
      const result = await handleSubagentStop(input);

      // Should be classified as active (preserving delegations), not stashed
      expect(result.context).toContain('Delegation Incomplete');
      expect(result.context).toContain('child.runbook.md');
    });
  });

  describe('child runbook still active (nested delegations)', () => {
    /** Status mock for a child runbook that has its own nested delegations. */
    function childWithNestedDelegations(overrides: Record<string, unknown> = {}) {
      return createStatusMock({
        active: true,
        stashed: false,
        file: 'child.runbook.md',
        delegations: [
          {
            substep: '1.1',
            runbook: 'grandchild.runbook.md',
            state: 'pending',
            tokenHash: OTHER_TOKEN_HASH,
          },
        ],
        ...overrides,
      });
    }

    it('returns context when child has nested delegations', async () => {
      mockGet.mockResolvedValue({ delegation_active_token: VALID_TOKEN });
      setExecSync(
        childWithNestedDelegations({
          step: { name: '2. Review changes' },
          position: { current: '2', total: 5 },
        }) as never,
      );

      const input = createMockHookInput('SubagentStop');
      const result = await handleSubagentStop(input);

      expect(result.context).toContain('Delegation Incomplete');
      expect(result.context).toContain('child.runbook.md');
      expect(result.context).toContain('2. Review changes');
      expect(result.context).toContain('step 2 of 5');
    });

    it('includes actionable instructions in context', async () => {
      mockGet.mockResolvedValue({ delegation_active_token: VALID_TOKEN });
      setExecSync(childWithNestedDelegations() as never);

      const input = createMockHookInput('SubagentStop');
      const result = await handleSubagentStop(input);

      expect(result.context).toContain('rd status');
      expect(result.context).toContain('retry');
      expect(result.context).toContain('verify before proceeding');
    });

    it('includes step description when available', async () => {
      mockGet.mockResolvedValue({ delegation_active_token: VALID_TOKEN });
      setExecSync(
        childWithNestedDelegations({
          step: { name: '3. Deploy', description: 'Deploy to staging' },
        }) as never,
      );

      const input = createMockHookInput('SubagentStop');
      const result = await handleSubagentStop(input);

      expect(result.context).toContain('3. Deploy — Deploy to staging');
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

    it('surfaces remaining sibling delegations when our delegation completes', async () => {
      mockGet.mockResolvedValue({ delegation_active_token: VALID_TOKEN });
      setExecSync(
        createStatusMock({
          active: true,
          stashed: false,
          file: 'parent.runbook.md',
          step: { name: '3. Delegate subagents' },
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
              state: 'pending',
              tokenHash: OTHER_TOKEN_HASH,
            },
          ],
        }) as never,
      );

      const input = createMockHookInput('SubagentStop');
      const result = await handleSubagentStop(input);

      // Our delegation (3.1) completed. Sibling 3.2 still pending.
      expect(result.context).toContain('Delegation Completed');
      expect(result.context).not.toContain('Delegation Step Complete');
      expect(result.context).toContain('1 delegation still pending');
      expect(result.context).toContain('child-b.runbook.md');
      expect(result.context).not.toContain('child-a.runbook.md');
    });
  });

  describe('unverifiable delegations (missing tokenHash)', () => {
    it('returns unknown when no delegations have tokenHash', async () => {
      mockGet.mockResolvedValue({ delegation_active_token: VALID_TOKEN });
      setExecSync(
        createStatusMock({
          active: true,
          stashed: false,
          file: 'parent.runbook.md',
          delegations: [
            {
              substep: '2.1',
              runbook: 'child.runbook.md',
              state: 'claimed',
              childRunId: 'run-old',
            },
          ],
        }) as never,
      );

      const input = createMockHookInput('SubagentStop');
      const result = await handleSubagentStop(input);

      expect(result.context).toContain('Unable to verify');
      expect(result.context).toContain('rd status');
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
