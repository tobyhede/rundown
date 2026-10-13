import { jest, expect, describe, it, beforeEach } from '@jest/globals';
import type { HookInput } from '../../src/shared/index.js';
import type { handleDelegationDispatch } from '../../src/workflow/hooks/delegation-dispatch.js';

// The handler is mocked so this file pins the gate's PLUMBING (how a handler
// decision maps onto a GateResult). The real handler's marker detection is
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

  it('returns a strictly empty allow for an untouched dispatch', async () => {
    mockHandleDelegationDispatch.mockReturnValue({ kind: 'untouched' });

    const input: HookInput = { hook_event_name: 'PreToolUse', cwd: '/test', tool_name: 'Agent' };

    // toStrictEqual so an `{ additionalContext: undefined }` leak is caught.
    expect(await execute(input)).toStrictEqual({});
    expect(mockHandleDelegationDispatch).toHaveBeenCalledWith(input);
  });

  it('returns the rewritten prompt as updatedInput, keeping the other tool-input fields', async () => {
    mockHandleDelegationDispatch.mockReturnValue({
      kind: 'claim',
      prompt: 'Work.\n\n## Rundown delegation\nrundown claim rdt_ABC123',
    });

    const result = await execute({
      hook_event_name: 'PreToolUse',
      cwd: '/test',
      tool_name: 'Task',
      tool_input: { prompt: 'Work.', description: 'review', subagent_type: 'general-purpose' },
    });

    expect(result).toEqual({
      updatedInput: {
        prompt: 'Work.\n\n## Rundown delegation\nrundown claim rdt_ABC123',
        description: 'review',
        subagent_type: 'general-purpose',
      },
    });
  });

  it('returns a block decision for a blocked dispatch', async () => {
    mockHandleDelegationDispatch.mockReturnValue({ kind: 'blocked', reason: 'Two tickets' });

    const result = await execute({
      hook_event_name: 'PreToolUse',
      cwd: '/test',
      tool_name: 'Task',
    });

    expect(result).toEqual({ decision: 'block', reason: 'Two tickets' });
  });
});
