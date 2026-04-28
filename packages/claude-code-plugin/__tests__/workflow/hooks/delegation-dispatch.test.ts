import { createHash } from 'node:crypto';
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { setExecSync } from '../../../src/workflow/hooks/rundown.js';
import { createMockHookInput } from '../../helpers/test-utils.js';
import { mockExecFileSync, mockExecFileSyncError } from '../../helpers/execfile-mock.js';

// Mock Session module
import { createSessionMock, setGet } from '../../helpers/session-mock.js';

const session = createSessionMock();
const mockSet = session.set;

jest.unstable_mockModule('../../../src/session.js', () => ({
  Session: jest.fn().mockImplementation(() => session),
}));

// Mock node:fs/promises to control child runbook reads in buildChildInputFlags
const mockReadFile = jest.fn<() => Promise<string>>();
jest.unstable_mockModule('node:fs/promises', () => ({
  readFile: mockReadFile,
}));

const { handleDelegationDispatch, buildChildInputFlags } = await import(
  '../../../src/workflow/hooks/delegation-dispatch.js'
);

function hashToken(token: string): string {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`;
}

const VALID_TOKEN = 'rdtk_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

describe('handleDelegationDispatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setGet(session, 'metadata', {});
    mockSet.mockResolvedValue(undefined);
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

  it('stores token in session metadata on detection', async () => {
    setGet(session, 'metadata', { existing_key: 'value' });

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
      delegation_active_token: VALID_TOKEN,
    });
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

  it('injects --input flags for inputs declared in child runbook when parent has matching vars', async () => {
    const tokenHash = hashToken(VALID_TOKEN);
    const childRunbook = `---
inputs:
  - PlanPath
  - environment
---
# Child Runbook

## 1. Step
PASS COMPLETE
`;
    mockReadFile.mockResolvedValue(childRunbook);

    const status = {
      file: 'parent.md',
      step: { name: '3' },
      vars: { PlanPath: '/work/plan.json', environment: 'production', unrelated: 'skip' },
      delegations: [{ state: 'pending', runbook: 'child.runbook.md', tokenHash }],
    };
    setExecSync(mockExecFileSync(JSON.stringify(status)));

    const input = createMockHookInput('PreToolUse', {
      tool_name: 'Task',
      tool_input: { prompt: `RD_CLAIM_TOKEN=${VALID_TOKEN}` },
    });

    const result = await handleDelegationDispatch(input);
    expect(result.context).toContain(`rd claim ${VALID_TOKEN}`);
    expect(result.context).toContain("--input PlanPath='/work/plan.json'");
    expect(result.context).toContain("--input environment='production'");
    expect(result.context).not.toContain('unrelated');
  });

  it('falls back to plain rd claim when child frontmatter validation fails', async () => {
    const tokenHash = hashToken(VALID_TOKEN);
    const childRunbook = `---
inputs:
  PlanPath: /work/plan.json
---
# Child Runbook

## 1. Step
PASS COMPLETE
`;
    mockReadFile.mockResolvedValue(childRunbook);

    const status = {
      file: 'parent.md',
      step: { name: '3' },
      vars: { PlanPath: '/work/plan.json' },
      delegations: [{ state: 'pending', runbook: 'child.runbook.md', tokenHash }],
    };
    setExecSync(mockExecFileSync(JSON.stringify(status)));

    const input = createMockHookInput('PreToolUse', {
      tool_name: 'Task',
      tool_input: { prompt: `RD_CLAIM_TOKEN=${VALID_TOKEN}` },
    });

    const result = await handleDelegationDispatch(input);
    expect(result.context).toContain(`rd claim ${VALID_TOKEN}`);
    expect(result.context).not.toContain('--input');
    expect(result.context).not.toContain('PlanPath=');
  });

  it('does not inject --input flags when no delegation matches the detected token', async () => {
    const differentTokenHash = hashToken('rdtk_ABCDEFGHIJKLMNOPQRSTUVWXYZ999999');
    const status = {
      file: 'parent.md',
      vars: { PlanPath: '/work/plan.json' },
      delegations: [
        { state: 'pending', runbook: 'child.runbook.md', tokenHash: differentTokenHash },
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
  });

  it('passes numeric parent var as --input-json flag', async () => {
    const childRunbook = `---\ninputs:\n  - port\n---\n# Child\n\n## 1. Step\n- PASS COMPLETE\n`;
    mockReadFile.mockResolvedValue(childRunbook);
    const flags = await buildChildInputFlags('child.runbook.md', { port: 3000 }, '/test/project');
    expect(flags).toBe("--input-json port='3000'");
  });

  it('shell-quotes --input values containing shell-special characters', async () => {
    const tokenHash = hashToken(VALID_TOKEN);
    const childRunbook = `---
name: child
inputs:
  - DollarVar
  - BacktickVar
  - QuoteVar
  - SpaceVar
---
# Child

## 1. Step
PASS COMPLETE
`;
    mockReadFile.mockResolvedValue(childRunbook);

    const status = {
      file: 'parent.md',
      vars: {
        DollarVar: '$HOME/data',
        BacktickVar: '`whoami`',
        QuoteVar: "it's fine",
        SpaceVar: 'has spaces',
      },
      delegations: [{ state: 'pending', runbook: 'child.runbook.md', tokenHash }],
    };
    setExecSync(mockExecFileSync(JSON.stringify(status)));

    const input = createMockHookInput('PreToolUse', {
      tool_name: 'Task',
      tool_input: { prompt: `RD_CLAIM_TOKEN=${VALID_TOKEN}` },
    });

    const result = await handleDelegationDispatch(input);

    // Each value wrapped in single quotes; internal single quotes closed-escaped-reopened.
    expect(result.context).toContain("--input DollarVar='$HOME/data'");
    expect(result.context).toContain("--input BacktickVar='`whoami`'");
    expect(result.context).toContain("--input QuoteVar='it'\\''s fine'");
    expect(result.context).toContain("--input SpaceVar='has spaces'");
  });
});
