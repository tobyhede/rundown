import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock @rundown-org/core
jest.unstable_mockModule('@rundown-org/core', () => ({
  RunbookStateManager: jest.fn(),
  RunbookActorService: jest.fn(),
  SessionService: jest.fn(),
  parseStepIdFromString: jest.fn(),
  stepIdToString: jest.fn((id: { step: string; substep?: string }) =>
    id.substep ? `${id.step}.${id.substep}` : id.step,
  ),
  buildStepPosition: jest.fn((current: string, total: number, substep?: string) => ({
    current,
    total,
    ...(substep ? { substep } : {}),
  })),
  derivePositionAt: jest.fn(
    (pos: { current: string; substep?: string; for?: { index: number } }) =>
      `${pos.current}${pos.for?.index != null ? `.${String(pos.for.index)}` : ''}${pos.substep ? `.${pos.substep}` : ''}`,
  ),
  countNumberedSteps: jest.fn().mockReturnValue(3),
  getErrorMessage: (error: unknown) => (Error.isError(error) ? error.message : String(error)),
  isNodeError: (error: unknown) => Error.isError(error) && 'code' in error,
  isError: (error: unknown) => Error.isError(error),
}));

// Mock execution service
jest.unstable_mockModule('../../src/services/execution', () => ({
  runExecutionLoop: jest.fn().mockResolvedValue('done'),
}));

// Mock runbook-loader
jest.unstable_mockModule('../../src/helpers/runbook-loader', () => ({
  getRunbookFromState: jest.fn().mockReturnValue([]),
}));

// Mock execution-emitter
jest.unstable_mockModule('../../src/helpers/execution-emitter', () => ({
  createBridgedEmitter: jest.fn().mockReturnValue({}),
}));

// Import after mocking
const core = await import('@rundown-org/core');
const { runExecutionLoop } = await import('../../src/services/execution');
const { validateGotoTarget, executeGoto } = await import('../../src/helpers/goto-workflow');

function makeStep(overrides: Record<string, unknown> = {}): any {
  const obj = {
    name: '1',
    description: 'Test Step',
    transitions: {
      pass: { action: 'continue' as const, retry: 0 },
      fail: { action: 'continue' as const, retry: 0 },
    },
    ...overrides,
  };
  const kind =
    obj.forClause !== undefined
      ? 'for'
      : Array.isArray(obj.substeps) && (obj.substeps as unknown[]).length > 0
        ? 'substeps'
        : obj.command !== undefined
          ? 'command'
          : 'base';
  return { ...obj, kind } as any;
}

beforeEach(() => {
  jest.resetAllMocks();
  // Re-establish default mock implementations after reset
  (core.stepIdToString as jest.Mock).mockImplementation((id: { step: string; substep?: string }) =>
    id.substep ? `${id.step}.${id.substep}` : id.step,
  );
  (core.buildStepPosition as jest.Mock).mockImplementation(
    (current: string, total: number, substep?: string) => ({
      current,
      total,
      ...(substep ? { substep } : {}),
    }),
  );
  (core.derivePositionAt as jest.Mock).mockImplementation(
    (pos: { current: string; substep?: string; for?: { index: number } }) =>
      `${pos.current}${pos.for?.index != null ? `.${String(pos.for.index)}` : ''}${pos.substep ? `.${pos.substep}` : ''}`,
  );
  (core.countNumberedSteps as jest.Mock).mockReturnValue(3);
  (runExecutionLoop as jest.Mock).mockResolvedValue('done');
});

describe('validateGotoTarget', () => {
  it('rejects invalid format', () => {
    (
      core.parseStepIdFromString as jest.MockedFunction<typeof core.parseStepIdFromString>
    ).mockReturnValue(null);

    const result = validateGotoTarget('abc', [makeStep()]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_SYNTAX');
      expect(result.details).toEqual({ provided: 'abc' });
    }
  });

  it('rejects missing step', () => {
    (
      core.parseStepIdFromString as jest.MockedFunction<typeof core.parseStepIdFromString>
    ).mockReturnValue({ step: '99' });

    const steps = [makeStep({ name: '1' }), makeStep({ name: '2' })];
    const result = validateGotoTarget('99', steps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('STEP_NOT_FOUND');
      expect(result.details?.available).toEqual(['1', '2']);
    }
  });

  it('rejects AT on non-FOR step', () => {
    (
      core.parseStepIdFromString as jest.MockedFunction<typeof core.parseStepIdFromString>
    ).mockReturnValue({ step: '1', at: 3 });

    const steps = [makeStep({ name: '1' })]; // No forClause
    const result = validateGotoTarget('1', steps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_AT_TARGET');
    }
  });

  it('accepts AT on FOR step', () => {
    (
      core.parseStepIdFromString as jest.MockedFunction<typeof core.parseStepIdFromString>
    ).mockReturnValue({ step: '1', at: 3 });

    const steps = [makeStep({ name: '1', forClause: { variable: 'x', start: 1, end: 5 } as any })];
    const result = validateGotoTarget('1', steps);

    expect(result.ok).toBe(true);
  });

  it('rejects substep on step without substeps', () => {
    (
      core.parseStepIdFromString as jest.MockedFunction<typeof core.parseStepIdFromString>
    ).mockReturnValue({ step: '1', substep: '2' });

    const steps = [makeStep({ name: '1' })]; // No substeps
    const result = validateGotoTarget('1.2', steps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('STEP_NOT_FOUND');
    }
  });

  it('rejects nonexistent substep', () => {
    (
      core.parseStepIdFromString as jest.MockedFunction<typeof core.parseStepIdFromString>
    ).mockReturnValue({ step: '1', substep: '3' });

    const steps = [
      makeStep({
        name: '1',
        substeps: [
          { id: '1', description: 'Sub 1' },
          { id: '2', description: 'Sub 2' },
        ] as any,
      }),
    ];
    const result = validateGotoTarget('1.3', steps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('STEP_NOT_FOUND');
      expect(result.details?.available).toEqual(['1', '2']);
    }
  });

  it('accepts valid step', () => {
    (
      core.parseStepIdFromString as jest.MockedFunction<typeof core.parseStepIdFromString>
    ).mockReturnValue({ step: '2' });

    const steps = [makeStep({ name: '1' }), makeStep({ name: '2' })];
    const result = validateGotoTarget('2', steps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target).toEqual({ step: '2' });
    }
  });

  it('accepts self-referencing GOTO as valid target', () => {
    (
      core.parseStepIdFromString as jest.MockedFunction<typeof core.parseStepIdFromString>
    ).mockReturnValue({ step: '1' });

    const steps = [makeStep({ name: '1' }), makeStep({ name: '2' })];
    const result = validateGotoTarget('1', steps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target).toEqual({ step: '1' });
    }
  });

  it('accepts valid substep', () => {
    (
      core.parseStepIdFromString as jest.MockedFunction<typeof core.parseStepIdFromString>
    ).mockReturnValue({ step: '1', substep: '2' });

    const steps = [
      makeStep({
        name: '1',
        substeps: [
          { id: '1', description: 'Sub 1' },
          { id: '2', description: 'Sub 2' },
        ] as any,
      }),
    ];
    const result = validateGotoTarget('1.2', steps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target).toEqual({ step: '1', substep: '2' });
    }
  });
});

describe('executeGoto', () => {
  it('returns error when sendAndSync fails', async () => {
    const mockManager = { update: jest.fn() };
    const mockActorService = { sendAndSync: jest.fn<any>().mockResolvedValue(null) };
    const mockOutput = { action: jest.fn(), flush: jest.fn() };

    const ctx = {
      output: mockOutput as any,
      manager: mockManager as any,
      actorService: mockActorService as any,
      sessionService: {} as any,
      state: { id: 'test-id', step: '1', prompted: false } as any,
      steps: [makeStep()],
      cwd: '/test',
    };

    const result = await executeGoto(ctx, { step: '2' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('ENGINE_INIT_FAILED');
    }
  });

  it('returns ok with loop result on success', async () => {
    const mockManager = { update: jest.fn<any>().mockResolvedValue(undefined) };
    const mockActorService = {
      sendAndSync: jest.fn<any>().mockResolvedValue({ state: { step: '2' } }),
    };
    const mockOutput = { action: jest.fn(), flush: jest.fn() };
    runExecutionLoop.mockResolvedValue('done');

    const ctx = {
      output: mockOutput as any,
      manager: mockManager as any,
      actorService: mockActorService as any,
      sessionService: {} as any,
      state: { id: 'test-id', step: '1', prompted: false } as any,
      steps: [makeStep({ name: '1' }), makeStep({ name: '2' })],
      cwd: '/test',
    };

    const result = await executeGoto(ctx, { step: '2' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.loopResult).toBe('done');
    }
    expect(mockOutput.action).toHaveBeenCalled();
    const updateArg = (mockManager.update as jest.Mock).mock.calls[0][1];
    expect(updateArg).toHaveProperty('lastResult', undefined);
    expect(updateArg).toHaveProperty('lastAction', { type: 'GOTO', target: '2' });
  });

  it('returns stopped when execution loop stops', async () => {
    const mockManager = { update: jest.fn<any>().mockResolvedValue(undefined) };
    const mockActorService = {
      sendAndSync: jest.fn<any>().mockResolvedValue({ state: { step: '2' } }),
    };
    const mockOutput = { action: jest.fn(), flush: jest.fn() };
    runExecutionLoop.mockResolvedValue('stopped');

    const ctx = {
      output: mockOutput as any,
      manager: mockManager as any,
      actorService: mockActorService as any,
      sessionService: {} as any,
      state: { id: 'test-id', step: '1', prompted: false } as any,
      steps: [makeStep({ name: '1' }), makeStep({ name: '2' })],
      cwd: '/test',
    };

    const result = await executeGoto(ctx, { step: '2' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.loopResult).toBe('stopped');
    }
  });
});
