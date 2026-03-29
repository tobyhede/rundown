import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { setExecSync } from '../../../src/workflow/hooks/rundown.js';
import { createMockHookInput, createMockExecSync } from '../../helpers/test-utils.js';

// Mock Session module
const mockGet = jest.fn();
const mockSet = jest.fn();

jest.unstable_mockModule('../../../src/session.js', () => ({
  Session: jest.fn().mockImplementation(() => ({
    get: mockGet,
    set: mockSet,
  })),
}));

const { handleDelegationDispatch } = await import(
  '../../../src/workflow/hooks/delegation-dispatch.js'
);

const VALID_TOKEN = 'rdtk_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

describe('handleDelegationDispatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockResolvedValue({});
    mockSet.mockResolvedValue(undefined);
    // Default: rd status --json fails (no active runbook)
    setExecSync(
      jest.fn().mockImplementation(() => {
        throw new Error('no active runbook');
      }) as never,
    );
  });

  afterEach(() => {
    setExecSync(jest.fn() as never);
  });

  it('returns empty for non-PreToolUse events', async () => {
    const input = createMockHookInput('PostToolUse');
    const result = await handleDelegationDispatch(input);
    expect(result).toEqual({});
  });

  it('returns empty for PreToolUse where tool_name !== Task', async () => {
    const input = createMockHookInput('PreToolUse', {
      tool_name: 'Edit',
      tool_input: { file_path: '/test/file.ts' },
    });
    const result = await handleDelegationDispatch(input);
    expect(result).toEqual({});
  });

  it('returns empty when no marker in prompt or description', async () => {
    const input = createMockHookInput('PreToolUse', {
      tool_name: 'Task',
      tool_input: { prompt: 'Just a task', description: 'Do some work' },
    });
    const result = await handleDelegationDispatch(input);
    expect(result).toEqual({});
  });

  it('returns context with rd claim instruction when marker found in prompt', async () => {
    const input = createMockHookInput('PreToolUse', {
      tool_name: 'Task',
      tool_input: {
        prompt: `Do the work\nRD_CLAIM_TOKEN=${VALID_TOKEN}\nThen report`,
        description: 'A description',
      },
    });
    const result = await handleDelegationDispatch(input);
    expect(result.context).toContain(`rd claim ${VALID_TOKEN}`);
    expect(result.context).toContain('Delegation Context');
  });

  it('returns context with rd claim instruction when marker found in description', async () => {
    const input = createMockHookInput('PreToolUse', {
      tool_name: 'Task',
      tool_input: {
        prompt: 'No marker here',
        description: `Delegated task\nRD_CLAIM_TOKEN=${VALID_TOKEN}`,
      },
    });
    const result = await handleDelegationDispatch(input);
    expect(result.context).toContain(`rd claim ${VALID_TOKEN}`);
  });

  it('stores token in session metadata on detection', async () => {
    mockGet.mockResolvedValue({ existing_key: 'value' });

    const input = createMockHookInput('PreToolUse', {
      tool_name: 'Task',
      tool_input: {
        prompt: `RD_CLAIM_TOKEN=${VALID_TOKEN}`,
      },
    });

    await handleDelegationDispatch(input);

    expect(mockSet).toHaveBeenCalledWith('metadata', {
      existing_key: 'value',
      delegation_active_token: VALID_TOKEN,
    });
  });

  it('returns context for Agent tool with marker in prompt', async () => {
    const input = createMockHookInput('PreToolUse', {
      tool_name: 'Agent',
      tool_input: {
        prompt: `Do the work\nRD_CLAIM_TOKEN=${VALID_TOKEN}\nThen report`,
        description: 'A description',
      },
    });
    const result = await handleDelegationDispatch(input);
    expect(result.context).toContain(`rd claim ${VALID_TOKEN}`);
    expect(result.context).toContain('Delegation Context');
  });

  it('returns context for Agent tool with marker in description', async () => {
    const input = createMockHookInput('PreToolUse', {
      tool_name: 'Agent',
      tool_input: {
        prompt: 'No marker here',
        description: `Delegated agent\nRD_CLAIM_TOKEN=${VALID_TOKEN}`,
      },
    });
    const result = await handleDelegationDispatch(input);
    expect(result.context).toContain(`rd claim ${VALID_TOKEN}`);
  });

  it('stores token in session metadata on Agent tool detection', async () => {
    mockGet.mockResolvedValue({ existing_key: 'value' });

    const input = createMockHookInput('PreToolUse', {
      tool_name: 'Agent',
      tool_input: {
        prompt: `RD_CLAIM_TOKEN=${VALID_TOKEN}`,
      },
    });

    await handleDelegationDispatch(input);

    expect(mockSet).toHaveBeenCalledWith('metadata', {
      existing_key: 'value',
      delegation_active_token: VALID_TOKEN,
    });
  });

  it('returns context even when rd status --json fails (best-effort)', async () => {
    setExecSync(
      jest.fn().mockImplementation(() => {
        throw new Error('command failed');
      }) as never,
    );

    const input = createMockHookInput('PreToolUse', {
      tool_name: 'Task',
      tool_input: { prompt: `RD_CLAIM_TOKEN=${VALID_TOKEN}` },
    });

    const result = await handleDelegationDispatch(input);
    expect(result.context).toContain(`rd claim ${VALID_TOKEN}`);
    expect(result.context).toContain('rd pass');
  });

  it('includes delegation status lines when rd status --json succeeds', async () => {
    const mockExec = createMockExecSync(JSON.stringify({ runbook: 'deploy.md', step: '3.1' }));
    setExecSync(mockExec as never);

    const input = createMockHookInput('PreToolUse', {
      tool_name: 'Task',
      tool_input: { prompt: `RD_CLAIM_TOKEN=${VALID_TOKEN}` },
    });

    const result = await handleDelegationDispatch(input);
    expect(result.context).toContain('Active runbook: deploy.md');
    expect(result.context).toContain('Current step: 3.1');
  });
});
