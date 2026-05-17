import { jest } from '@jest/globals';
import { trackStepDispatch } from '../../../src/workflow/hooks/step-tracker.js';
import { setExecSync } from '../../../src/workflow/hooks/rundown.js';
import { createMockHookInput } from '../../helpers/test-utils.js';
import { mockExecFileSync, mockExecFileSyncError } from '../../helpers/execfile-mock.js';

describe('trackStepDispatch', () => {
  const unsupportedStepFlag = '--' + 'step';

  afterEach(() => {
    jest.restoreAllMocks();
    setExecSync(mockExecFileSync(''));
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
      const mockExec = mockExecFileSync('ok');
      setExecSync(mockExec);

      const input = createMockHookInput('PostToolUse', {
        tool_name: 'Step',
        tool_input: { description: '1.1 - Do something' },
      });

      const result = trackStepDispatch(input);
      expect(result).toEqual({});
      expect(mockExec).toHaveBeenCalled();
    });

    it('processes Task tool name', () => {
      const mockExec = mockExecFileSync('ok');
      setExecSync(mockExec);

      const input = createMockHookInput('PostToolUse', {
        tool_name: 'Task',
        tool_input: { description: 'NamedStep: Do something' },
      });

      const result = trackStepDispatch(input);
      expect(result).toEqual({});
      expect(mockExec).toHaveBeenCalled();
    });

    it('processes Agent tool name', () => {
      const mockExec = mockExecFileSync('ok');
      setExecSync(mockExec);

      const input = createMockHookInput('PostToolUse', {
        tool_name: 'Agent',
        tool_input: { description: '2.1 - Run integration tests' },
      });

      const result = trackStepDispatch(input);
      expect(result).toEqual({});
      expect(mockExec).toHaveBeenCalled();
    });
  });

  describe('description validation', () => {
    const expectedViolation =
      'Tool description must include a valid step identifier (e.g. "1.1 - Do work" or "ErrorHandler: Recover").';

    it('returns violation when description is empty', () => {
      const input = createMockHookInput('PostToolUse', {
        tool_name: 'Step',
        tool_input: { description: '' },
      });

      const result = trackStepDispatch(input);
      expect(result.violation).toBe(expectedViolation);
    });

    it('returns violation when description is whitespace', () => {
      const input = createMockHookInput('PostToolUse', {
        tool_name: 'Step',
        tool_input: { description: '   ' },
      });

      const result = trackStepDispatch(input);
      expect(result.violation).toBe(expectedViolation);
    });

    it('returns violation when description is missing', () => {
      const input = createMockHookInput('PostToolUse', {
        tool_name: 'Step',
        tool_input: {},
      });

      const result = trackStepDispatch(input);
      expect(result.violation).toBe(expectedViolation);
    });

    it('returns violation when description has no parseable step id', () => {
      const input = createMockHookInput('PostToolUse', {
        tool_name: 'Step',
        tool_input: { description: 'Run unit tests' },
      });

      const result = trackStepDispatch(input);
      expect(result.violation).toBe(expectedViolation);
    });
  });

  describe('rundown CLI invocation', () => {
    it('calls rundown with normalized numeric substep id prefix', () => {
      const mockExec = mockExecFileSync('ok');
      setExecSync(mockExec);

      const input = createMockHookInput('PostToolUse', {
        tool_name: 'Step',
        tool_input: { description: '1.1 - Run unit tests' },
        cwd: '/my/project',
      });

      trackStepDispatch(input);

      expect(mockExec).toHaveBeenCalledWith(
        'node',
        expect.arrayContaining(['goto', '1.1']),
        expect.objectContaining({ cwd: '/my/project' }),
      );
      expect(mockExec).not.toHaveBeenCalledWith(
        'node',
        expect.arrayContaining(['run', unsupportedStepFlag, '1.1']),
        expect.any(Object),
      );
    });

    it('calls rundown with exact numeric id when description is id only', () => {
      const mockExec = mockExecFileSync('ok');
      setExecSync(mockExec);

      const input = createMockHookInput('PostToolUse', {
        tool_name: 'Step',
        tool_input: { description: '2.3' },
      });

      trackStepDispatch(input);

      expect(mockExec).toHaveBeenCalledWith(
        'node',
        expect.arrayContaining(['goto', '2.3']),
        expect.any(Object),
      );
      expect(mockExec).not.toHaveBeenCalledWith(
        'node',
        expect.arrayContaining(['run', unsupportedStepFlag, '2.3']),
        expect.any(Object),
      );
    });

    it('calls rundown with normalized named step id prefix', () => {
      const mockExec = mockExecFileSync('ok');
      setExecSync(mockExec);

      const input = createMockHookInput('PostToolUse', {
        tool_name: 'Task',
        tool_input: { description: 'ErrorHandler: Recover from timeout' },
      });

      trackStepDispatch(input);

      expect(mockExec).toHaveBeenCalledWith(
        'node',
        expect.arrayContaining(['goto', 'ErrorHandler']),
        expect.any(Object),
      );
      expect(mockExec).not.toHaveBeenCalledWith(
        'node',
        expect.arrayContaining(['run', unsupportedStepFlag, 'ErrorHandler']),
        expect.any(Object),
      );
    });

    it('returns empty result on success', () => {
      const mockExec = mockExecFileSync('step tracked');
      setExecSync(mockExec);

      const input = createMockHookInput('PostToolUse', {
        tool_name: 'Step',
        tool_input: { description: 'BuildStep - Build project' },
      });

      expect(trackStepDispatch(input)).toEqual({});
    });

    it('returns empty result when rundown throws', () => {
      const mockExec = mockExecFileSyncError({ message: 'rundown failed' });
      setExecSync(mockExec);

      const input = createMockHookInput('PostToolUse', {
        tool_name: 'Step',
        tool_input: { description: '1.1 - Valid description' },
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
    });
  });
});
