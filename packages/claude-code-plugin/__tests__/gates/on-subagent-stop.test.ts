// packages/claude-code-plugin/__tests__/gates/on-subagent-stop.test.ts
import { jest, expect, describe, it, beforeEach } from '@jest/globals';
import type { HookInput } from '../../src/shared/index.js';
import type { handleSubagentStop } from '../../src/workflow/hooks/subagent-stop.js';

const mockHandleSubagentStop = jest.fn() as jest.MockedFunction<typeof handleSubagentStop>;

jest.unstable_mockModule('../../src/workflow/hooks/subagent-stop.js', () => ({
  handleSubagentStop: mockHandleSubagentStop,
}));

// Mock the logger so the fail-closed test can assert exactly what gets logged
// inside the catch block (message + error data), which is what kills the
// StringLiteral/ObjectLiteral/BlockStatement mutants on the `logger.error(...)`
// call at lines 20-26 -- otherwise nothing observes its arguments, since the
// real logger swallows its own I/O errors and never affects the returned
// GateResult. The gate imports `logger` from ../shared/index.js, which
// re-exports ./logger.js via `export *` (see subagent-stop-fail-closed
// regression test for the same pattern).
const mockLoggerError = jest.fn<(...args: unknown[]) => Promise<void>>();

jest.unstable_mockModule('../../src/shared/logger.js', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: mockLoggerError,
    always: jest.fn(),
    event: jest.fn(),
    getLogFilePath: jest.fn(),
    getLogDir: jest.fn(),
  },
}));

const { execute } = await import('../../src/gates/on-subagent-stop.js');

describe('on-subagent-stop gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoggerError.mockResolvedValue(undefined);
  });

  it('returns empty result when no context or violation', async () => {
    mockHandleSubagentStop.mockResolvedValue({});

    const input: HookInput = {
      hook_event_name: 'SubagentStop',
      cwd: '/test',
      agent_id: 'agent-123',
    };

    const result = await execute(input);
    // toStrictEqual (not toEqual) so an `if (result.context)` mutant that always
    // takes the truthy branch is caught: that mutant would produce
    // `{ additionalContext: undefined }`, which toEqual treats as equal to `{}`
    // but toStrictEqual does not.
    expect(result).toStrictEqual({});
    expect(result).not.toHaveProperty('additionalContext');
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

  it('fails closed with a blocking decision when handleSubagentStop rejects', async () => {
    mockHandleSubagentStop.mockRejectedValue(new Error('session state I/O failed'));

    const input: HookInput = {
      hook_event_name: 'SubagentStop',
      cwd: '/test',
      agent_id: 'agent-err',
    };

    const result = await execute(input);
    expect(result).toStrictEqual({
      decision: 'block',
      reason:
        'Could not verify delegation closure (session state unavailable). Run `rundown status` and close any open delegations before stopping.',
    });
    expect(mockLoggerError).toHaveBeenCalledWith(
      'SubagentStop enforcement failed; failing closed',
      {
        error: 'session state I/O failed',
      },
    );
  });

  it('still fails closed when logging inside the catch block also fails', async () => {
    mockHandleSubagentStop.mockRejectedValue(new Error('session state I/O failed'));
    mockLoggerError.mockRejectedValue(new Error('log directory unwritable'));

    const input: HookInput = {
      hook_event_name: 'SubagentStop',
      cwd: '/test',
      agent_id: 'agent-err',
    };

    const result = await execute(input);
    expect(result).toStrictEqual({
      decision: 'block',
      reason:
        'Could not verify delegation closure (session state unavailable). Run `rundown status` and close any open delegations before stopping.',
    });
  });
});
