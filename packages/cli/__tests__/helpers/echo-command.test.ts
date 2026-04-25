import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { mockErrorHelpers } from './mock-error-helpers.js';

// Mock @rundown-org/core
const mockGetActive = jest.fn<any>();
jest.unstable_mockModule('@rundown-org/core', () => ({
  RunbookStateManager: jest.fn(),
  SessionService: jest.fn<any>().mockImplementation(() => ({
    getActive: mockGetActive,
  })),
  ...mockErrorHelpers,
}));

// Mock execution service for isValidResult
jest.unstable_mockModule('../../src/services/execution.js', () => ({
  isValidResult: jest.fn((r: string) => r === 'pass' || r === 'fail'),
}));

const { executeEchoLogic, toExecutionResult, DEFAULT_RESULT_SEQUENCE } = await import(
  '../../src/helpers/echo-command.js'
);

describe('toExecutionResult', () => {
  it('maps success=true to exitCode 0', () => {
    const result = toExecutionResult({ success: true, exitCode: 0, output: 'hello' });
    expect(result).toEqual({ success: true, exitCode: 0 });
  });

  it('maps success=false to exitCode 1', () => {
    const result = toExecutionResult({ success: false, exitCode: 1, error: 'oops' });
    expect(result).toEqual({ success: false, exitCode: 1 });
  });
});

describe('DEFAULT_RESULT_SEQUENCE', () => {
  it('defaults to a single pass', () => {
    expect(DEFAULT_RESULT_SEQUENCE).toEqual(['pass']);
  });
});

describe('executeEchoLogic', () => {
  beforeEach(() => {
    mockGetActive.mockReset();
  });

  it('returns error when no active runbook', async () => {
    mockGetActive.mockResolvedValue(null);
    const result = await executeEchoLogic(['pass'], ['hello'], '/tmp');
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain('No active runbook');
  });

  it('returns error for invalid result in sequence', async () => {
    mockGetActive.mockResolvedValue({ retryCount: 0 });
    const result = await executeEchoLogic(['pass', 'invalid'], ['hello'], '/tmp');
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain('Invalid result');
  });

  it('returns success for single pass', async () => {
    mockGetActive.mockResolvedValue({ retryCount: 0 });
    const result = await executeEchoLogic(['pass'], ['hello', 'world'], '/tmp');
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('hello world');
  });

  it('returns failure for single fail', async () => {
    mockGetActive.mockResolvedValue({ retryCount: 0 });
    const result = await executeEchoLogic(['fail'], ['hello'], '/tmp');
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.output).toBe('hello');
  });

  it('selects result based on retry count', async () => {
    mockGetActive.mockResolvedValue({ retryCount: 1 });
    const result = await executeEchoLogic(['fail', 'pass'], ['test'], '/tmp');
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('clamps index to sequence length', async () => {
    mockGetActive.mockResolvedValue({ retryCount: 5 });
    const result = await executeEchoLogic(['fail', 'pass'], ['test'], '/tmp');
    // retryCount=5, sequence length=2, index = min(5,1) = 1 → 'pass'
    expect(result.success).toBe(true);
  });

  it('uses default sequence when empty array provided', async () => {
    mockGetActive.mockResolvedValue({ retryCount: 0 });
    const result = await executeEchoLogic([], ['test'], '/tmp');
    // Default sequence is ['pass'], so should succeed
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('normalizes uppercase result values', async () => {
    mockGetActive.mockResolvedValue({ retryCount: 0 });
    const result = await executeEchoLogic(['PASS'], ['test'], '/tmp');
    expect(result.success).toBe(true);
  });
});
