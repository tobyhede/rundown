import { jest, expect, describe, it, beforeEach } from '@jest/globals';
import type { HookInput } from '../../src/shared/index.js';
import type { handleDelegationDispatch } from '../../src/workflow/hooks/delegation-dispatch.js';

// The handler is mocked so this file pins the gate's PLUMBING (how a handler
// result maps onto a GateResult). The real handler is inert today; its allow
// behaviour is pinned end-to-end in workflow/hooks/inert-hooks.test.ts and the
// dispatch contract tests.
const mockHandleDelegationDispatch = jest.fn() as jest.MockedFunction<
  typeof handleDelegationDispatch
>;

jest.unstable_mockModule('../../src/workflow/hooks/delegation-dispatch.js', () => ({
  handleDelegationDispatch: mockHandleDelegationDispatch,
}));

const { execute } = await import('../../src/gates/on-delegation-dispatch.js');

describe('on-delegation-dispatch gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the inert allow (strictly empty) when the handler returns empty', async () => {
    mockHandleDelegationDispatch.mockResolvedValue({});

    const input: HookInput = {
      hook_event_name: 'PreToolUse',
      cwd: '/test',
      tool_name: 'Task',
    };

    const result = await execute(input);
    // toStrictEqual so an `{ additionalContext: undefined }` leak is caught.
    expect(result).toStrictEqual({});
    expect(result).not.toHaveProperty('decision');
  });

  it('returns additionalContext when handler returns context', async () => {
    mockHandleDelegationDispatch.mockResolvedValue({
      context: '## Delegation Context\nrundown claim rdt_ABC123',
    });

    const input: HookInput = {
      hook_event_name: 'PreToolUse',
      cwd: '/test',
      tool_name: 'Task',
    };

    const result = await execute(input);
    expect(result).toEqual({
      additionalContext: '## Delegation Context\nrundown claim rdt_ABC123',
    });
  });

  it('passes Agent tool through to handler', async () => {
    mockHandleDelegationDispatch.mockResolvedValue({});

    const input: HookInput = {
      hook_event_name: 'PreToolUse',
      cwd: '/test',
      tool_name: 'Agent',
    };

    const result = await execute(input);
    expect(result).toStrictEqual({});
    expect(mockHandleDelegationDispatch).toHaveBeenCalledWith(input);
  });

  it('returns block decision when handler returns violation', async () => {
    mockHandleDelegationDispatch.mockResolvedValue({
      violation: 'Ticket cancelled',
    });

    const input: HookInput = {
      hook_event_name: 'PreToolUse',
      cwd: '/test',
      tool_name: 'Task',
    };

    const result = await execute(input);
    expect(result).toEqual({
      decision: 'block',
      reason: 'Ticket cancelled',
    });
  });

  it('propagates handler errors to the dispatcher fail-open backstop', async () => {
    mockHandleDelegationDispatch.mockRejectedValue(new Error('unexpected'));

    const input: HookInput = {
      hook_event_name: 'PreToolUse',
      cwd: '/test',
      tool_name: 'Task',
    };

    await expect(execute(input)).rejects.toThrow('unexpected');
  });
});
