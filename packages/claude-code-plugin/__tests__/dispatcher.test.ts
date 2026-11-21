// packages/claude-code-plugin/__tests__/dispatcher.test.ts
import { jest, expect, describe, it, beforeEach } from '@jest/globals';
import type { HookInput } from '../src/shared/index.js';
import type { handleDelegationDispatch } from '../src/workflow/hooks/delegation-dispatch.js';
import type { handleSubagentStop } from '../src/workflow/hooks/subagent-stop.js';

// Both hook handlers are inert under the one-writer model (#901), so through
// the real handlers `dispatch` can only ever return `{}` — pinned by
// minimal-dispatch.contract.test.ts. The dispatcher still owns the translation
// of a gate's context / block decision into a DispatchResult, and #907 turns
// the handlers back on. This file drives that translation through the REAL
// gates by substituting only the handlers (the seam #907 fills in), so the
// routing and the context/block surface are pinned before a handler produces
// either again.
const mockHandleDelegationDispatch = jest.fn() as jest.MockedFunction<
  typeof handleDelegationDispatch
>;
const mockHandleSubagentStop = jest.fn() as jest.MockedFunction<typeof handleSubagentStop>;

jest.unstable_mockModule('../src/workflow/hooks/delegation-dispatch.js', () => ({
  handleDelegationDispatch: mockHandleDelegationDispatch,
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

const CLAIM_CONTEXT = '## Delegation Context\nrundown claim rdt_ABC123';
const CLOSURE_VIOLATION = 'Finish or release your claimed child run before stopping.';

describe('dispatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoggerError.mockResolvedValue(undefined);
    mockHandleDelegationDispatch.mockResolvedValue({});
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
        expect(mockHandleSubagentStop).not.toHaveBeenCalled();
      },
    );

    it('routes SubagentStop to the subagent-stop handler only', async () => {
      const input: HookInput = { hook_event_name: 'SubagentStop', cwd: '/test', agent_id: 'a-1' };

      await dispatch(input);

      expect(mockHandleSubagentStop).toHaveBeenCalledTimes(1);
      expect(mockHandleSubagentStop).toHaveBeenCalledWith(input);
      expect(mockHandleDelegationDispatch).not.toHaveBeenCalled();
    });

    it('runs no gate for PreToolUse on a tool the plugin does not own', async () => {
      mockHandleDelegationDispatch.mockResolvedValue({ violation: 'must not surface' });

      const result = await dispatch({
        hook_event_name: 'PreToolUse',
        cwd: '/test',
        tool_name: 'Bash',
        tool_input: { command: 'rundown pass' },
      });

      expect(result).toStrictEqual({});
      expect(mockHandleDelegationDispatch).not.toHaveBeenCalled();
      expect(mockHandleSubagentStop).not.toHaveBeenCalled();
    });

    it('runs no gate for an event the plugin does not own', async () => {
      mockHandleDelegationDispatch.mockResolvedValue({ violation: 'must not surface' });
      mockHandleSubagentStop.mockResolvedValue({ violation: 'must not surface' });

      const result = await dispatch({
        hook_event_name: 'PostToolUse',
        cwd: '/test',
        tool_name: 'Agent',
      });

      expect(result).toStrictEqual({});
      expect(mockHandleDelegationDispatch).not.toHaveBeenCalled();
      expect(mockHandleSubagentStop).not.toHaveBeenCalled();
    });
  });

  describe('gate context', () => {
    it('surfaces delegation-dispatch context as the dispatch context, without a block', async () => {
      mockHandleDelegationDispatch.mockResolvedValue({ context: CLAIM_CONTEXT });

      const result = await dispatch({
        hook_event_name: 'PreToolUse',
        cwd: '/test',
        tool_name: 'Agent',
      });

      expect(result).toStrictEqual({ context: CLAIM_CONTEXT });
    });

    it('surfaces subagent-stop context as the dispatch context, without a block', async () => {
      mockHandleSubagentStop.mockResolvedValue({ context: 'Child run rd_1 released.' });

      const result = await dispatch({ hook_event_name: 'SubagentStop', cwd: '/test' });

      expect(result).toStrictEqual({ context: 'Child run rd_1 released.' });
    });
  });

  describe('gate block', () => {
    it('blocks the Agent tool use with the delegation-dispatch violation as the reason', async () => {
      mockHandleDelegationDispatch.mockResolvedValue({ violation: 'Claim ticket is malformed.' });

      const result = await dispatch({
        hook_event_name: 'PreToolUse',
        cwd: '/test',
        tool_name: 'Agent',
      });

      expect(result).toStrictEqual({
        context: undefined,
        blockReason: 'Claim ticket is malformed.',
      });
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
  });

  describe('handler failure', () => {
    it('blocks the subagent stop when the enforcement handler throws (fail closed)', async () => {
      mockHandleSubagentStop.mockRejectedValue(new Error('EACCES: run store unreadable'));

      const result = await dispatch({ hook_event_name: 'SubagentStop', cwd: '/test' });

      expect(result).toStrictEqual({
        context: undefined,
        blockReason:
          'Could not verify delegation closure (session state unavailable). Run `rundown status` and close any open delegations before stopping.',
      });
    });

    it('allows the Agent tool use and logs when the delegation-dispatch handler throws (fail open)', async () => {
      mockHandleDelegationDispatch.mockRejectedValue(new Error('context enrichment failed'));

      const result = await dispatch({
        hook_event_name: 'PreToolUse',
        cwd: '/test',
        tool_name: 'Agent',
      });

      expect(result).toStrictEqual({});
      expect(mockLoggerError).toHaveBeenCalledTimes(1);
      expect(mockLoggerError).toHaveBeenCalledWith('Gate execution failed', {
        event: 'PreToolUse',
        tool: 'Agent',
        error: 'context enrichment failed',
      });
    });
  });
});
