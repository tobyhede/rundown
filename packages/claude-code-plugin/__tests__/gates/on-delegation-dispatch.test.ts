import { jest, expect, describe, it, beforeEach } from '@jest/globals';
import type { HookInput } from '../../src/shared/index.js';
import type { handleDelegationDispatch } from '../../src/workflow/hooks/delegation-dispatch.js';

const mockHandleDelegationDispatch = jest.fn() as jest.MockedFunction<
  typeof handleDelegationDispatch
>;

// Real DelegationTokenRecordingError so the gate's `instanceof` check holds; the
// handler itself is mocked.
class DelegationTokenRecordingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DelegationTokenRecordingError';
  }
}

jest.unstable_mockModule('../../src/workflow/hooks/delegation-dispatch.js', () => ({
  handleDelegationDispatch: mockHandleDelegationDispatch,
  DelegationTokenRecordingError,
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
      context: '## Delegation Context\nrundown claim rdtk_ABC123',
    });

    const input: HookInput = {
      hook_event_name: 'PreToolUse',
      cwd: '/test',
      tool_name: 'Task',
    };

    const result = await execute(input);
    expect(result).toEqual({
      additionalContext: '## Delegation Context\nrundown claim rdtk_ABC123',
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

  it('fails CLOSED with a block when handler throws DelegationTokenRecordingError', async () => {
    mockHandleDelegationDispatch.mockRejectedValue(
      new DelegationTokenRecordingError('Failed to record delegation token in session metadata'),
    );

    const input: HookInput = {
      hook_event_name: 'PreToolUse',
      cwd: '/test',
      tool_name: 'Task',
    };

    const result = await execute(input);
    expect(result).toMatchObject({
      decision: 'block',
      reason: expect.stringMatching(/record the delegation token|session state|retry/i),
    });
  });

  it('propagates non-recording errors to the dispatcher fail-open backstop', async () => {
    mockHandleDelegationDispatch.mockRejectedValue(new Error('unexpected'));

    const input: HookInput = {
      hook_event_name: 'PreToolUse',
      cwd: '/test',
      tool_name: 'Task',
    };

    await expect(execute(input)).rejects.toThrow('unexpected');
  });
});
