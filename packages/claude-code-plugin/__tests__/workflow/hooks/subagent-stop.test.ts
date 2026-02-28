// __tests__/workflow/hooks/subagent-stop.test.ts
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

const { handleSubagentStop, parseAgentStatus } = await import(
  '../../../src/workflow/hooks/subagent-stop.js'
);

const VALID_TOKEN = 'rdtk_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

describe('handleSubagentStop', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockResolvedValue({});
    mockSet.mockResolvedValue(undefined);
    setExecSync(jest.fn() as never);
  });

  afterEach(() => {
    setExecSync(jest.fn() as never);
  });

  describe('event filtering', () => {
    it('returns empty result for non-SubagentStop events', async () => {
      const input = createMockHookInput('PostToolUse');
      const result = await handleSubagentStop(input);
      expect(result).toEqual({});
    });
  });

  describe('delegation-aware abort', () => {
    it('returns empty when status is pass (no abort needed)', async () => {
      mockGet.mockResolvedValue({ delegation_active_token: VALID_TOKEN });

      const input = createMockHookInput('SubagentStop', {
        last_assistant_message: 'STATUS: PASS',
      });

      const result = await handleSubagentStop(input);
      expect(result).toEqual({});
    });

    it('returns empty when status is fail but no delegation_active_token in session', async () => {
      mockGet.mockResolvedValue({});

      const input = createMockHookInput('SubagentStop', {
        last_assistant_message: 'STATUS: FAIL',
      });

      const result = await handleSubagentStop(input);
      expect(result).toEqual({});
    });

    it('calls rd abort <token> --force when status is fail and token exists', async () => {
      mockGet.mockResolvedValue({ delegation_active_token: VALID_TOKEN });
      const mockExec = createMockExecSync('Delegation aborted');
      setExecSync(mockExec as never);

      const input = createMockHookInput('SubagentStop', {
        last_assistant_message: 'STATUS: FAIL',
        cwd: '/my/project',
      });

      await handleSubagentStop(input);

      expect(mockExec).toHaveBeenCalledWith(
        'node',
        expect.arrayContaining(['abort', VALID_TOKEN, '--force']),
        expect.objectContaining({ cwd: '/my/project' }),
      );
    });

    it('clears delegation_active_token from session after abort', async () => {
      mockGet.mockResolvedValue({
        delegation_active_token: VALID_TOKEN,
        other_key: 'preserved',
      });
      setExecSync(createMockExecSync('OK') as never);

      const input = createMockHookInput('SubagentStop', {
        last_assistant_message: 'STATUS: FAIL',
      });

      await handleSubagentStop(input);

      expect(mockSet).toHaveBeenCalledWith('metadata', { other_key: 'preserved' });
    });

    it('returns context describing abort on success', async () => {
      mockGet.mockResolvedValue({ delegation_active_token: VALID_TOKEN });
      setExecSync(createMockExecSync('OK') as never);

      const input = createMockHookInput('SubagentStop', {
        last_assistant_message: 'STATUS: FAIL',
      });

      const result = await handleSubagentStop(input);
      expect(result.context).toContain(VALID_TOKEN);
      expect(result.context).toContain('aborted');
    });

    it('returns empty when abort call fails (best-effort)', async () => {
      mockGet.mockResolvedValue({ delegation_active_token: VALID_TOKEN });
      setExecSync(
        jest.fn().mockImplementation(() => {
          throw new Error('abort failed');
        }) as never,
      );

      const input = createMockHookInput('SubagentStop', {
        last_assistant_message: 'STATUS: FAIL',
      });

      const result = await handleSubagentStop(input);
      expect(result).toEqual({});
    });

    it('clears token even on pass (consume-once)', async () => {
      mockGet.mockResolvedValue({ delegation_active_token: VALID_TOKEN });

      const input = createMockHookInput('SubagentStop', {
        last_assistant_message: 'STATUS: PASS',
      });

      await handleSubagentStop(input);

      expect(mockSet).toHaveBeenCalledWith('metadata', {});
    });
  });
});

describe('parseAgentStatus', () => {
  it('returns pass for undefined output', () => {
    expect(parseAgentStatus(undefined)).toBe('pass');
  });

  it('returns pass for empty string', () => {
    expect(parseAgentStatus('')).toBe('pass');
  });

  it('parses STATUS: OK as pass', () => {
    expect(parseAgentStatus('STATUS: OK')).toBe('pass');
  });

  it('parses STATUS: PASS as pass', () => {
    expect(parseAgentStatus('STATUS: PASS')).toBe('pass');
  });

  it('parses STATUS: FAIL as fail', () => {
    expect(parseAgentStatus('STATUS: FAIL')).toBe('fail');
  });

  it('parses STATUS: BLOCKED as fail', () => {
    expect(parseAgentStatus('STATUS: BLOCKED')).toBe('fail');
  });

  it('is case-insensitive', () => {
    expect(parseAgentStatus('status: blocked')).toBe('fail');
  });

  it('returns pass when no STATUS field found', () => {
    expect(parseAgentStatus('Agent completed without status')).toBe('pass');
  });
});
