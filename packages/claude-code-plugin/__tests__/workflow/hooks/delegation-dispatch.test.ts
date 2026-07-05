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
    // Default: rundown status --json fails (no active runbook)
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

  it('returns context with rundown claim instruction when marker found in prompt', async () => {
    const input = createMockHookInput('PreToolUse', {
      tool_name: 'Task',
      tool_input: {
        prompt: `Do the work\nRD_CLAIM_TOKEN=${VALID_TOKEN}\nThen report`,
        description: 'A description',
      },
    });
    const result = await handleDelegationDispatch(input);
    expect(result.context).toContain(`rundown claim ${VALID_TOKEN}`);
    expect(result.context).toContain('Delegation Context');
  });

  it('returns context with rundown claim instruction when marker found in description', async () => {
    const input = createMockHookInput('PreToolUse', {
      tool_name: 'Task',
      tool_input: {
        prompt: 'No marker here',
        description: `Delegated task\nRD_CLAIM_TOKEN=${VALID_TOKEN}`,
      },
    });
    const result = await handleDelegationDispatch(input);
    expect(result.context).toContain(`rundown claim ${VALID_TOKEN}`);
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

    // Final-state assertion (recording now runs through session.update, so the
    // committed metadata is observable via get rather than a set call shape).
    const written = await session.get('metadata');
    expect(written).toEqual({
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

    // Final-state assertion after recording (session.update path).
    const written = await session.get('metadata');
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

    // SubagentStop reads the just-recorded per-agent entry back. Closure cannot
    // be proven here (no Rundown state in this harness — core's closure read is
    // NOT mocked in this suite), so verify-before-consume KEEPS the token and
    // re-issues the block. That the stop returns a closure violation (rather
    // than `{}`) proves the dispatched entry round-tripped and was located.
    const stopInput = createMockHookInput('SubagentStop', {
      agent_id: 'agent-123',
      session_id: 'session-abc',
    });

    const stopResult = await handleSubagentStop(stopInput);
    expect(stopResult.violation).toBeDefined();

    // Token kept (closure unprovable) — both the stopping agent's entry and its
    // sibling survive. Final-state assertion is agnostic to set vs update.
    expect(await session.get('metadata')).toEqual({
      delegation_active_tokens: {
        'agent-123': expect.objectContaining({
          agent_id: 'agent-123',
          tokenHash: hashDelegationToken(VALID_TOKEN),
        }),
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
    expect((rejection as Error).name).toBe('DelegationTokenRecordingError');
    expect((rejection as Error).message).toBe(
      'Failed to record delegation token in session metadata',
    );
    expect(getErrorMessage((rejection as { cause?: unknown }).cause)).toContain(
      'delegation_active_tokens key must match metadata.agent_id',
    );
    // The updater throws before committing, so nothing is persisted: the
    // pre-existing (drifted) metadata is left untouched (fail-closed, no write).
    expect(mockSet).not.toHaveBeenCalled();
    expect(await session.get('metadata')).toEqual({
      delegation_active_tokens: {
        'agent-1': {
          kind: 'delegation-active-token',
          agent_id: 'different-agent',
          tokenHash: hashDelegationToken(VALID_TOKEN),
          createdAt: '2026-04-28T00:00:00.000Z',
        },
      },
    });
  });

  it('stores a token hash in legacy global metadata when agent_id is absent', async () => {
    setGet(session, 'metadata', {});

    const input = createMockHookInput('PreToolUse', {
      tool_name: 'Task',
      tool_input: { prompt: `RD_CLAIM_TOKEN=${VALID_TOKEN}` },
    });

    await handleDelegationDispatch(input);

    expect(await session.get('metadata')).toEqual({
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
    expect(result.context).toContain(`rundown claim ${VALID_TOKEN}`);
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
    expect(result.context).toContain(`rundown claim ${VALID_TOKEN}`);
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

    expect(await session.get('metadata')).toEqual({
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

    expect(result.context).toContain(`rundown claim ${VALID_TOKEN}`);
    expect(result.context).toContain('Copy the `claim_id` from the claim output.');
    expect(result.context).toContain('rundown status --claim-id <claim_id>');
    expect(result.context).toContain('rundown pass --claim-id <claim_id>');
    expect(result.context).toContain('rundown fail --claim-id <claim_id>');
    expect(result.context).toContain(['```', `rundown claim ${VALID_TOKEN}`, '```'].join('\n'));
    expect(result.context).toContain(
      [
        '```',
        'rundown status --claim-id <claim_id>',
        'rundown pass --claim-id <claim_id>',
        'rundown fail --claim-id <claim_id>',
        'rundown stash --claim-id <claim_id>',
        'rundown pop --claim-id <claim_id>',
        'rundown stop --claim-id <claim_id>',
        'rundown complete --claim-id <claim_id>',
        '```',
      ].join('\n'),
    );
    expect(result.context).toContain(
      'Before stopping, complete the delegated runbook explicitly with `rundown pass --claim-id <claim_id>` or `rundown fail --claim-id <claim_id>`.',
    );
  });

  it('injects claim-id guidance without agent identity', async () => {
    const input = createMockHookInput('PreToolUse', {
      session_id: 'session-abc',
      tool_name: 'Task',
      tool_input: { prompt: `RD_CLAIM_TOKEN=${VALID_TOKEN}` },
    });

    const result = await handleDelegationDispatch(input);

    expect(result.context).toContain(`rundown claim ${VALID_TOKEN}`);
    expect(result.context).toContain('rundown pass --claim-id <claim_id>');
  });

  it('returns context even when rundown status --json fails (best-effort)', async () => {
    setExecSync(mockExecFileSyncError({ message: 'command failed' }));

    const input = createMockHookInput('PreToolUse', {
      tool_name: 'Task',
      tool_input: { prompt: `RD_CLAIM_TOKEN=${VALID_TOKEN}` },
    });

    const result = await handleDelegationDispatch(input);
    expect(result.context).toContain(`rundown claim ${VALID_TOKEN}`);
    expect(result.context).toContain('rundown pass');
  });

  it('includes delegation status lines when rundown status --json succeeds', async () => {
    const mockExec = mockExecFileSync(JSON.stringify({ file: 'deploy.md', step: { name: '3.1' } }));
    setExecSync(mockExec);

    const input = createMockHookInput('PreToolUse', {
      tool_name: 'Task',
      tool_input: { prompt: `RD_CLAIM_TOKEN=${VALID_TOKEN}` },
    });

    const result = await handleDelegationDispatch(input);
    expect(result.context).toContain('Active runbook: deploy.md');
    expect(result.context).toContain('Current step: 3.1');

    // Pins the exact `rundown status` invocation args (kills mutants that drop
    // or blank the 'status' argument, which would be invisible to toContain
    // checks since the mock ignores its args and returns fixed output).
    expect(mockExec).toHaveBeenCalledWith(
      'node',
      expect.arrayContaining(['status']),
      expect.anything(),
    );

    // Exact-match pin of the full generated context: guards every literal
    // (including blank-line separators) and the status-lines insertion point
    // against silent corruption.
    expect(result.context).toBe(
      [
        '## Delegation Context',
        '',
        'This task is a delegated substep. Claim the delegation token before starting work:',
        '',
        '```',
        `rundown claim ${VALID_TOKEN}`,
        '```',
        '',
        'Copy the `claim_id` from the claim output. Use it for all later Rundown commands:',
        '',
        '```',
        'rundown status --claim-id <claim_id>',
        'rundown pass --claim-id <claim_id>',
        'rundown fail --claim-id <claim_id>',
        'rundown stash --claim-id <claim_id>',
        'rundown pop --claim-id <claim_id>',
        'rundown stop --claim-id <claim_id>',
        'rundown complete --claim-id <claim_id>',
        '```',
        '',
        'Active runbook: deploy.md',
        'Current step: 3.1',
        '',
        'Before stopping, complete the delegated runbook explicitly with `rundown pass --claim-id <claim_id>` or `rundown fail --claim-id <claim_id>`.',
      ].join('\n'),
    );
  });

  it('produces the exact delegation context text when no status is available', async () => {
    // Default beforeEach mock: `rundown status` fails (no active runbook).
    const input = createMockHookInput('PreToolUse', {
      tool_name: 'Task',
      tool_input: { prompt: `RD_CLAIM_TOKEN=${VALID_TOKEN}` },
    });

    const result = await handleDelegationDispatch(input);

    expect(result.context).toBe(
      [
        '## Delegation Context',
        '',
        'This task is a delegated substep. Claim the delegation token before starting work:',
        '',
        '```',
        `rundown claim ${VALID_TOKEN}`,
        '```',
        '',
        'Copy the `claim_id` from the claim output. Use it for all later Rundown commands:',
        '',
        '```',
        'rundown status --claim-id <claim_id>',
        'rundown pass --claim-id <claim_id>',
        'rundown fail --claim-id <claim_id>',
        'rundown stash --claim-id <claim_id>',
        'rundown pop --claim-id <claim_id>',
        'rundown stop --claim-id <claim_id>',
        'rundown complete --claim-id <claim_id>',
        '```',
        '',
        'Before stopping, complete the delegated runbook explicitly with `rundown pass --claim-id <claim_id>` or `rundown fail --claim-id <claim_id>`.',
      ].join('\n'),
    );
  });

  it('omits the runbook line when rundown status file is not a string', async () => {
    const status = { file: 42, step: { name: '1' } };
    setExecSync(mockExecFileSync(JSON.stringify(status)));

    const input = createMockHookInput('PreToolUse', {
      tool_name: 'Task',
      tool_input: { prompt: `RD_CLAIM_TOKEN=${VALID_TOKEN}` },
    });

    const result = await handleDelegationDispatch(input);
    expect(result.context).not.toContain('Active runbook:');
    expect(result.context).toContain('Current step: 1');
  });

  it('omits the current-step line when rundown status step.name is not a string', async () => {
    const status = { file: 'ok.md', step: { name: 42 } };
    setExecSync(mockExecFileSync(JSON.stringify(status)));

    const input = createMockHookInput('PreToolUse', {
      tool_name: 'Task',
      tool_input: { prompt: `RD_CLAIM_TOKEN=${VALID_TOKEN}` },
    });

    const result = await handleDelegationDispatch(input);
    expect(result.context).toContain('Active runbook: ok.md');
    expect(result.context).not.toContain('Current step:');
  });

  it('omits the current-step line when rundown status has no step at all', async () => {
    const status = { file: 'only-file.md' };
    setExecSync(mockExecFileSync(JSON.stringify(status)));

    const input = createMockHookInput('PreToolUse', {
      tool_name: 'Task',
      tool_input: { prompt: `RD_CLAIM_TOKEN=${VALID_TOKEN}` },
    });

    const result = await handleDelegationDispatch(input);
    expect(result.context).toContain('Active runbook: only-file.md');
    expect(result.context).not.toContain('Current step:');
  });

  it('returns empty when tool_name is not a delegation tool even if a marker is present', async () => {
    const input = createMockHookInput('PreToolUse', {
      tool_name: 'Edit',
      tool_input: {
        file_path: '/test/file.ts',
        prompt: `RD_CLAIM_TOKEN=${VALID_TOKEN}`,
      },
    });

    const result = await handleDelegationDispatch(input);
    expect(result).toEqual({});
  });

  it('returns empty for non-PreToolUse events even when tool_name and prompt would otherwise match', async () => {
    const input = createMockHookInput('PostToolUse', {
      tool_name: 'Task',
      tool_input: { prompt: `RD_CLAIM_TOKEN=${VALID_TOKEN}` },
    });

    const result = await handleDelegationDispatch(input);
    expect(result).toEqual({});
  });

  it('resolves to empty without throwing when tool_input is absent', async () => {
    const input = createMockHookInput('PreToolUse', {
      tool_name: 'Task',
      tool_input: undefined,
    });

    await expect(handleDelegationDispatch(input)).resolves.toEqual({});
  });

  it('does not inject inherited input flags from rundown status vars or delegations', async () => {
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
    expect(result.context).toContain(`rundown claim ${VALID_TOKEN}`);
    expect(result.context).not.toContain('--input');
    expect(result.context).not.toContain('--input-json');
    expect(result.context).not.toContain('--input-file');
    expect(result.context).not.toContain('PlanPath=');
  });
});
