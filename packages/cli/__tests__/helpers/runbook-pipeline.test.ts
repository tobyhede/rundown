import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock @rundown-org/core
jest.unstable_mockModule('@rundown-org/core', () => ({
  parseRunbookDocument: jest.fn(),
  stepIdToString: jest.fn((id: { step: string; substep?: string }) =>
    id.substep ? `${id.step}.${id.substep}` : id.step,
  ),
  parseStepIdFromString: jest.fn(),
  STATE_DIR: '.claude/rundown/runs',
}));

// Mock @rundown-org/parser
jest.unstable_mockModule('@rundown-org/parser', () => ({
  isSourced: jest.fn(),
}));

// Mock resolve-runbook
jest.unstable_mockModule('../../src/helpers/resolve-runbook', () => ({
  resolveRunbookFile: jest.fn(),
}));

// Mock execution service
jest.unstable_mockModule('../../src/services/execution', () => ({
  runExecutionLoop: jest.fn().mockResolvedValue('done'),
}));

// Mock execution-emitter
jest.unstable_mockModule('../../src/helpers/execution-emitter', () => ({
  createBridgedEmitter: jest.fn().mockReturnValue({
    emit: jest.fn(),
  }),
}));

// Mock variable-discovery
jest.unstable_mockModule('../../src/services/variable-discovery', () => ({
  extractVarsFromMarkdown: jest.fn().mockReturnValue({}),
  resolveVariables: jest.fn().mockResolvedValue({ vars: {}, sources: {} }),
}));

// Mock template-renderer
jest.unstable_mockModule('../../src/services/template-renderer', () => ({
  substituteRunbookVariables: jest.fn((runbook: unknown) => runbook),
  expandForClauseVariables: jest.fn((content: string) => content),
}));

// Mock node:fs/promises
jest.unstable_mockModule('node:fs/promises', () => ({
  readFile: jest.fn().mockResolvedValue('# Test\n\n## 1. Step\n- PASS: CONTINUE'),
}));

// Import after mocking
const core = await import('@rundown-org/core');
const parser = await import('@rundown-org/parser');
const { resolveRunbookFile } = await import('../../src/helpers/resolve-runbook');
const { runExecutionLoop } = await import('../../src/services/execution');
const { validateSources, prepareRunbook, queueStep, startRunbook, bindAgent } = await import(
  '../../src/helpers/runbook-pipeline'
);

function makeStep(overrides: Partial<any> = {}): any {
  return {
    name: '1',
    description: 'Test Step',
    transitions: {
      pass: { action: 'continue' as const, retry: 0 },
      fail: { action: 'continue' as const, retry: 0 },
    },
    ...overrides,
  } as any;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('validateSources', () => {
  it('passes when no FOR clauses', () => {
    expect(() => validateSources([makeStep()], {})).not.toThrow();
  });

  it('passes when sourced FOR clause has defined source', () => {
    (parser.isSourced as jest.MockedFunction<typeof parser.isSourced>).mockReturnValue(true);

    const step = { forClause: { source: 'items' } };
    expect(() => validateSources([step as any], { items: ['a', 'b'] })).not.toThrow();
  });

  it('throws when sourced FOR clause references undefined source', () => {
    (parser.isSourced as jest.MockedFunction<typeof parser.isSourced>).mockReturnValue(true);

    const step = { forClause: { source: 'missing' } };
    expect(() => validateSources([step as any], {})).toThrow(
      'FOR loop references undefined data source "{{missing}}"',
    );
  });

  it('skips non-sourced FOR clauses', () => {
    (parser.isSourced as jest.MockedFunction<typeof parser.isSourced>).mockReturnValue(false);

    const step = { forClause: { variable: 'i', start: 1, end: 5 } };
    expect(() => validateSources([step as any], {})).not.toThrow();
  });
});

describe('prepareRunbook', () => {
  it('returns error when file not found', async () => {
    resolveRunbookFile.mockResolvedValue(null);

    const result = await prepareRunbook('missing.md', {}, '/test');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('RUNBOOK_NOT_FOUND');
    }
  });

  it('returns error when runbook has no steps', async () => {
    resolveRunbookFile.mockResolvedValue('/test/empty.md');
    (
      core.parseRunbookDocument as jest.MockedFunction<typeof core.parseRunbookDocument>
    ).mockReturnValue({ steps: [] } as any);

    const result = await prepareRunbook('empty.md', {}, '/test');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('VALIDATION_ERROR');
      expect(result.error).toContain('no steps');
    }
  });

  it('returns prepared runbook on success', async () => {
    resolveRunbookFile.mockResolvedValue('/test/good.md');
    (
      core.parseRunbookDocument as jest.MockedFunction<typeof core.parseRunbookDocument>
    ).mockReturnValue({ steps: [makeStep()] } as any);

    const result = await prepareRunbook('good.md', {}, '/test');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prepared.filePath).toBe('/test/good.md');
      expect(result.prepared.runbook.steps).toHaveLength(1);
    }
  });
});

describe('queueStep', () => {
  it('returns error when no active runbook', async () => {
    const ctx = {
      output: {} as any,
      manager: {} as any,
      actorService: {} as any,
      sessionService: { getActive: jest.fn<any>().mockResolvedValue(null) },
      lifecycleService: { pushPendingStep: jest.fn() },
      cwd: '/test',
    };

    const result = await queueStep(ctx as any, '2');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NO_ACTIVE_RUNBOOK');
    }
  });

  it('returns error for invalid step format', async () => {
    (
      core.parseStepIdFromString as jest.MockedFunction<typeof core.parseStepIdFromString>
    ).mockReturnValue(null);

    const ctx = {
      output: {} as any,
      manager: {} as any,
      actorService: {} as any,
      sessionService: { getActive: jest.fn<any>().mockResolvedValue({ id: 'test-id' }) },
      lifecycleService: { pushPendingStep: jest.fn() },
      cwd: '/test',
    };

    const result = await queueStep(ctx as any, 'abc');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_SYNTAX');
    }
  });

  it('queues step successfully', async () => {
    (
      core.parseStepIdFromString as jest.MockedFunction<typeof core.parseStepIdFromString>
    ).mockReturnValue({ step: '2' });
    (core.stepIdToString as jest.MockedFunction<typeof core.stepIdToString>).mockReturnValue('2');

    const mockPush = jest.fn<any>().mockResolvedValue(undefined);
    const ctx = {
      output: {} as any,
      manager: {} as any,
      actorService: {} as any,
      sessionService: { getActive: jest.fn<any>().mockResolvedValue({ id: 'test-id' }) },
      lifecycleService: { pushPendingStep: mockPush },
      cwd: '/test',
    };

    const result = await queueStep(ctx as any, '2', 'child.md');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stepId).toBe('2');
      expect(result.runbook).toBe('child.md');
    }
    expect(mockPush).toHaveBeenCalledWith('test-id', {
      stepId: { step: '2' },
      runbook: 'child.md',
    });
  });
});

describe('startRunbook', () => {
  it('creates state and runs execution loop', async () => {
    const mockCreate = jest.fn<any>().mockResolvedValue({
      id: 'new-id',
      title: 'Test',
      substeps: undefined,
    });
    const mockUpdate = jest.fn<any>().mockResolvedValue(undefined);
    const mockInitState = jest.fn<any>().mockResolvedValue(undefined);
    const mockPushRunbook = jest.fn<any>().mockResolvedValue(undefined);
    const mockOutput = { flush: jest.fn() };

    runExecutionLoop.mockResolvedValue('done');

    const ctx = {
      output: mockOutput as any,
      manager: {
        create: mockCreate,
        update: mockUpdate,
        initializeSubsteps: jest.fn<any>().mockResolvedValue(undefined),
      } as any,
      actorService: { initializeState: mockInitState } as any,
      sessionService: { pushRunbook: mockPushRunbook } as any,
      lifecycleService: {} as any,
      cwd: '/test',
    };

    const prepared = {
      filePath: '/test/runbook.md',
      rawContent: '# Test',
      runbook: { steps: [makeStep()] } as any,
      mergedVariables: {},
      sources: {},
    };

    const result = await startRunbook(ctx as any, prepared, { file: 'runbook.md' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.loopResult).toBe('done');
    }
    expect(mockCreate).toHaveBeenCalledWith(
      'runbook.md',
      prepared.runbook,
      expect.objectContaining({
        runbookPath: 'runbook.md',
        runbookSrc: '# Test',
      }),
    );
    expect(mockInitState).toHaveBeenCalled();
    expect(mockPushRunbook).toHaveBeenCalled();
  });
});

describe('bindAgent', () => {
  it('returns error when no active runbook', async () => {
    const ctx = {
      output: { status: jest.fn(), flush: jest.fn() } as any,
      manager: {} as any,
      actorService: {} as any,
      sessionService: { getActive: jest.fn<any>().mockResolvedValue(null) },
      lifecycleService: { popPendingStep: jest.fn() },
      cwd: '/test',
    };

    const result = await bindAgent(ctx as any, 'agent-1', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NO_ACTIVE_RUNBOOK');
    }
  });

  it('returns error when no pending step', async () => {
    const ctx = {
      output: { status: jest.fn(), flush: jest.fn() } as any,
      manager: {} as any,
      actorService: {} as any,
      sessionService: { getActive: jest.fn<any>().mockResolvedValue({ id: 'test-id' }) },
      lifecycleService: { popPendingStep: jest.fn<any>().mockResolvedValue(null) },
      cwd: '/test',
    };

    const result = await bindAgent(ctx as any, 'agent-1', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('AGENT_BINDING_ERROR');
    }
  });

  it('binds agent without child runbook', async () => {
    (core.stepIdToString as jest.MockedFunction<typeof core.stepIdToString>).mockReturnValue('2');

    const mockBindAgent = jest.fn<any>().mockResolvedValue(undefined);
    const ctx = {
      output: { status: jest.fn(), flush: jest.fn() } as any,
      manager: { bindAgent: mockBindAgent } as any,
      actorService: {} as any,
      sessionService: {
        getActive: jest.fn<any>().mockResolvedValue({ id: 'test-id' }),
      },
      lifecycleService: {
        popPendingStep: jest.fn<any>().mockResolvedValue({ stepId: { step: '2' } }),
      },
      cwd: '/test',
    };

    const result = await bindAgent(ctx as any, 'agent-1', {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.loopResult).toBeUndefined(); // No child runbook, no loop
    }
    expect(mockBindAgent).toHaveBeenCalledWith('test-id', 'agent-1', { step: '2' });
  });
});
