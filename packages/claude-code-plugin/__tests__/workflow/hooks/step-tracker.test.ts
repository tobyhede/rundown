import { jest } from '@jest/globals';
import { trackStepDispatch } from '../../../src/workflow/hooks/step-tracker.js';
import { setExecSync } from '../../../src/workflow/hooks/rundown.js';
import { createMockHookInput } from '../../helpers/test-utils.js';

describe('trackStepDispatch', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    setExecSync(jest.fn() as never);
  });

  describe('event filtering', () => {
    it('returns empty result for non-Step/Task tool names', () => {
      const input = createMockHookInput('PostToolUse', { tool_name: 'Edit' });
      expect(trackStepDispatch(input)).toEqual({});
    });

    it('returns empty result for Write tool', () => {
      const input = createMockHookInput('PostToolUse', { tool_name: 'Write' });
      expect(trackStepDispatch(input)).toEqual({});
    });
  });

  describe('Step tool processing', () => {
    it('processes Step tool name', () => {
      const mockExec = jest.fn().mockReturnValue('ok');
      setExecSync(mockExec as never);

      const input = createMockHookInput('PostToolUse', {
        tool_name: 'Step',
        tool_input: { description: 'Do something' },
      });

      const result = trackStepDispatch(input);
      expect(result).toEqual({});
      expect(mockExec).toHaveBeenCalled();
    });

    it('processes Task tool name', () => {
      const mockExec = jest.fn().mockReturnValue('ok');
      setExecSync(mockExec as never);

      const input = createMockHookInput('PostToolUse', {
        tool_name: 'Task',
        tool_input: { description: 'Do something' },
      });

      const result = trackStepDispatch(input);
      expect(result).toEqual({});
      expect(mockExec).toHaveBeenCalled();
    });
  });

  describe('description validation', () => {
    it('returns violation when description is empty', () => {
      const input = createMockHookInput('PostToolUse', {
        tool_name: 'Step',
        tool_input: { description: '' },
      });

      const result = trackStepDispatch(input);
      expect(result.violation).toBe('Step description cannot be empty');
    });

    it('returns violation when description is whitespace', () => {
      const input = createMockHookInput('PostToolUse', {
        tool_name: 'Step',
        tool_input: { description: '   ' },
      });

      const result = trackStepDispatch(input);
      expect(result.violation).toBe('Step description cannot be empty');
    });

    it('returns violation when description is missing', () => {
      const input = createMockHookInput('PostToolUse', {
        tool_name: 'Step',
        tool_input: {},
      });

      const result = trackStepDispatch(input);
      expect(result.violation).toBe('Step description cannot be empty');
    });
  });

  describe('rundown CLI invocation', () => {
    it('calls rundown with run --step and escaped description', () => {
      const mockExec = jest.fn().mockReturnValue('ok');
      setExecSync(mockExec as never);

      const input = createMockHookInput('PostToolUse', {
        tool_name: 'Step',
        tool_input: { description: 'Run unit tests' },
        cwd: '/my/project',
      });

      trackStepDispatch(input);

      expect(mockExec).toHaveBeenCalledWith(
        'node',
        expect.arrayContaining(['run', '--step', 'Run unit tests']),
        expect.objectContaining({ cwd: '/my/project' }),
      );
    });

    it('escapes shell-special characters in description', () => {
      const mockExec = jest.fn().mockReturnValue('ok');
      setExecSync(mockExec as never);

      const input = createMockHookInput('PostToolUse', {
        tool_name: 'Step',
        tool_input: { description: 'Deploy "staging" env $HOME' },
      });

      trackStepDispatch(input);

      // shellEscape escapes double quotes, backticks, backslashes, and dollar signs
      expect(mockExec).toHaveBeenCalledWith(
        'node',
        expect.arrayContaining(['run', '--step', 'Deploy \\"staging\\" env \\$HOME']),
        expect.any(Object),
      );
    });

    it('returns empty result on success', () => {
      const mockExec = jest.fn().mockReturnValue('step tracked');
      setExecSync(mockExec as never);

      const input = createMockHookInput('PostToolUse', {
        tool_name: 'Step',
        tool_input: { description: 'Build project' },
      });

      expect(trackStepDispatch(input)).toEqual({});
    });

    it('returns empty result when rundown throws', () => {
      const mockExec = jest.fn().mockImplementation(() => {
        throw new Error('rundown failed');
      });
      setExecSync(mockExec as never);

      const input = createMockHookInput('PostToolUse', {
        tool_name: 'Step',
        tool_input: { description: 'Valid description' },
      });

      expect(trackStepDispatch(input)).toEqual({});
    });
  });

  describe('outer error handling', () => {
    it('logs to console.error and returns empty result on unexpected error', () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      // Create input where tool_input access itself throws
      const input = createMockHookInput('PostToolUse', {
        tool_name: 'Step',
      });
      // Override tool_input with a getter that throws
      Object.defineProperty(input, 'tool_input', {
        get() {
          throw new Error('unexpected');
        },
      });

      const result = trackStepDispatch(input);
      expect(result).toEqual({});
      expect(errorSpy).toHaveBeenCalledWith('Failed to track step dispatch:', expect.any(Error));

      errorSpy.mockRestore();
    });
  });
});
