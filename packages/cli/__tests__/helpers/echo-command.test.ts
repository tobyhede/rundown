import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { mockErrorHelpers } from './mock-error-helpers.js';
import { mockFn } from './typed-mocks.js';

import type { RunbookState, RunbookStateManager } from '@rundown-org/core';

// Mock @rundown-org/core: `rd echo` loads the run named by RD_RUN_ID through
// the state manager (structural double, CLAUDE.md § Testing Conventions).
const mockLoad = mockFn<RunbookStateManager['load']>();
const mockManagerCtor = mockFn<() => Pick<RunbookStateManager, 'load'>>();
mockManagerCtor.mockImplementation(() => ({ load: mockLoad }));
jest.unstable_mockModule('@rundown-org/core', () => ({
  RunbookStateManager: mockManagerCtor,
  ...mockErrorHelpers,
}));

// Mock execution service for isValidResult
jest.unstable_mockModule('../../src/services/execution.js', () => ({
  isValidResult: jest.fn((r: string) => r === 'pass' || r === 'fail'),
}));

const { executeEchoLogic, toExecutionResult, DEFAULT_RESULT_SEQUENCE, RUN_ID_ENV } = await import(
  '../../src/helpers/echo-command.js'
);

const RUN_ID = 'rd_0123456789abcdef0123456789abcdef';

// Test helper: production code reads `state.retryCount` only on this code
// path; the cast through `unknown` admits the abbreviated fixture without
// constructing every branded field on `RunbookState`.
const asState = (value: { retryCount: number }): RunbookState => value as unknown as RunbookState;

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
    mockLoad.mockReset();
  });

  it('returns error when no run context is supplied', async () => {
    const result = await executeEchoLogic(['pass'], ['hello'], '/tmp', undefined);
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain('No run context');
    expect(result.error).toContain(RUN_ID_ENV);
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('returns error when the named run does not exist', async () => {
    mockLoad.mockResolvedValue(null);
    const result = await executeEchoLogic(['pass'], ['hello'], '/tmp', RUN_ID);
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toBe(`Error: Run ${RUN_ID} not found.`);
    expect(mockLoad).toHaveBeenCalledWith(RUN_ID);
  });

  it('defaults the run id to RD_RUN_ID from the environment', async () => {
    const previous = process.env[RUN_ID_ENV];
    process.env[RUN_ID_ENV] = RUN_ID;
    try {
      mockLoad.mockResolvedValue(asState({ retryCount: 0 }));
      const result = await executeEchoLogic(['pass'], ['hello'], '/tmp');
      expect(result.success).toBe(true);
      expect(mockLoad).toHaveBeenCalledWith(RUN_ID);
    } finally {
      if (previous === undefined) delete process.env[RUN_ID_ENV];
      else process.env[RUN_ID_ENV] = previous;
    }
  });

  it('returns error for invalid result in sequence', async () => {
    mockLoad.mockResolvedValue(asState({ retryCount: 0 }));
    const result = await executeEchoLogic(['pass', 'invalid'], ['hello'], '/tmp', RUN_ID);
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain('Invalid result');
  });

  it('returns success for single pass', async () => {
    mockLoad.mockResolvedValue(asState({ retryCount: 0 }));
    const result = await executeEchoLogic(['pass'], ['hello', 'world'], '/tmp', RUN_ID);
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('hello world');
  });

  it('returns failure for single fail', async () => {
    mockLoad.mockResolvedValue(asState({ retryCount: 0 }));
    const result = await executeEchoLogic(['fail'], ['hello'], '/tmp', RUN_ID);
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.output).toBe('hello');
  });

  it('selects result based on retry count', async () => {
    mockLoad.mockResolvedValue(asState({ retryCount: 1 }));
    const result = await executeEchoLogic(['fail', 'pass'], ['test'], '/tmp', RUN_ID);
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('clamps index to sequence length', async () => {
    mockLoad.mockResolvedValue(asState({ retryCount: 5 }));
    const result = await executeEchoLogic(['fail', 'pass'], ['test'], '/tmp', RUN_ID);
    // retryCount=5, sequence length=2, index = min(5,1) = 1 → 'pass'
    expect(result.success).toBe(true);
  });

  it('uses default sequence when empty array provided', async () => {
    mockLoad.mockResolvedValue(asState({ retryCount: 0 }));
    const result = await executeEchoLogic([], ['test'], '/tmp', RUN_ID);
    // Default sequence is ['pass'], so should succeed
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('normalizes uppercase result values', async () => {
    mockLoad.mockResolvedValue(asState({ retryCount: 0 }));
    const result = await executeEchoLogic(['PASS'], ['test'], '/tmp', RUN_ID);
    expect(result.success).toBe(true);
  });
});
