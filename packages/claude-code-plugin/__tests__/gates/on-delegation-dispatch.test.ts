import { jest, expect, describe, it, beforeEach } from '@jest/globals';
import type { HookInput } from '../../src/shared/index.js';
import type { handleDelegationDispatch } from '../../src/workflow/hooks/delegation-dispatch.js';

// The handler is mocked so this file pins the gate's PLUMBING (how a handler
// result maps onto a GateResult). The real handler's marker detection is
// pinned in workflow/hooks/delegation-dispatch.test.ts and the contract tests.
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

  it('returns a strictly empty allow when the handler returns empty', async () => {
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

  it('returns the rewritten prompt as updatedInput, keeping the other tool-input fields', async () => {
    mockHandleDelegationDispatch.mockResolvedValue({
      prompt: 'Work.\n\n## Rundown delegation\nrundown claim rdt_ABC123',
    });

    const input: HookInput = {
      hook_event_name: 'PreToolUse',
      cwd: '/test',
      tool_name: 'Task',
      tool_input: { prompt: 'Work.', description: 'review', subagent_type: 'general-purpose' },
    };

    const result = await execute(input);
    expect(result).toEqual({
      updatedInput: {
        prompt: 'Work.\n\n## Rundown delegation\nrundown claim rdt_ABC123',
        description: 'review',
        subagent_type: 'general-purpose',
      },
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

  it('blocks a marked dispatch the handler failed on (fail closed)', async () => {
    mockHandleDelegationDispatch.mockRejectedValue(new Error('unexpected'));

    const result = await execute({
      hook_event_name: 'PreToolUse',
      cwd: '/test',
      tool_name: 'Task',
      tool_input: { prompt: 'RD_CLAIM_TICKET=rdt_x' },
    });

    expect(result).toMatchObject({ decision: 'block' });
  });

  it('propagates handler errors on an unmarked dispatch to the dispatcher fail-open backstop', async () => {
    mockHandleDelegationDispatch.mockRejectedValue(new Error('unexpected'));

    const input: HookInput = {
      hook_event_name: 'PreToolUse',
      cwd: '/test',
      tool_name: 'Task',
    };

    await expect(execute(input)).rejects.toThrow('unexpected');
  });
});
