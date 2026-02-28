// packages/claude-code-plugin/__tests__/gates/on-subagent-stop.test.ts
import { jest, expect, describe, it, beforeEach } from '@jest/globals';
import type { HookInput } from '../../src/shared/index.js';

const mockHandleSubagentStop = jest.fn();

jest.unstable_mockModule('../../src/workflow/hooks/subagent-stop.js', () => ({
  handleSubagentStop: mockHandleSubagentStop,
}));

const { execute } = await import('../../src/gates/on-subagent-stop.js');

describe('on-subagent-stop gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns empty result when no context or violation', async () => {
    mockHandleSubagentStop.mockResolvedValue({});

    const input: HookInput = {
      hook_event_name: 'SubagentStop',
      cwd: '/test',
      agent_id: 'agent-123',
    };

    const result = await execute(input);
    expect(result).toEqual({});
  });

  it('returns additionalContext when context provided', async () => {
    mockHandleSubagentStop.mockResolvedValue({
      context: 'Delegation rdtk_ABC aborted due to agent failure.',
    });

    const input: HookInput = {
      hook_event_name: 'SubagentStop',
      cwd: '/test',
      agent_id: 'agent-123',
    };

    const result = await execute(input);
    expect(result).toEqual({
      additionalContext: 'Delegation rdtk_ABC aborted due to agent failure.',
    });
  });

  it('returns block decision when violation occurs', async () => {
    mockHandleSubagentStop.mockResolvedValue({
      violation: 'Something went wrong',
    });

    const input: HookInput = {
      hook_event_name: 'SubagentStop',
      cwd: '/test',
      agent_id: 'agent-xyz',
    };

    const result = await execute(input);
    expect(result).toEqual({
      decision: 'block',
      reason: 'Something went wrong',
    });
  });
});
