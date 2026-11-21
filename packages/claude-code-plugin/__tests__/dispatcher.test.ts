// packages/claude-code-plugin/__tests__/dispatcher.test.ts
import { jest, expect, describe, it, beforeEach } from '@jest/globals';
import type { HookInput } from '../src/shared/index.js';
import type { handleDelegationDispatch } from '../src/workflow/hooks/delegation-dispatch.js';
import type { handleBashCommand } from '../src/workflow/hooks/stamp-agent-id.js';
import type { handleSubagentStop } from '../src/workflow/hooks/subagent-stop.js';

// The dispatcher owns two things: routing a native hook event to its fixed
// gate, and translating that gate's decision into a DispatchResult. This file
// drives both through the REAL gates and the real dispatcher, substituting
// only the three #907 handlers, so every handler decision kind is pinned to
// the DispatchResult it produces. What each handler decides for a given input
// is pinned by the handler and gate tests (`__tests__/workflow/hooks/*`,
// `__tests__/gates/*`); end-to-end behaviour by
// `minimal-dispatch.contract.test.ts`.
const mockHandleDelegationDispatch = jest.fn() as jest.MockedFunction<
  typeof handleDelegationDispatch
>;
const mockHandleBashCommand = jest.fn() as jest.MockedFunction<typeof handleBashCommand>;
const mockHandleSubagentStop = jest.fn() as jest.MockedFunction<typeof handleSubagentStop>;

jest.unstable_mockModule('../src/workflow/hooks/delegation-dispatch.js', () => ({
  handleDelegationDispatch: mockHandleDelegationDispatch,
}));

jest.unstable_mockModule('../src/workflow/hooks/stamp-agent-id.js', () => ({
  handleBashCommand: mockHandleBashCommand,
}));

jest.unstable_mockModule('../src/workflow/hooks/subagent-stop.js', () => ({
  handleSubagentStop: mockHandleSubagentStop,
}));

const mockLoggerError = jest.fn<(...args: unknown[]) => Promise<void>>();

jest.unstable_mockModule('../src/shared/logger.js', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: mockLoggerError,
    always: jest.fn(),
    event: jest.fn(),
    getLogFilePath: jest.fn(),
    getLogDir: jest.fn(),
  },
}));

const { dispatch } = await import('../src/dispatcher.js');

const CLOSURE_VIOLATION = 'Finish or release your claimed child run before stopping.';

function agentInput(toolInput: Record<string, unknown> = {}): HookInput {
  return { hook_event_name: 'PreToolUse', cwd: '/test', tool_name: 'Agent', tool_input: toolInput };
}

function bashInput(command: string): HookInput {
  return {
    hook_event_name: 'PreToolUse',
    cwd: '/test',
    tool_name: 'Bash',
    agent_id: 'a-1',
    tool_input: { command, description: 'kept' },
  };
}

describe('dispatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoggerError.mockResolvedValue(undefined);
    mockHandleDelegationDispatch.mockReturnValue({ kind: 'untouched' });
    mockHandleBashCommand.mockReturnValue({ kind: 'allow' });
    mockHandleSubagentStop.mockResolvedValue({});
  });

  describe('routing', () => {
    it.each(['Agent', 'Task'] as const)(
      'routes PreToolUse(%s) to the delegation-dispatch handler only',
      async (tool) => {
        const input: HookInput = { hook_event_name: 'PreToolUse', cwd: '/test', tool_name: tool };

        await dispatch(input);

        expect(mockHandleDelegationDispatch).toHaveBeenCalledTimes(1);
        expect(mockHandleDelegationDispatch).toHaveBeenCalledWith(input);
        expect(mockHandleBashCommand).not.toHaveBeenCalled();
        expect(mockHandleSubagentStop).not.toHaveBeenCalled();
      },
    );

    it('routes PreToolUse(Bash) to the Bash command handler only', async () => {
      const input = bashInput('rundown pass');

      await dispatch(input);

      expect(mockHandleBashCommand).toHaveBeenCalledTimes(1);
      expect(mockHandleBashCommand).toHaveBeenCalledWith(input);
      expect(mockHandleDelegationDispatch).not.toHaveBeenCalled();
      expect(mockHandleSubagentStop).not.toHaveBeenCalled();
    });

    it('routes SubagentStop to the subagent-stop handler only', async () => {
      const input: HookInput = { hook_event_name: 'SubagentStop', cwd: '/test', agent_id: 'a-1' };

      await dispatch(input);

      expect(mockHandleSubagentStop).toHaveBeenCalledTimes(1);
      expect(mockHandleSubagentStop).toHaveBeenCalledWith(input);
      expect(mockHandleDelegationDispatch).not.toHaveBeenCalled();
      expect(mockHandleBashCommand).not.toHaveBeenCalled();
    });

    it.each([
      { hook_event_name: 'PostToolUse', cwd: '/test', tool_name: 'Agent' },
      { hook_event_name: 'PreToolUse', cwd: '/test', tool_name: 'Edit' },
      { hook_event_name: 'Stop', cwd: '/test' },
    ] satisfies HookInput[])('runs no handler for $hook_event_name $tool_name', async (input) => {
      mockHandleDelegationDispatch.mockReturnValue({ kind: 'blocked', reason: 'must not surface' });
      mockHandleBashCommand.mockReturnValue({ kind: 'deny', reason: 'must not surface' });
      mockHandleSubagentStop.mockResolvedValue({ violation: 'must not surface' });

      const result = await dispatch(input);

      expect(result).toStrictEqual({});
      expect(mockHandleDelegationDispatch).not.toHaveBeenCalled();
      expect(mockHandleBashCommand).not.toHaveBeenCalled();
      expect(mockHandleSubagentStop).not.toHaveBeenCalled();
    });
  });

  describe('delegation-dispatch decisions', () => {
    it('untouched: the dispatch runs as written, with no output', async () => {
      const result = await dispatch(agentInput({ prompt: 'Do work.' }));

      expect(result).toStrictEqual({});
    });

    it('claim: runs the rewritten prompt in place of the agent prompt, keeping every other field', async () => {
      mockHandleDelegationDispatch.mockReturnValue({
        kind: 'claim',
        prompt: 'Do work.\n\n## Rundown delegation',
      });

      const result = await dispatch(
        agentInput({ prompt: 'Do work.', description: 'child', subagent_type: 'general' }),
      );

      expect(result).toStrictEqual({
        updatedInput: {
          prompt: 'Do work.\n\n## Rundown delegation',
          description: 'child',
          subagent_type: 'general',
        },
      });
    });

    it('blocked: blocks the dispatch with the handler reason and no rewrite', async () => {
      mockHandleDelegationDispatch.mockReturnValue({
        kind: 'blocked',
        reason: 'Dispatch one sub-agent per ticket.',
      });

      const result = await dispatch(agentInput({ prompt: 'Do work.' }));

      expect(result).toStrictEqual({
        context: undefined,
        blockReason: 'Dispatch one sub-agent per ticket.',
      });
    });
  });

  describe('Bash command decisions', () => {
    it('allow: the command runs as typed, with no output', async () => {
      const result = await dispatch(bashInput('ls'));

      expect(result).toStrictEqual({});
    });

    it('rewrite: runs the stamped command in place of the typed one, keeping every other field', async () => {
      mockHandleBashCommand.mockReturnValue({
        kind: 'rewrite',
        command: 'rundown claim rdt_X --agent-id a-1',
      });

      const result = await dispatch(bashInput('rundown claim rdt_X'));

      expect(result).toStrictEqual({
        updatedInput: { command: 'rundown claim rdt_X --agent-id a-1', description: 'kept' },
      });
    });

    it('deny: blocks the command with the handler reason and no rewrite', async () => {
      mockHandleBashCommand.mockReturnValue({ kind: 'deny', reason: 'CLAIM_OUTSIDE_SUBAGENT' });

      const result = await dispatch(bashInput('rundown claim rdt_X'));

      expect(result).toStrictEqual({ context: undefined, blockReason: 'CLAIM_OUTSIDE_SUBAGENT' });
    });
  });

  describe('subagent-stop results', () => {
    it('nothing held: the stop proceeds, with no output', async () => {
      const result = await dispatch({ hook_event_name: 'SubagentStop', cwd: '/test' });

      expect(result).toStrictEqual({});
    });

    it('surfaces subagent-stop context as the dispatch context, without a block', async () => {
      mockHandleSubagentStop.mockResolvedValue({ context: 'Child run rd_1 released.' });

      const result = await dispatch({ hook_event_name: 'SubagentStop', cwd: '/test' });

      expect(result).toStrictEqual({ context: 'Child run rd_1 released.' });
    });

    it('blocks the subagent stop with the closure violation as the reason', async () => {
      mockHandleSubagentStop.mockResolvedValue({ violation: CLOSURE_VIOLATION });

      const result = await dispatch({
        hook_event_name: 'SubagentStop',
        cwd: '/test',
        agent_id: 'a-1',
      });

      expect(result).toStrictEqual({ context: undefined, blockReason: CLOSURE_VIOLATION });
    });

    it('a violation wins over context from the same handler', async () => {
      mockHandleSubagentStop.mockResolvedValue({
        context: 'must not surface',
        violation: CLOSURE_VIOLATION,
      });

      const result = await dispatch({ hook_event_name: 'SubagentStop', cwd: '/test' });

      expect(result).toStrictEqual({ context: undefined, blockReason: CLOSURE_VIOLATION });
    });

    it('blocks the subagent stop when the handler throws (fail closed)', async () => {
      mockHandleSubagentStop.mockRejectedValue(new Error('EACCES: run store unreadable'));

      const result = await dispatch({ hook_event_name: 'SubagentStop', cwd: '/test' });

      expect(result.context).toBeUndefined();
      expect(result.updatedInput).toBeUndefined();
      expect(result.blockReason).toContain('`rundown status --claimed-by` failed');
      expect(mockLoggerError).toHaveBeenCalledWith(
        'SubagentStop enforcement failed; failing closed',
        { error: 'EACCES: run store unreadable' },
      );
    });
  });
});
