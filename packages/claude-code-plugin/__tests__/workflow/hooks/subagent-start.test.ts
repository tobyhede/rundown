import { jest } from '@jest/globals';
import { handleSubagentStart } from '../../../src/workflow/hooks/subagent-start.js';
import { setExecSync } from '../../../src/workflow/hooks/rundown.js';
import { createMockHookInput } from '../../helpers/test-utils.js';

describe('handleSubagentStart', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    setExecSync(jest.fn() as never);
  });

  describe('event filtering', () => {
    it('returns empty result for non-SubagentStart events', () => {
      const input = createMockHookInput('PostToolUse');
      expect(handleSubagentStart(input)).toEqual({});
    });

    it('returns empty result for SubagentStop events', () => {
      const input = createMockHookInput('SubagentStop');
      expect(handleSubagentStart(input)).toEqual({});
    });
  });

  describe('agent_id validation', () => {
    it('returns empty result when agent_id is missing', () => {
      const input = createMockHookInput('SubagentStart', { agent_id: undefined });
      expect(handleSubagentStart(input)).toEqual({});
    });

    it('returns empty result when agent_id is empty string', () => {
      const input = createMockHookInput('SubagentStart', { agent_id: '' });
      expect(handleSubagentStart(input)).toEqual({});
    });
  });

  describe('rundown CLI invocation', () => {
    it('calls rundown with run --agent and agentId', () => {
      const mockExec = jest.fn().mockReturnValue('Agent bound to step 3');
      setExecSync(mockExec as never);

      const input = createMockHookInput('SubagentStart', {
        agent_id: 'agent-abc',
        cwd: '/my/project',
      });

      handleSubagentStart(input);

      expect(mockExec).toHaveBeenCalledWith(
        'node',
        expect.arrayContaining(['run', '--agent', 'agent-abc']),
        expect.objectContaining({ cwd: '/my/project' }),
      );
    });
  });

  describe('output parsing', () => {
    it('includes AGENT_ID in context', () => {
      const mockExec = jest.fn().mockReturnValue('Agent started');
      setExecSync(mockExec as never);

      const input = createMockHookInput('SubagentStart', { agent_id: 'my-agent-123' });
      const result = handleSubagentStart(input);

      expect(result.context).toContain('AGENT_ID: my-agent-123');
    });

    it('includes STEP_ID for integer step', () => {
      const mockExec = jest.fn().mockReturnValue('Agent bound to step 5');
      setExecSync(mockExec as never);

      const input = createMockHookInput('SubagentStart', { agent_id: 'agent-1' });
      const result = handleSubagentStart(input);

      expect(result.context).toContain('STEP_ID: 5');
    });

    it('includes STEP_ID for substep format', () => {
      const mockExec = jest.fn().mockReturnValue('Agent bound to step 3.2');
      setExecSync(mockExec as never);

      const input = createMockHookInput('SubagentStart', { agent_id: 'agent-1' });
      const result = handleSubagentStart(input);

      expect(result.context).toContain('STEP_ID: 3.2');
    });

    it('includes WORKFLOW when present', () => {
      const mockExec = jest.fn().mockReturnValue('Started child workflow: deploy-pipeline');
      setExecSync(mockExec as never);

      const input = createMockHookInput('SubagentStart', { agent_id: 'agent-1' });
      const result = handleSubagentStart(input);

      expect(result.context).toContain('WORKFLOW: deploy-pipeline');
    });

    it('omits STEP_ID when not in output', () => {
      const mockExec = jest.fn().mockReturnValue('Agent started without step');
      setExecSync(mockExec as never);

      const input = createMockHookInput('SubagentStart', { agent_id: 'agent-1' });
      const result = handleSubagentStart(input);

      expect(result.context).not.toContain('STEP_ID');
    });

    it('omits WORKFLOW when not in output', () => {
      const mockExec = jest.fn().mockReturnValue('Agent bound to step 1');
      setExecSync(mockExec as never);

      const input = createMockHookInput('SubagentStart', { agent_id: 'agent-1' });
      const result = handleSubagentStart(input);

      expect(result.context).not.toContain('WORKFLOW');
    });

    it('includes pass/fail commands in context', () => {
      const mockExec = jest.fn().mockReturnValue('Agent started');
      setExecSync(mockExec as never);

      const input = createMockHookInput('SubagentStart', { agent_id: 'agent-xyz' });
      const result = handleSubagentStart(input);

      expect(result.context).toContain('rundown pass --agent agent-xyz');
      expect(result.context).toContain('rundown fail --agent agent-xyz');
    });
  });

  describe('error handling', () => {
    it('returns violation when stderr contains "No pending step"', () => {
      const err = new Error('Command failed') as Error & {
        status: number;
        stderr: Buffer;
      };
      err.status = 1;
      err.stderr = Buffer.from('No pending step for agent');
      const mockExec = jest.fn().mockImplementation(() => {
        throw err;
      });
      setExecSync(mockExec as never);

      const input = createMockHookInput('SubagentStart', { agent_id: 'agent-err' });
      const result = handleSubagentStart(input);

      expect(result.violation).toContain('SubagentStart with no pending step');
    });

    it('returns empty result for non-ExecSyncError (plain Error without status/stderr)', () => {
      const mockExec = jest.fn().mockImplementation(() => {
        throw new Error('Generic error');
      });
      setExecSync(mockExec as never);

      const input = createMockHookInput('SubagentStart', { agent_id: 'agent-generic' });
      const result = handleSubagentStart(input);

      expect(result).toEqual({});
    });

    it('returns empty result for ExecSyncError with other message', () => {
      const err = new Error('Command failed') as Error & {
        status: number;
        stderr: Buffer;
      };
      err.status = 1;
      err.stderr = Buffer.from('Some other error');
      const mockExec = jest.fn().mockImplementation(() => {
        throw err;
      });
      setExecSync(mockExec as never);

      const input = createMockHookInput('SubagentStart', { agent_id: 'agent-other' });
      const result = handleSubagentStart(input);

      expect(result).toEqual({});
    });
  });
});
