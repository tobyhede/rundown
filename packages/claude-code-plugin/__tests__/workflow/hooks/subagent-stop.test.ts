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

    it('returns empty when parent is active with our delegation claimed', async () => {
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

      expect(result).toEqual({});
    });

    it('returns empty when no delegations remain (parent resumed)', async () => {
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

      // No delegations and our token not found — parent resumed after completion
      expect(result).toEqual({});
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

    it('does not report sibling pending delegation as unclaimed', async () => {
      mockGet.mockResolvedValue({ delegation_active_token: VALID_TOKEN });
      setExecSync(
        createStatusMock({
          active: true,
          stashed: false,
          file: 'parent.runbook.md',
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

      // Our delegation (3.1) is claimed — completed. Don't report 3.2 as unclaimed.
      expect(result).toEqual({});
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
