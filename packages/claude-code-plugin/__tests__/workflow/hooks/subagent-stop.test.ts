// __tests__/workflow/hooks/subagent-stop.test.ts
import { jest } from '@jest/globals';
import { handleSubagentStop, setExecSync } from '../../../src/workflow/hooks/subagent-stop.js';
import {
  createMockHookInput,
  createMockExecSync,
  createMockExecSyncError
} from '../../helpers/test-utils.js';

describe('handleSubagentStop', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    // Reset execSync to default
    setExecSync(jest.fn());
  });

  describe('event filtering', () => {
    it('returns empty result for non-SubagentStop events', () => {
      const input = createMockHookInput('PostToolUse');
      const result = handleSubagentStop(input);
      expect(result).toEqual({});
    });

    it('returns empty result when agent_id is missing', () => {
      const input = createMockHookInput('SubagentStop', { agent_id: undefined });
      const result = handleSubagentStop(input);
      expect(result).toEqual({});
    });
  });

  describe('STATUS parsing', () => {
    it('parses STATUS: OK as pass', () => {
      const mockExec = createMockExecSync('Step completed');
      setExecSync(mockExec);

      const input = createMockHookInput('SubagentStop', {
        agent_id: 'agent-123',
        output: 'Some output\nSTATUS: OK\nMore output'
      });

      const result = handleSubagentStop(input);
      expect(result.context).toContain('Agent agent-123 complete');
      expect(mockExec).toHaveBeenCalledWith(
        'node',
        [expect.any(String), 'pass', '--agent', 'agent-123'],
        expect.any(Object)
      );
    });

    it('parses STATUS: PASS as pass', () => {
      const mockExec = createMockExecSync('Step completed');
      setExecSync(mockExec);

      const input = createMockHookInput('SubagentStop', {
        agent_id: 'agent-456',
        output: 'STATUS: PASS'
      });

      const result = handleSubagentStop(input);
      expect(result.context).toContain('Agent agent-456 complete');
    });

    it('parses STATUS: BLOCKED as fail', () => {
      const mockExec = createMockExecSync('Step failed');
      setExecSync(mockExec);

      const input = createMockHookInput('SubagentStop', {
        agent_id: 'agent-789',
        output: 'STATUS: BLOCKED\nReason: missing dependency'
      });

      const result = handleSubagentStop(input);
      expect(result.context).toContain('Agent agent-789 FAILED');
      expect(mockExec).toHaveBeenCalledWith(
        'node',
        [expect.any(String), 'fail', '--agent', 'agent-789'],
        expect.any(Object)
      );
    });

    it('parses STATUS: FAIL as fail', () => {
      const mockExec = createMockExecSync('Step failed');
      setExecSync(mockExec);

      const input = createMockHookInput('SubagentStop', {
        agent_id: 'agent-fail',
        output: 'STATUS: FAIL'
      });

      const result = handleSubagentStop(input);
      expect(result.context).toContain('Agent agent-fail FAILED');
    });

    it('treats missing STATUS as pass (default)', () => {
      const mockExec = createMockExecSync('Step completed');
      setExecSync(mockExec);

      const input = createMockHookInput('SubagentStop', {
        agent_id: 'agent-no-status',
        output: 'Agent completed without explicit status'
      });

      const result = handleSubagentStop(input);
      expect(result.context).toContain('Agent agent-no-status complete');
      expect(mockExec).toHaveBeenCalledWith(
        'node',
        [expect.any(String), 'pass', '--agent', 'agent-no-status'],
        expect.any(Object)
      );
    });

    it('treats undefined output as pass', () => {
      const mockExec = createMockExecSync('Step completed');
      setExecSync(mockExec);

      const input = createMockHookInput('SubagentStop', {
        agent_id: 'agent-undefined',
        output: undefined
      });

      const result = handleSubagentStop(input);
      expect(result.context).toContain('complete');
    });

    it('is case-insensitive for STATUS parsing', () => {
      const mockExec = createMockExecSync('Step failed');
      setExecSync(mockExec);

      const input = createMockHookInput('SubagentStop', {
        agent_id: 'agent-case',
        output: 'status: blocked'
      });

      const result = handleSubagentStop(input);
      expect(result.context).toContain('FAILED');
    });
  });

  describe('CLI output handling', () => {
    it('includes CLI output in context when present', () => {
      const cliOutput = 'Workflow step completed successfully.\nNext step: verify';
      const mockExec = createMockExecSync(cliOutput);
      setExecSync(mockExec);

      const input = createMockHookInput('SubagentStop', {
        agent_id: 'agent-cli',
        output: 'STATUS: OK'
      });

      const result = handleSubagentStop(input);
      expect(result.context).toContain(cliOutput);
    });

    it('handles empty CLI output gracefully', () => {
      const mockExec = createMockExecSync('   ');
      setExecSync(mockExec);

      const input = createMockHookInput('SubagentStop', {
        agent_id: 'agent-empty',
        output: 'STATUS: OK'
      });

      const result = handleSubagentStop(input);
      expect(result.context).toBeDefined();
    });
  });

  describe('error handling', () => {
    it('returns violation when agent is unknown', () => {
      const mockExec = createMockExecSyncError({
        message: 'Command failed',
        stderr: 'Error: No binding for agent agent-unknown'
      });
      setExecSync(mockExec);

      const input = createMockHookInput('SubagentStop', {
        agent_id: 'agent-unknown',
        output: 'STATUS: OK'
      });

      const result = handleSubagentStop(input);
      expect(result.violation).toContain('SubagentStop for unknown agent');
      expect(result.violation).toContain('agent-unknown');
    });

    it('returns empty result for other errors', () => {
      const mockExec = createMockExecSyncError({
        message: 'Network timeout',
        stderr: 'Connection timed out'
      });
      setExecSync(mockExec);

      const input = createMockHookInput('SubagentStop', {
        agent_id: 'agent-timeout',
        output: 'STATUS: OK'
      });

      const result = handleSubagentStop(input);
      expect(result).toEqual({});
    });

    it('handles error without stderr property', () => {
      const mockExec = jest.fn().mockImplementation(() => {
        throw new Error('Generic error');
      });
      setExecSync(mockExec);

      const input = createMockHookInput('SubagentStop', {
        agent_id: 'agent-generic',
        output: 'STATUS: OK'
      });

      const result = handleSubagentStop(input);
      expect(result).toEqual({});
    });
  });

  describe('cwd handling', () => {
    it('passes cwd to rundown CLI', () => {
      const mockExec = createMockExecSync('OK');
      setExecSync(mockExec);

      const testCwd = '/custom/project/path';
      const input = createMockHookInput('SubagentStop', {
        cwd: testCwd,
        agent_id: 'agent-cwd'
      });

      handleSubagentStop(input);
      expect(mockExec).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ cwd: testCwd })
      );
    });
  });
});
