import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { hashDelegationToken } from '@rundown-org/core';
import { getErrorMessage } from '../../../src/shared/index.js';
import { setExecSync } from '../../../src/workflow/hooks/rundown.js';
import { createMockHookInput } from '../../helpers/test-utils.js';
import { mockExecFileSync, mockExecFileSyncError } from '../../helpers/execfile-mock.js';
import { DelegationActiveTokensMetadataSchema } from '../../../src/shared/schemas.js';

// Mock Session module
import { createSessionMock, setGet } from '../../helpers/session-mock.js';

const session = createSessionMock();
const mockSet = session.set;

jest.unstable_mockModule('../../../src/session.js', () => ({
  Session: jest.fn().mockImplementation(() => session),
}));

const { handleDelegationDispatch, DelegationTokenRecordingError } = await import(
  '../../../src/workflow/hooks/delegation-dispatch.js'
);
const { handleSubagentStop } = await import('../../../src/workflow/hooks/subagent-stop.js');

const VALID_TOKEN = 'rdtk_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

describe('handleDelegationDispatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setGet(session, 'metadata', {});
    // Default: rd status --json fails (no active runbook)
    setExecSync(mockExecFileSyncError({ message: 'no active runbook' }));
  });

  afterEach(() => {
    setExecSync(mockExecFileSync(''));
  });

  it('returns empty for non-PreToolUse events', async () => {
    const input = createMockHookInput('PostToolUse');
    const result = await handleDelegationDispatch(input);
    expect(result).toEqual({});
  });

  it('returns empty for PreToolUse where tool_name is neither Agent nor Task', async () => {
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

  it('stores token in per-agent session metadata when agent_id is present', async () => {
    setGet(session, 'metadata', { existing_key: 'value' });

    const input = createMockHookInput('PreToolUse', {
      agent_id: 'agent-123',
      session_id: 'session-abc',
      tool_name: 'Task',
      tool_input: {
        prompt: `RD_CLAIM_TOKEN=${VALID_TOKEN}`,
      },
    });

    await handleDelegationDispatch(input);

    expect(mockSet).toHaveBeenCalledWith('metadata', {
      existing_key: 'value',
      delegation_active_tokens: {
        'agent-123': {
          kind: 'delegation-active-token',
          agent_id: 'agent-123',
          session_id: 'session-abc',
          tokenHash: hashDelegationToken(VALID_TOKEN),
          createdAt: expect.any(String),
        },
      },
    });
    const written = mockSet.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(DelegationActiveTokensMetadataSchema.parse(written.delegation_active_tokens)).toEqual(
      written.delegation_active_tokens,
    );
  });

  it('round-trips per-agent token metadata from dispatch to SubagentStop', async () => {
    // cspell:disable-next-line
    const siblingToken = 'rdtk_BBCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    setGet(session, 'metadata', {
      delegation_active_tokens: {
        'sibling-agent': {
          kind: 'delegation-active-token',
          agent_id: 'sibling-agent',
          session_id: 'session-abc',
          tokenHash: hashDelegationToken(siblingToken),
          createdAt: '2026-04-28T00:00:00.000Z',
        },
      },
    });

    const dispatchInput = createMockHookInput('PreToolUse', {
      agent_id: 'agent-123',
      session_id: 'session-abc',
      tool_name: 'Task',
      tool_input: {
        prompt: `Do the delegated work\nRD_CLAIM_TOKEN=${VALID_TOKEN}`,
      },
    });

    await handleDelegationDispatch(dispatchInput);

    const written = mockSet.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(written.delegation_active_tokens).toMatchObject({
      'agent-123': {
        kind: 'delegation-active-token',
        agent_id: 'agent-123',
        session_id: 'session-abc',
        tokenHash: hashDelegationToken(VALID_TOKEN),
      },
      'sibling-agent': {
        agent_id: 'sibling-agent',
        tokenHash: hashDelegationToken(siblingToken),
      },
    });
    expect(JSON.stringify(written.delegation_active_tokens)).not.toContain(VALID_TOKEN);

    setExecSync(mockExecFileSync(JSON.stringify({ active: false, stashed: false })));
    const stopInput = createMockHookInput('SubagentStop', {
      agent_id: 'agent-123',
      session_id: 'session-abc',
    });

    await handleSubagentStop(stopInput);

    expect(mockSet).toHaveBeenLastCalledWith('metadata', {
      delegation_active_tokens: {
        'sibling-agent': expect.objectContaining({
          agent_id: 'sibling-agent',
          tokenHash: hashDelegationToken(siblingToken),
        }),
      },
    });
  });

  it('rejects write-side delegation_active_tokens schema drift', async () => {
    setGet(session, 'metadata', {
      delegation_active_tokens: {
        'agent-1': {
          kind: 'delegation-active-token',
          agent_id: 'different-agent',
          tokenHash: hashDelegationToken(VALID_TOKEN),
          createdAt: '2026-04-28T00:00:00.000Z',
        },
      },
    });

    const input = createMockHookInput('PreToolUse', {
      agent_id: 'agent-2',
      session_id: 'session-abc',
      tool_name: 'Task',
      tool_input: {
        prompt: `RD_CLAIM_TOKEN=${VALID_TOKEN}`,
      },
    });

    // A token WAS detected, so a schema-drift parse failure during recording is
    // wrapped as DelegationTokenRecordingError (the fail-closed signal the gate
    // converts into a block); the underlying zod message is preserved on `cause`.
    const rejection = await handleDelegationDispatch(input).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(DelegationTokenRecordingError);
    expect(getErrorMessage((rejection as { cause?: unknown }).cause)).toContain(
      'delegation_active_tokens key must match metadata.agent_id',
    );
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('stores a token hash in legacy global metadata when agent_id is absent', async () => {
    setGet(session, 'metadata', {});

    const input = createMockHookInput('PreToolUse', {
      tool_name: 'Task',
      tool_input: { prompt: `RD_CLAIM_TOKEN=${VALID_TOKEN}` },
    });

    await handleDelegationDispatch(input);

    expect(mockSet).toHaveBeenCalledWith('metadata', {
      delegation_active_token: hashDelegationToken(VALID_TOKEN),
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

  it('stores token hash in legacy session metadata on Agent tool detection', async () => {
    setGet(session, 'metadata', { existing_key: 'value' });

    const input = createMockHookInput('PreToolUse', {
      tool_name: 'Agent',
      tool_input: {
        prompt: `RD_CLAIM_TOKEN=${VALID_TOKEN}`,
      },
    });

    await handleDelegationDispatch(input);

    expect(mockSet).toHaveBeenCalledWith('metadata', {
      existing_key: 'value',
      delegation_active_token: hashDelegationToken(VALID_TOKEN),
    });
  });

  it('injects claim-id command guidance into claim context', async () => {
    const input = createMockHookInput('PreToolUse', {
      agent_id: 'agent-123',
      session_id: 'session-abc',
      tool_name: 'Task',
      tool_input: { prompt: `RD_CLAIM_TOKEN=${VALID_TOKEN}` },
    });

    const result = await handleDelegationDispatch(input);

    expect(result.context).toContain(`rd claim ${VALID_TOKEN}`);
    expect(result.context).toContain('Copy the `claim_id` from the claim output.');
    expect(result.context).toContain('rd status --claim-id <claim_id>');
    expect(result.context).toContain('rd pass --claim-id <claim_id>');
    expect(result.context).toContain('rd fail --claim-id <claim_id>');
    expect(result.context).toContain(['```', `rd claim ${VALID_TOKEN}`, '```'].join('\n'));
    expect(result.context).toContain(
      [
        '```',
        'rd status --claim-id <claim_id>',
        'rd pass --claim-id <claim_id>',
        'rd fail --claim-id <claim_id>',
        'rd stash --claim-id <claim_id>',
        'rd pop --claim-id <claim_id>',
        'rd stop --claim-id <claim_id>',
        'rd complete --claim-id <claim_id>',
        '```',
      ].join('\n'),
    );
    expect(result.context).toContain(
      'Before stopping, complete the delegated runbook explicitly with `rd pass --claim-id <claim_id>` or `rd fail --claim-id <claim_id>`.',
    );
  });

  it('injects claim-id guidance without agent identity', async () => {
    const input = createMockHookInput('PreToolUse', {
      session_id: 'session-abc',
      tool_name: 'Task',
      tool_input: { prompt: `RD_CLAIM_TOKEN=${VALID_TOKEN}` },
    });

    const result = await handleDelegationDispatch(input);

    expect(result.context).toContain(`rd claim ${VALID_TOKEN}`);
    expect(result.context).toContain('rd pass --claim-id <claim_id>');
  });

  it('returns context even when rd status --json fails (best-effort)', async () => {
    setExecSync(mockExecFileSyncError({ message: 'command failed' }));

    const input = createMockHookInput('PreToolUse', {
      tool_name: 'Task',
      tool_input: { prompt: `RD_CLAIM_TOKEN=${VALID_TOKEN}` },
    });

    const result = await handleDelegationDispatch(input);
    expect(result.context).toContain(`rd claim ${VALID_TOKEN}`);
    expect(result.context).toContain('rd pass');
  });

  it('includes delegation status lines when rd status --json succeeds', async () => {
    const mockExec = mockExecFileSync(JSON.stringify({ file: 'deploy.md', step: { name: '3.1' } }));
    setExecSync(mockExec);

    const input = createMockHookInput('PreToolUse', {
      tool_name: 'Task',
      tool_input: { prompt: `RD_CLAIM_TOKEN=${VALID_TOKEN}` },
    });

    const result = await handleDelegationDispatch(input);
    expect(result.context).toContain('Active runbook: deploy.md');
    expect(result.context).toContain('Current step: 3.1');
  });

  it('does not inject inherited input flags from rd status vars or delegations', async () => {
    const status = {
      file: 'parent.md',
      step: { name: '3' },
      vars: { PlanPath: '/work/plan.json', environment: 'production', unrelated: 'skip' },
      delegations: [
        {
          state: 'pending',
          runbook: 'child.runbook.md',
          tokenHash: hashDelegationToken(VALID_TOKEN),
        },
      ],
    };
    setExecSync(mockExecFileSync(JSON.stringify(status)));

    const input = createMockHookInput('PreToolUse', {
      tool_name: 'Task',
      tool_input: { prompt: `RD_CLAIM_TOKEN=${VALID_TOKEN}` },
    });

    const result = await handleDelegationDispatch(input);
    expect(result.context).toContain(`rd claim ${VALID_TOKEN}`);
    expect(result.context).not.toContain('--input');
    expect(result.context).not.toContain('--input-json');
    expect(result.context).not.toContain('--input-file');
    expect(result.context).not.toContain('PlanPath=');
  });
});
