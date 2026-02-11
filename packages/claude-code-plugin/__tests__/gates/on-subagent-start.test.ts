// packages/claude-code-plugin/__tests__/gates/on-subagent-start.test.ts
import { jest, expect, describe, it, beforeEach } from '@jest/globals';
import type { HookInput } from '../../src/shared/index.js';

const mockHandleSubagentStart = jest.fn();

jest.unstable_mockModule('../../src/workflow/hooks/subagent-start.js', () => ({
  handleSubagentStart: mockHandleSubagentStart,
}));

const { execute } = await import('../../src/gates/on-subagent-start.js');

describe('on-subagent-start gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns empty result when no context or violation', async () => {
    mockHandleSubagentStart.mockReturnValue({});

    const input: HookInput = {
      hook_event_name: 'SubagentStart',
      cwd: '/test',
      agent_id: 'agent-123',
    };

    const result = execute(input);

    expect(result).toEqual({});
  });

  it('returns additionalContext when context provided', async () => {
    mockHandleSubagentStart.mockReturnValue({
      context: '## Workflow Agent Context\nAGENT_ID: agent-123',
    });

    const input: HookInput = {
      hook_event_name: 'SubagentStart',
      cwd: '/test',
      agent_id: 'agent-123',
    };

    const result = execute(input);

    expect(result).toEqual({
      additionalContext: '## Workflow Agent Context\nAGENT_ID: agent-123',
    });
  });

  it('returns block decision when violation occurs', async () => {
    mockHandleSubagentStart.mockReturnValue({
      violation: 'SubagentStart with no pending task',
    });

    const input: HookInput = {
      hook_event_name: 'SubagentStart',
      cwd: '/test',
      agent_id: 'agent-123',
    };

    const result = execute(input);

    expect(result).toEqual({
      decision: 'block',
      reason: 'SubagentStart with no pending task',
    });
  });
});
