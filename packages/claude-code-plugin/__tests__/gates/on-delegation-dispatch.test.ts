import { jest, expect, describe, it, beforeEach } from '@jest/globals';
import type { HookInput } from '../../src/shared/index.js';

const mockHandleDelegationDispatch = jest.fn();

jest.unstable_mockModule('../../src/workflow/hooks/delegation-dispatch.js', () => ({
  handleDelegationDispatch: mockHandleDelegationDispatch,
}));

const { execute } = await import('../../src/gates/on-delegation-dispatch.js');

describe('on-delegation-dispatch gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns empty result when handler returns empty', async () => {
    mockHandleDelegationDispatch.mockResolvedValue({});

    const input: HookInput = {
      hook_event_name: 'PreToolUse',
      cwd: '/test',
      tool_name: 'Task',
    };

    const result = await execute(input);
    expect(result).toEqual({});
  });

  it('returns additionalContext when handler returns context', async () => {
    mockHandleDelegationDispatch.mockResolvedValue({
      context: '## Delegation Context\nrd claim rdtk_ABC123',
    });

    const input: HookInput = {
      hook_event_name: 'PreToolUse',
      cwd: '/test',
      tool_name: 'Task',
    };

    const result = await execute(input);
    expect(result).toEqual({
      additionalContext: '## Delegation Context\nrd claim rdtk_ABC123',
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
    expect(result).toEqual({});
    expect(mockHandleDelegationDispatch).toHaveBeenCalledWith(input);
  });

  it('returns block decision when handler returns violation', async () => {
    mockHandleDelegationDispatch.mockResolvedValue({
      violation: 'Token expired',
    });

    const input: HookInput = {
      hook_event_name: 'PreToolUse',
      cwd: '/test',
      tool_name: 'Task',
    };

    const result = await execute(input);
    expect(result).toEqual({
      decision: 'block',
      reason: 'Token expired',
    });
  });
});
