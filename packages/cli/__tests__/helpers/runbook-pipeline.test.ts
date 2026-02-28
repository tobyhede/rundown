import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock @rundown-org/core
jest.unstable_mockModule('@rundown-org/core', () => ({
  parseRunbookDocument: jest.fn(),
  stepIdToString: jest.fn((id: { step: string; substep?: string }) =>
    id.substep ? `${id.step}.${id.substep}` : id.step,
  ),
  deriveExecutionAt: jest.fn(
    (step: string, substep?: string, iteration?: number) =>
      `${step}${iteration != null ? `.${String(iteration)}` : ''}${substep ? `.${substep}` : ''}`,
  ),
  deriveActiveFrame: jest
    .fn()
    .mockReturnValue({ step: '1', substep: undefined, iteration: undefined, frameKey: '1' }),
  getActiveForContext: jest.fn().mockReturnValue(null),
  parseStepIdFromString: jest.fn(),
  STATE_DIR: '.claude/rundown/runs',
  DELEGATION_TOKEN_PREFIX: 'rdtk_',
  RunbookStateManager: jest.fn(),
  DelegationScanService: jest.fn(),
  DelegationLock: jest.fn(),
  reconstituteContextVars: jest.fn().mockReturnValue({}),
  hashDelegationToken: jest.fn().mockReturnValue('sha256:mock'),
  truncateDelegationToken: jest.fn((token: string) => `${token.slice(0, 12)}...`),
  ErrorCodes: {
    INVALID_TOKEN: { code: 'RD-807' },
    TOKEN_NOT_FOUND: { code: 'RD-808' },
    TOKEN_CANCELLED: { code: 'RD-809' },
    DELEGATION_LOCK_TIMEOUT: { code: 'RD-810' },
  },
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
  buildStepVariables: jest.fn().mockReturnValue({ Step: '1.1' }),
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
  expandLoopVariables: jest.fn((text: string) => text),
}));

// Mock node:fs/promises
jest.unstable_mockModule('node:fs/promises', () => ({
  readFile: jest.fn().mockResolvedValue('# Test\n\n## 1. Step\n- PASS: CONTINUE'),
}));

// Import after mocking
const core = await import('@rundown-org/core');
const parser = await import('@rundown-org/parser');
const { resolveRunbookFile } = await import('../../src/helpers/resolve-runbook');
const { runExecutionLoop, buildStepVariables } = await import('../../src/services/execution');
const { createBridgedEmitter } = await import('../../src/helpers/execution-emitter');
const { extractVarsFromMarkdown, resolveVariables } = await import(
  '../../src/services/variable-discovery'
);
const { substituteRunbookVariables, expandForClauseVariables, expandLoopVariables } = await import(
  '../../src/services/template-renderer'
);
const fsPromises = await import('node:fs/promises');
const { validateSources, prepareRunbook, queueStep, startRunbook, bindAgent } = await import(
  '../../src/helpers/runbook-pipeline'
);

function makeState(id: string, overrides: Record<string, unknown> = {}): any {
  return {
    id,
    runbook: 'test.md',
    runbookPath: '/tmp/test.md',
    runbookSrc: '## 1. Step\n- PASS: COMPLETE',
    step: '1',
    stepName: 'Step',
    retryCount: 0,
    variables: {},
    steps: [{ id: '1', status: 'running' }],
    pendingSteps: [],
    agentBindings: {},
    startedAt: '2026-02-27T10:00:00.000Z',
    updatedAt: '2026-02-27T10:00:00.000Z',
    ...overrides,
  };
}

function makeStep(overrides: Record<string, unknown> = {}): any {
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

function makeLifecycle(overrides: Record<string, unknown> = {}): any {
  return {
    ensureActiveEntry: jest
      .fn<any>()
      .mockImplementation(async (_id: string, _prev: unknown, state: any) => ({
        state: {
          ...(state ?? {}),
          activeEntry: state?.activeEntry ?? 1,
          activeFrameKey: state?.activeFrameKey ?? `${String(state?.step ?? '1')}|`,
        },
        frameKey: state?.activeFrameKey ?? `${String(state?.step ?? '1')}|`,
        entry: state?.activeEntry ?? 1,
      })),
    buildTargetFrameKey: jest
      .fn<any>()
      .mockImplementation(
        (step: string, iteration?: number) =>
          `${step}|${iteration != null ? String(iteration) : ''}`,
      ),
    ...overrides,
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  // Re-establish default mock implementations after reset
  (runExecutionLoop as jest.Mock).mockResolvedValue('done');
  (core.deriveExecutionAt as jest.Mock).mockImplementation(
    (step: string, substep?: string, iteration?: number) =>
      `${step}${iteration != null ? `.${String(iteration)}` : ''}${substep ? `.${substep}` : ''}`,
  );
  (core.getActiveForContext as jest.Mock).mockReturnValue(null);
  (createBridgedEmitter as jest.Mock).mockReturnValue({ emit: jest.fn() });
  (extractVarsFromMarkdown as jest.Mock).mockReturnValue({});
  (resolveVariables as jest.Mock).mockResolvedValue({ vars: {}, sources: {} });
  (buildStepVariables as jest.Mock).mockReturnValue({ Step: '1.1' });
  (substituteRunbookVariables as jest.Mock).mockImplementation((runbook: unknown) => runbook);
  (expandForClauseVariables as jest.Mock).mockImplementation((content: string) => content);
  (expandLoopVariables as jest.Mock).mockImplementation((text: string) => text);
  (fsPromises.readFile as jest.Mock).mockResolvedValue('# Test\n\n## 1. Step\n- PASS: CONTINUE');
  (core.hashDelegationToken as jest.Mock).mockReturnValue('sha256:mock');
  (core.reconstituteContextVars as jest.Mock).mockReturnValue({});
  (core.deriveActiveFrame as jest.Mock).mockReturnValue({
    step: '1',
    substep: undefined,
    iteration: undefined,
    frameKey: '1',
  });
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

  it('adds context.vars aliases to merged template variables', async () => {
    resolveRunbookFile.mockResolvedValue('/test/good.md');
    (
      core.parseRunbookDocument as jest.MockedFunction<typeof core.parseRunbookDocument>
    ).mockReturnValue({ steps: [makeStep()] } as any);
    (resolveVariables as jest.Mock).mockResolvedValue({
      vars: { region: 'us-west' },
      sources: {},
    });

    const result = await prepareRunbook('good.md', {}, '/test');

    expect(result.ok).toBe(true);
    expect(substituteRunbookVariables).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        region: 'us-west',
        'context.vars.region': 'us-west',
      }),
    );
  });

  it('returns error when validateSources throws', async () => {
    resolveRunbookFile.mockResolvedValue('/test/sourced.md');
    (parser.isSourced as jest.MockedFunction<typeof parser.isSourced>).mockReturnValue(true);
    (
      core.parseRunbookDocument as jest.MockedFunction<typeof core.parseRunbookDocument>
    ).mockReturnValue({
      steps: [makeStep({ forClause: { source: 'missing' } })],
    } as any);

    const result = await prepareRunbook('sourced.md', {}, '/test');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('VALIDATION_ERROR');
      expect(result.error).toContain('missing');
    }
  });
});

describe('queueStep', () => {
  it('requires explicit substep id when active step has substeps', async () => {
    (
      core.parseStepIdFromString as jest.MockedFunction<typeof core.parseStepIdFromString>
    ).mockReturnValue({ step: '2' });

    (
      core.parseRunbookDocument as jest.MockedFunction<typeof core.parseRunbookDocument>
    ).mockReturnValue({
      steps: [
        {
          name: '2',
          substeps: [
            { id: '1', description: 'A' },
            { id: '2', description: 'B' },
          ],
        },
      ],
    } as any);

    const ctx = {
      output: {} as any,
      manager: {} as any,
      actorService: {} as any,
      sessionService: {
        getActive: jest.fn<any>().mockResolvedValue({
          id: 'test-id',
          step: '2',
          runbook: 'test.runbook.md',
          runbookSrc: '## 2',
          templateVars: {},
          sources: {},
        }),
      },
      lifecycleService: makeLifecycle({ pushPendingStep: jest.fn() }),
      cwd: '/test',
    };

    const result = await queueStep(ctx as any, '2');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('VALIDATION_ERROR');
      expect(result.error).toContain('requires an explicit substep identifier');
    }
  });

  it('allows step-level dispatch when state.substep is already set', async () => {
    (
      core.parseStepIdFromString as jest.MockedFunction<typeof core.parseStepIdFromString>
    ).mockReturnValue({ step: '2' });
    (core.stepIdToString as jest.MockedFunction<typeof core.stepIdToString>).mockReturnValue('2.1');

    (
      core.parseRunbookDocument as jest.MockedFunction<typeof core.parseRunbookDocument>
    ).mockReturnValue({
      steps: [
        {
          name: '2',
          substeps: [
            { id: '1', description: 'A' },
            { id: '2', description: 'B' },
          ],
        },
      ],
    } as any);

    const mockPush = jest.fn<any>().mockResolvedValue(undefined);
    const ctx = {
      output: {} as any,
      manager: {} as any,
      actorService: {} as any,
      sessionService: {
        getActive: jest.fn<any>().mockResolvedValue({
          id: 'test-id',
          step: '2',
          substep: '1',
          runbook: 'test.runbook.md',
          runbookSrc: '## 2',
          templateVars: {},
          sources: {},
        }),
      },
      lifecycleService: makeLifecycle({ pushPendingStep: mockPush }),
      cwd: '/test',
    };

    const result = await queueStep(ctx as any, '2');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stepId).toBe('2.1');
    }
    expect(mockPush).toHaveBeenCalledWith(
      'test-id',
      expect.objectContaining({ targetSubstep: '1' }),
    );
  });

  it('infers child runbook when substep has exactly one runbook reference and file is omitted', async () => {
    (
      core.parseStepIdFromString as jest.MockedFunction<typeof core.parseStepIdFromString>
    ).mockReturnValue({ step: '2', substep: '1' });
    (core.stepIdToString as jest.MockedFunction<typeof core.stepIdToString>).mockReturnValue('2.1');
    (
      core.parseRunbookDocument as jest.MockedFunction<typeof core.parseRunbookDocument>
    ).mockReturnValue({
      steps: [
        {
          name: '2',
          substeps: [{ id: '1', description: 'A', runbooks: ['child-{{Index}}.runbook.md'] }],
        },
      ],
    } as any);
    (buildStepVariables as jest.Mock).mockReturnValue({ Step: '2.1', Index: '4' });
    (expandLoopVariables as jest.Mock).mockImplementation((text: string) =>
      text.replace('{{Index}}', '4'),
    );

    const mockPush = jest.fn<any>().mockResolvedValue(undefined);
    const ctx = {
      output: {} as any,
      manager: {} as any,
      actorService: {} as any,
      sessionService: {
        getActive: jest.fn<any>().mockResolvedValue({
          id: 'test-id',
          step: '2',
          substep: '1',
          runbook: 'test.runbook.md',
          runbookSrc: '## 2',
          templateVars: {},
          sources: {},
        }),
      },
      lifecycleService: makeLifecycle({ pushPendingStep: mockPush }),
      cwd: '/test',
    };

    const result = await queueStep(ctx as any, '2.1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.runbook).toBe('child-4.runbook.md');
    }
    expect(mockPush).toHaveBeenCalledWith(
      'test-id',
      expect.objectContaining({ runbook: 'child-4.runbook.md' }),
    );
  });

  it('returns ambiguity error when substep has multiple runbooks and file is omitted', async () => {
    (
      core.parseStepIdFromString as jest.MockedFunction<typeof core.parseStepIdFromString>
    ).mockReturnValue({ step: '2', substep: '1' });
    (
      core.parseRunbookDocument as jest.MockedFunction<typeof core.parseRunbookDocument>
    ).mockReturnValue({
      steps: [
        {
          name: '2',
          substeps: [{ id: '1', description: 'A', runbooks: ['a.runbook.md', 'b.runbook.md'] }],
        },
      ],
    } as any);

    const ctx = {
      output: {} as any,
      manager: {} as any,
      actorService: {} as any,
      sessionService: {
        getActive: jest.fn<any>().mockResolvedValue({
          id: 'test-id',
          step: '2',
          substep: '1',
          runbook: 'test.runbook.md',
          runbookSrc: '## 2',
          templateVars: {},
          sources: {},
        }),
      },
      lifecycleService: makeLifecycle({ pushPendingStep: jest.fn() }),
      cwd: '/test',
    };

    const result = await queueStep(ctx as any, '2.1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('VALIDATION_ERROR');
      expect(result.error).toContain('multiple child runbooks');
    }
  });

  it('returns error when no active runbook', async () => {
    const ctx = {
      output: {} as any,
      manager: {} as any,
      actorService: {} as any,
      sessionService: { getActive: jest.fn<any>().mockResolvedValue(null) },
      lifecycleService: makeLifecycle({ pushPendingStep: jest.fn() }),
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
      sessionService: {
        getActive: jest
          .fn<any>()
          .mockResolvedValue({ id: 'test-id', step: '1', substep: undefined }),
      },
      lifecycleService: makeLifecycle({ pushPendingStep: jest.fn() }),
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
      sessionService: {
        getActive: jest
          .fn<any>()
          .mockResolvedValue({ id: 'test-id', step: '2', substep: undefined }),
      },
      lifecycleService: makeLifecycle({ pushPendingStep: mockPush }),
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
      targetStep: '2',
      targetFrameKey: '2|',
      targetEntry: 1,
    });
    if (result.ok) {
      expect(result.targetAt).toBe('2');
    }
  });

  it('rejects queueing a future step outside the active frontier', async () => {
    (
      core.parseStepIdFromString as jest.MockedFunction<typeof core.parseStepIdFromString>
    ).mockReturnValue({ step: '2' });
    (core.stepIdToString as jest.MockedFunction<typeof core.stepIdToString>).mockReturnValue('2');

    const ctx = {
      output: {} as any,
      manager: {} as any,
      actorService: {} as any,
      sessionService: {
        getActive: jest
          .fn<any>()
          .mockResolvedValue({ id: 'test-id', step: '1', substep: undefined }),
      },
      lifecycleService: makeLifecycle({ pushPendingStep: jest.fn() }),
      cwd: '/test',
    };

    const result = await queueStep(ctx as any, '2');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('VALIDATION_ERROR');
    }
    expect(ctx.lifecycleService.pushPendingStep).not.toHaveBeenCalled();
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
      lifecycleService: makeLifecycle(),
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
  it('initializes substeps when first step has substeps', async () => {
    const mockInitSubsteps = jest.fn<any>().mockResolvedValue(undefined);
    const mockUpdate = jest.fn<any>().mockResolvedValue(undefined);
    const mockCreate = jest.fn<any>().mockResolvedValue({
      id: 'sub-id',
      title: 'Sub Test',
    });

    runExecutionLoop.mockResolvedValue('done');

    const ctx = {
      output: { flush: jest.fn() } as any,
      manager: {
        create: mockCreate,
        update: mockUpdate,
        initializeSubsteps: mockInitSubsteps,
      } as any,
      actorService: { initializeState: jest.fn<any>().mockResolvedValue(undefined) } as any,
      sessionService: { pushRunbook: jest.fn<any>().mockResolvedValue(undefined) } as any,
      lifecycleService: makeLifecycle(),
      cwd: '/test',
    };

    const substeps = [{ id: 'a' }, { id: 'b' }];
    const prepared = {
      filePath: '/test/runbook.md',
      rawContent: '# Test',
      runbook: { steps: [makeStep({ substeps })] } as any,
      mergedVariables: {},
      sources: {},
    };

    const result = await startRunbook(ctx as any, prepared, { file: 'runbook.md' });

    expect(result.ok).toBe(true);
    expect(mockInitSubsteps).toHaveBeenCalledWith('sub-id', substeps);
    expect(mockUpdate).toHaveBeenCalledWith('sub-id', { substep: 'a' });
  });
});

describe('bindAgent', () => {
  it('returns error when no active runbook', async () => {
    const ctx = {
      output: { status: jest.fn(), flush: jest.fn() } as any,
      manager: {} as any,
      actorService: {} as any,
      sessionService: { getActive: jest.fn<any>().mockResolvedValue(null) },
      lifecycleService: makeLifecycle({ popPendingStep: jest.fn() }),
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
      lifecycleService: makeLifecycle({ popPendingStep: jest.fn<any>().mockResolvedValue(null) }),
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
      lifecycleService: makeLifecycle({
        popPendingStep: jest.fn<any>().mockResolvedValue({
          stepId: { step: '2' },
          targetStep: '2',
          targetFrameKey: '2|',
          targetEntry: 1,
        }),
      }),
      cwd: '/test',
    };

    const result = await bindAgent(ctx as any, 'agent-1', {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.loopResult).toBeUndefined(); // No child runbook, no loop
    }
    expect(mockBindAgent).toHaveBeenCalledWith('test-id', 'agent-1', {
      stepId: { step: '2' },
      targetStep: '2',
      targetFrameKey: '2|',
      targetEntry: 1,
    });
  });

  it('starts child runbook when pending step has runbook', async () => {
    (core.stepIdToString as jest.MockedFunction<typeof core.stepIdToString>).mockReturnValue('2');
    resolveRunbookFile.mockResolvedValue('/test/child.runbook.md');
    (
      core.parseRunbookDocument as jest.MockedFunction<typeof core.parseRunbookDocument>
    ).mockReturnValue({ steps: [makeStep()] } as any);
    runExecutionLoop.mockResolvedValue('done');

    const mockBindAgentFn = jest.fn<any>().mockResolvedValue(undefined);
    const mockCreate = jest.fn<any>().mockResolvedValue({
      id: 'child-id',
      title: 'Child',
    });
    const mockUpdateAgentBinding = jest.fn<any>().mockResolvedValue(undefined);

    const ctx = {
      output: { status: jest.fn(), flush: jest.fn() } as any,
      manager: {
        bindAgent: mockBindAgentFn,
        create: mockCreate,
        update: jest.fn<any>().mockResolvedValue(undefined),
        updateAgentBinding: mockUpdateAgentBinding,
        initializeSubsteps: jest.fn<any>().mockResolvedValue(undefined),
      } as any,
      actorService: { initializeState: jest.fn<any>().mockResolvedValue(undefined) } as any,
      sessionService: {
        getActive: jest
          .fn<any>()
          .mockResolvedValue({ id: 'parent-id', step: '2', substep: '1', prompted: true }),
        pushRunbook: jest.fn<any>().mockResolvedValue(undefined),
      },
      lifecycleService: makeLifecycle({
        popPendingStep: jest.fn<any>().mockResolvedValue({
          stepId: { step: '2' },
          targetStep: '2',
          targetFrameKey: '2|',
          targetEntry: 1,
          runbook: 'child.runbook.md',
        }),
      }),
      cwd: '/test',
    };

    const result = await bindAgent(ctx as any, 'agent-1', {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.loopResult).toBe('done');
    }
    expect(mockCreate).toHaveBeenCalledWith(
      'child.runbook.md',
      expect.anything(),
      expect.objectContaining({
        agentId: 'agent-1',
        parentRunbookId: 'parent-id',
        prompted: true,
      }),
    );
    expect(mockUpdateAgentBinding).toHaveBeenCalledWith('parent-id', 'agent-1', {
      childRunbookId: 'child-id',
    });
    expect(substituteRunbookVariables).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        'context.parent.step': '2',
        'context.parent.substep': '1',
        'context.parent.at': '2.1',
        'context.ancestors.0.step': '2',
      }),
    );
  });

  it('includes multi-level inherited context for child runbook launches', async () => {
    (core.stepIdToString as jest.MockedFunction<typeof core.stepIdToString>).mockReturnValue('2');
    resolveRunbookFile.mockResolvedValue('/test/child.runbook.md');
    (
      core.parseRunbookDocument as jest.MockedFunction<typeof core.parseRunbookDocument>
    ).mockReturnValue({ steps: [makeStep()] } as any);
    runExecutionLoop.mockResolvedValue('done');

    const managerLoad = jest.fn<any>().mockImplementation(async (id: string) => {
      if (id === 'grand-id') {
        return { id: 'grand-id', step: '1', substep: '3' };
      }
      return null;
    });

    const ctx = {
      output: { status: jest.fn(), flush: jest.fn() } as any,
      manager: {
        bindAgent: jest.fn<any>().mockResolvedValue(undefined),
        create: jest.fn<any>().mockResolvedValue({ id: 'child-id', title: 'Child' }),
        update: jest.fn<any>().mockResolvedValue(undefined),
        updateAgentBinding: jest.fn<any>().mockResolvedValue(undefined),
        initializeSubsteps: jest.fn<any>().mockResolvedValue(undefined),
        load: managerLoad,
      } as any,
      actorService: { initializeState: jest.fn<any>().mockResolvedValue(undefined) } as any,
      sessionService: {
        getActive: jest.fn<any>().mockResolvedValue({
          id: 'parent-id',
          step: '2',
          substep: '1',
          parentRunbookId: 'grand-id',
          prompted: true,
        }),
        pushRunbook: jest.fn<any>().mockResolvedValue(undefined),
      },
      lifecycleService: makeLifecycle({
        popPendingStep: jest.fn<any>().mockResolvedValue({
          stepId: { step: '2' },
          targetStep: '2',
          targetFrameKey: '2|',
          targetEntry: 1,
          runbook: 'child.runbook.md',
        }),
      }),
      cwd: '/test',
    };

    const result = await bindAgent(ctx as any, 'agent-1', {});

    expect(result.ok).toBe(true);
    expect(substituteRunbookVariables).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        'context.parent.step': '2',
        'context.parent.parent.step': '1',
        'context.ancestors.0.step': '2',
        'context.ancestors.1.step': '1',
      }),
    );
    expect(managerLoad).toHaveBeenCalledWith('grand-id');
  });

  it('propagates parent template vars via context.parent.vars.*', async () => {
    (core.stepIdToString as jest.MockedFunction<typeof core.stepIdToString>).mockReturnValue('2');
    resolveRunbookFile.mockResolvedValue('/test/child.runbook.md');
    (
      core.parseRunbookDocument as jest.MockedFunction<typeof core.parseRunbookDocument>
    ).mockReturnValue({ steps: [makeStep()] } as any);
    runExecutionLoop.mockResolvedValue('done');

    const ctx = {
      output: { status: jest.fn(), flush: jest.fn() } as any,
      manager: {
        bindAgent: jest.fn<any>().mockResolvedValue(undefined),
        create: jest.fn<any>().mockResolvedValue({ id: 'child-id', title: 'Child' }),
        update: jest.fn<any>().mockResolvedValue(undefined),
        updateAgentBinding: jest.fn<any>().mockResolvedValue(undefined),
        initializeSubsteps: jest.fn<any>().mockResolvedValue(undefined),
      } as any,
      actorService: { initializeState: jest.fn<any>().mockResolvedValue(undefined) } as any,
      sessionService: {
        getActive: jest.fn<any>().mockResolvedValue({
          id: 'parent-id',
          step: '2',
          substep: '1',
          prompted: true,
          templateVars: {
            PlanPath: '.work/plan.md',
            Date: '2026-02-04',
            'context.vars.PlanPath': '.work/plan.md',
          },
        }),
        pushRunbook: jest.fn<any>().mockResolvedValue(undefined),
      },
      lifecycleService: makeLifecycle({
        popPendingStep: jest.fn<any>().mockResolvedValue({
          stepId: { step: '2' },
          targetStep: '2',
          targetFrameKey: '2|',
          targetEntry: 1,
          runbook: 'child.runbook.md',
        }),
      }),
      cwd: '/test',
    };

    const result = await bindAgent(ctx as any, 'agent-1', {});

    expect(result.ok).toBe(true);
    const varsArg = (substituteRunbookVariables as jest.Mock).mock.calls[0][1] as Record<
      string,
      string
    >;
    // User vars propagated
    expect(varsArg['context.parent.vars.PlanPath']).toBe('.work/plan.md');
    expect(varsArg['context.parent.vars.Date']).toBe('2026-02-04');
    expect(varsArg['context.ancestors.0.vars.PlanPath']).toBe('.work/plan.md');
    // context.* prefixed keys are excluded (no recursive nesting)
    expect(varsArg['context.parent.vars.context.vars.PlanPath']).toBeUndefined();
  });

  it('propagates multi-level ancestry vars via chain and array addressing', async () => {
    (core.stepIdToString as jest.MockedFunction<typeof core.stepIdToString>).mockReturnValue('2');
    resolveRunbookFile.mockResolvedValue('/test/child.runbook.md');
    (
      core.parseRunbookDocument as jest.MockedFunction<typeof core.parseRunbookDocument>
    ).mockReturnValue({ steps: [makeStep()] } as any);
    runExecutionLoop.mockResolvedValue('done');

    const managerLoad = jest.fn<any>().mockImplementation(async (id: string) => {
      if (id === 'grand-id') {
        return {
          id: 'grand-id',
          step: '1',
          substep: '3',
          templateVars: { region: 'us-west', 'context.vars.region': 'us-west' },
        };
      }
      return null;
    });

    const ctx = {
      output: { status: jest.fn(), flush: jest.fn() } as any,
      manager: {
        bindAgent: jest.fn<any>().mockResolvedValue(undefined),
        create: jest.fn<any>().mockResolvedValue({ id: 'child-id', title: 'Child' }),
        update: jest.fn<any>().mockResolvedValue(undefined),
        updateAgentBinding: jest.fn<any>().mockResolvedValue(undefined),
        initializeSubsteps: jest.fn<any>().mockResolvedValue(undefined),
        load: managerLoad,
      } as any,
      actorService: { initializeState: jest.fn<any>().mockResolvedValue(undefined) } as any,
      sessionService: {
        getActive: jest.fn<any>().mockResolvedValue({
          id: 'parent-id',
          step: '2',
          substep: '1',
          parentRunbookId: 'grand-id',
          prompted: true,
          templateVars: { PlanPath: '.work/plan.md' },
        }),
        pushRunbook: jest.fn<any>().mockResolvedValue(undefined),
      },
      lifecycleService: makeLifecycle({
        popPendingStep: jest.fn<any>().mockResolvedValue({
          stepId: { step: '2' },
          targetStep: '2',
          targetFrameKey: '2|',
          targetEntry: 1,
          runbook: 'child.runbook.md',
        }),
      }),
      cwd: '/test',
    };

    const result = await bindAgent(ctx as any, 'agent-1', {});

    expect(result.ok).toBe(true);
    const varsArg = (substituteRunbookVariables as jest.Mock).mock.calls[0][1] as Record<
      string,
      string
    >;
    // Chain form
    expect(varsArg['context.parent.vars.PlanPath']).toBe('.work/plan.md');
    expect(varsArg['context.parent.parent.vars.region']).toBe('us-west');
    // Array form
    expect(varsArg['context.ancestors.0.vars.PlanPath']).toBe('.work/plan.md');
    expect(varsArg['context.ancestors.1.vars.region']).toBe('us-west');
    // context.* keys excluded from grandparent too
    expect(varsArg['context.parent.parent.vars.context.vars.region']).toBeUndefined();
  });

  it('propagates three-level deep ancestry vars via chain and array addressing', async () => {
    (core.stepIdToString as jest.MockedFunction<typeof core.stepIdToString>).mockReturnValue('2');
    resolveRunbookFile.mockResolvedValue('/test/child.runbook.md');
    (
      core.parseRunbookDocument as jest.MockedFunction<typeof core.parseRunbookDocument>
    ).mockReturnValue({ steps: [makeStep()] } as any);
    runExecutionLoop.mockResolvedValue('done');

    const managerLoad = jest.fn<any>().mockImplementation(async (id: string) => {
      if (id === 'grand-id') {
        return {
          id: 'grand-id',
          step: '1',
          substep: '3',
          parentRunbookId: 'great-id',
          templateVars: { PlanPath: '.work/plan.md' },
        };
      }
      if (id === 'great-id') {
        return {
          id: 'great-id',
          step: '5',
          substep: '1',
          templateVars: { region: 'us-west', tier: 'premium' },
        };
      }
      return null;
    });

    const ctx = {
      output: { status: jest.fn(), flush: jest.fn() } as any,
      manager: {
        bindAgent: jest.fn<any>().mockResolvedValue(undefined),
        create: jest.fn<any>().mockResolvedValue({ id: 'child-id', title: 'Child' }),
        update: jest.fn<any>().mockResolvedValue(undefined),
        updateAgentBinding: jest.fn<any>().mockResolvedValue(undefined),
        initializeSubsteps: jest.fn<any>().mockResolvedValue(undefined),
        load: managerLoad,
      } as any,
      actorService: { initializeState: jest.fn<any>().mockResolvedValue(undefined) } as any,
      sessionService: {
        getActive: jest.fn<any>().mockResolvedValue({
          id: 'parent-id',
          step: '2',
          substep: '1',
          parentRunbookId: 'grand-id',
          prompted: true,
          templateVars: { env: 'staging' },
        }),
        pushRunbook: jest.fn<any>().mockResolvedValue(undefined),
      },
      lifecycleService: makeLifecycle({
        popPendingStep: jest.fn<any>().mockResolvedValue({
          stepId: { step: '2' },
          targetStep: '2',
          targetFrameKey: '2|',
          targetEntry: 1,
          runbook: 'child.runbook.md',
        }),
      }),
      cwd: '/test',
    };

    const result = await bindAgent(ctx as any, 'agent-1', {});

    expect(result.ok).toBe(true);
    const varsArg = (substituteRunbookVariables as jest.Mock).mock.calls[0][1] as Record<
      string,
      string
    >;
    // ancestors.0 = parent
    expect(varsArg['context.ancestors.0.vars.env']).toBe('staging');
    // ancestors.1 = grandparent
    expect(varsArg['context.ancestors.1.vars.PlanPath']).toBe('.work/plan.md');
    // ancestors.2 = great-grandparent
    expect(varsArg['context.ancestors.2.vars.region']).toBe('us-west');
    expect(varsArg['context.ancestors.2.vars.tier']).toBe('premium');
    // Chain form
    expect(varsArg['context.parent.vars.env']).toBe('staging');
    expect(varsArg['context.parent.parent.vars.PlanPath']).toBe('.work/plan.md');
    expect(varsArg['context.parent.parent.parent.vars.region']).toBe('us-west');
    expect(varsArg['context.parent.parent.parent.vars.tier']).toBe('premium');
  });

  it('handles sparse templateVars in lineage (middle ancestor missing vars)', async () => {
    (core.stepIdToString as jest.MockedFunction<typeof core.stepIdToString>).mockReturnValue('2');
    resolveRunbookFile.mockResolvedValue('/test/child.runbook.md');
    (
      core.parseRunbookDocument as jest.MockedFunction<typeof core.parseRunbookDocument>
    ).mockReturnValue({ steps: [makeStep()] } as any);
    runExecutionLoop.mockResolvedValue('done');

    const managerLoad = jest.fn<any>().mockImplementation(async (id: string) => {
      if (id === 'grand-id') {
        return {
          id: 'grand-id',
          step: '3',
          substep: '2',
          parentRunbookId: 'great-id',
          // No templateVars — sparse gap
        };
      }
      if (id === 'great-id') {
        return {
          id: 'great-id',
          step: '1',
          substep: '1',
          templateVars: { region: 'eu-central' },
        };
      }
      return null;
    });

    const ctx = {
      output: { status: jest.fn(), flush: jest.fn() } as any,
      manager: {
        bindAgent: jest.fn<any>().mockResolvedValue(undefined),
        create: jest.fn<any>().mockResolvedValue({ id: 'child-id', title: 'Child' }),
        update: jest.fn<any>().mockResolvedValue(undefined),
        updateAgentBinding: jest.fn<any>().mockResolvedValue(undefined),
        initializeSubsteps: jest.fn<any>().mockResolvedValue(undefined),
        load: managerLoad,
      } as any,
      actorService: { initializeState: jest.fn<any>().mockResolvedValue(undefined) } as any,
      sessionService: {
        getActive: jest.fn<any>().mockResolvedValue({
          id: 'parent-id',
          step: '2',
          substep: '1',
          parentRunbookId: 'grand-id',
          prompted: true,
          templateVars: { PlanPath: '.work/plan.md' },
        }),
        pushRunbook: jest.fn<any>().mockResolvedValue(undefined),
      },
      lifecycleService: makeLifecycle({
        popPendingStep: jest.fn<any>().mockResolvedValue({
          stepId: { step: '2' },
          targetStep: '2',
          targetFrameKey: '2|',
          targetEntry: 1,
          runbook: 'child.runbook.md',
        }),
      }),
      cwd: '/test',
    };

    const result = await bindAgent(ctx as any, 'agent-1', {});

    expect(result.ok).toBe(true);
    const varsArg = (substituteRunbookVariables as jest.Mock).mock.calls[0][1] as Record<
      string,
      string
    >;
    // ancestors.0 = parent (has vars)
    expect(varsArg['context.ancestors.0.vars.PlanPath']).toBe('.work/plan.md');
    // ancestors.1 = grandparent (no vars — sparse)
    const grandparentVarsKeys = Object.keys(varsArg).filter((k) =>
      k.startsWith('context.ancestors.1.vars.'),
    );
    expect(grandparentVarsKeys).toHaveLength(0);
    // Structural context still works for the sparse middle ancestor
    expect(varsArg['context.ancestors.1.step']).toBe('3');
    expect(varsArg['context.ancestors.1.at']).toBe('3.2');
    // ancestors.2 = great-grandparent (has vars)
    expect(varsArg['context.ancestors.2.vars.region']).toBe('eu-central');
    // Chain form also works across the gap
    expect(varsArg['context.parent.parent.parent.vars.region']).toBe('eu-central');
  });

  it('handles parent state without templateVars gracefully', async () => {
    (core.stepIdToString as jest.MockedFunction<typeof core.stepIdToString>).mockReturnValue('2');
    resolveRunbookFile.mockResolvedValue('/test/child.runbook.md');
    (
      core.parseRunbookDocument as jest.MockedFunction<typeof core.parseRunbookDocument>
    ).mockReturnValue({ steps: [makeStep()] } as any);
    runExecutionLoop.mockResolvedValue('done');

    const ctx = {
      output: { status: jest.fn(), flush: jest.fn() } as any,
      manager: {
        bindAgent: jest.fn<any>().mockResolvedValue(undefined),
        create: jest.fn<any>().mockResolvedValue({ id: 'child-id', title: 'Child' }),
        update: jest.fn<any>().mockResolvedValue(undefined),
        updateAgentBinding: jest.fn<any>().mockResolvedValue(undefined),
        initializeSubsteps: jest.fn<any>().mockResolvedValue(undefined),
      } as any,
      actorService: { initializeState: jest.fn<any>().mockResolvedValue(undefined) } as any,
      sessionService: {
        getActive: jest.fn<any>().mockResolvedValue({
          id: 'parent-id',
          step: '2',
          substep: '1',
          prompted: true,
          // No templateVars field
        }),
        pushRunbook: jest.fn<any>().mockResolvedValue(undefined),
      },
      lifecycleService: makeLifecycle({
        popPendingStep: jest.fn<any>().mockResolvedValue({
          stepId: { step: '2' },
          targetStep: '2',
          targetFrameKey: '2|',
          targetEntry: 1,
          runbook: 'child.runbook.md',
        }),
      }),
      cwd: '/test',
    };

    const result = await bindAgent(ctx as any, 'agent-1', {});

    expect(result.ok).toBe(true);
    const varsArg = (substituteRunbookVariables as jest.Mock).mock.calls[0][1] as Record<
      string,
      string
    >;
    // Structural context still works
    expect(varsArg['context.parent.step']).toBe('2');
    expect(varsArg['context.parent.at']).toBe('2.1');
    // No vars.* keys present
    const parentVarsKeys = Object.keys(varsArg).filter((k) => k.startsWith('context.parent.vars.'));
    expect(parentVarsKeys).toHaveLength(0);
  });

  it('fails fast when inherited parent lineage contains a cycle', async () => {
    (core.stepIdToString as jest.MockedFunction<typeof core.stepIdToString>).mockReturnValue('2');

    const managerLoad = jest.fn<any>().mockImplementation(async (id: string) => {
      if (id === 'a') {
        return { id: 'a', step: '10', parentRunbookId: 'b' };
      }
      if (id === 'b') {
        return { id: 'b', step: '11', parentRunbookId: 'a' };
      }
      return null;
    });

    const ctx = {
      output: { status: jest.fn(), flush: jest.fn() } as any,
      manager: {
        bindAgent: jest.fn<any>().mockResolvedValue(undefined),
        load: managerLoad,
      } as any,
      actorService: {} as any,
      sessionService: {
        getActive: jest.fn<any>().mockResolvedValue({
          id: 'parent-id',
          step: '2',
          substep: '1',
          parentRunbookId: 'a',
          prompted: true,
        }),
      },
      lifecycleService: makeLifecycle({
        popPendingStep: jest.fn<any>().mockResolvedValue({
          stepId: { step: '2' },
          targetStep: '2',
          targetFrameKey: '2|',
          targetEntry: 1,
          runbook: 'child.runbook.md',
        }),
      }),
      cwd: '/test',
    };

    const result = await bindAgent(ctx as any, 'agent-1', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('STATE_CORRUPTION');
      expect(result.error).toContain('cycle');
    }
    expect(resolveRunbookFile).not.toHaveBeenCalled();
  });

  it('fails fast when inherited parent lineage exceeds max depth', async () => {
    (core.stepIdToString as jest.MockedFunction<typeof core.stepIdToString>).mockReturnValue('2');

    const chain = new Map<string, any>();
    for (let i = 1; i <= 40; i += 1) {
      chain.set(`n${String(i)}`, {
        id: `n${String(i)}`,
        step: String(i),
        parentRunbookId: i < 40 ? `n${String(i + 1)}` : undefined,
      });
    }
    const managerLoad = jest
      .fn<any>()
      .mockImplementation(async (id: string) => chain.get(id) ?? null);

    const ctx = {
      output: { status: jest.fn(), flush: jest.fn() } as any,
      manager: {
        bindAgent: jest.fn<any>().mockResolvedValue(undefined),
        load: managerLoad,
      } as any,
      actorService: {} as any,
      sessionService: {
        getActive: jest.fn<any>().mockResolvedValue({
          id: 'root',
          step: '2',
          substep: '1',
          parentRunbookId: 'n1',
          prompted: true,
        }),
      },
      lifecycleService: makeLifecycle({
        popPendingStep: jest.fn<any>().mockResolvedValue({
          stepId: { step: '2' },
          targetStep: '2',
          targetFrameKey: '2|',
          targetEntry: 1,
          runbook: 'child.runbook.md',
        }),
      }),
      cwd: '/test',
    };

    const result = await bindAgent(ctx as any, 'agent-1', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('STATE_CORRUPTION');
      expect(result.error).toContain('maximum depth');
    }
    expect(resolveRunbookFile).not.toHaveBeenCalled();
  });
});

describe('claimAndLaunch', () => {
  it('returns error when token format is invalid', async () => {
    const ctx = {
      output: {} as any,
      manager: {} as any,
      actorService: {} as any,
      sessionService: {} as any,
      lifecycleService: {} as any,
      cwd: '/test',
    };

    const { claimAndLaunch } = await import('../../src/helpers/runbook-pipeline');
    const result = await claimAndLaunch(ctx as any, 'bad-token', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('RD-807');
      expect(result.error).toContain('rdtk_');
    }
  });

  it('returns error when token not found', async () => {
    const mockScanner = {
      findByToken: jest.fn<any>().mockResolvedValue(null),
    };
    (core.DelegationScanService as jest.Mock).mockImplementation(() => mockScanner);

    const ctx = {
      output: {} as any,
      manager: {} as any,
      actorService: {} as any,
      sessionService: {} as any,
      lifecycleService: {} as any,
      cwd: '/test',
    };

    const { claimAndLaunch } = await import('../../src/helpers/runbook-pipeline');
    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx as any, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('RD-808');
    }
  });

  it('returns idempotent result when token already claimed', async () => {
    const delegation = {
      tokenHash: 'sha256:mock',
      childRunbookPath: 'child.md',
      contextSnapshot: { vars: {}, ancestors: [] },
      childRunId: 'existing-child-id',
      createdAt: new Date().toISOString(),
      cancelledAt: null,
    };

    const parentState = makeState('parent-id', {
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation,
        },
      ],
    });

    const mockScanner = {
      findByToken: jest
        .fn<any>()
        .mockResolvedValue({ parentState, stepId: '1', substepId: '1', delegation }),
    };
    (core.DelegationScanService as jest.Mock).mockImplementation(() => mockScanner);

    const mockManager = {
      load: jest.fn<any>().mockResolvedValue(parentState),
    };
    (core.RunbookStateManager as jest.Mock).mockImplementation(() => mockManager);

    const mockLock = jest.fn().mockImplementation(() => ({
      acquire: jest.fn<any>().mockResolvedValue(undefined),
      release: jest.fn<any>().mockResolvedValue(undefined),
    }));
    (core.DelegationLock as jest.Mock).mockImplementation(mockLock);

    const ctx = {
      output: {} as any,
      manager: mockManager,
      actorService: {} as any,
      sessionService: {} as any,
      lifecycleService: {} as any,
      cwd: '/test',
    };

    const { claimAndLaunch } = await import('../../src/helpers/runbook-pipeline');
    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx as any, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.childRunId).toBe('existing-child-id');
      expect(result.loopResult).toBe('waiting');
    }
  });

  it('returns error when delegation was cancelled', async () => {
    const delegation = {
      tokenHash: 'sha256:mock',
      childRunbookPath: 'child.md',
      contextSnapshot: { vars: {}, ancestors: [] },
      childRunId: null,
      createdAt: new Date().toISOString(),
      cancelledAt: new Date().toISOString(),
    };

    const parentState = makeState('parent-id', {
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation,
        },
      ],
    });

    const mockScanner = {
      findByToken: jest
        .fn<any>()
        .mockResolvedValue({ parentState, stepId: '1', substepId: '1', delegation }),
    };
    (core.DelegationScanService as jest.Mock).mockImplementation(() => mockScanner);

    const mockManager = {
      load: jest.fn<any>().mockResolvedValue(parentState),
    };
    (core.RunbookStateManager as jest.Mock).mockImplementation(() => mockManager);

    const mockLock = jest.fn().mockImplementation(() => ({
      acquire: jest.fn<any>().mockResolvedValue(undefined),
      release: jest.fn<any>().mockResolvedValue(undefined),
    }));
    (core.DelegationLock as jest.Mock).mockImplementation(mockLock);

    const ctx = {
      output: {} as any,
      manager: mockManager,
      actorService: {} as any,
      sessionService: {} as any,
      lifecycleService: {} as any,
      cwd: '/test',
    };

    const { claimAndLaunch } = await import('../../src/helpers/runbook-pipeline');
    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx as any, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('RD-809');
    }
  });

  it('adopts orphaned child when found', async () => {
    const tokenHash = 'sha256:mock';
    const delegation = {
      tokenHash,
      childRunbookPath: 'child.md',
      contextSnapshot: { vars: {}, ancestors: [] },
      childRunId: null,
      createdAt: new Date().toISOString(),
      cancelledAt: null,
    };

    const parentState = makeState('parent-id', {
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation,
        },
      ],
    });

    const orphanState = makeState('orphan-id', {
      delegation: {
        parentRunId: 'parent-id',
        parentStepId: '1',
        tokenHash,
      },
    });

    const mockScanner = {
      findByToken: jest
        .fn<any>()
        .mockResolvedValue({ parentState, stepId: '1', substepId: '1', delegation }),
      findOrphanedChild: jest.fn<any>().mockResolvedValue(orphanState),
    };
    (core.DelegationScanService as jest.Mock).mockImplementation(() => mockScanner);

    const mockManager = {
      load: jest.fn<any>().mockResolvedValue(parentState),
      update: jest.fn<any>().mockResolvedValue(undefined),
    };
    (core.RunbookStateManager as jest.Mock).mockImplementation(() => mockManager);

    const mockLock = jest.fn().mockImplementation(() => ({
      acquire: jest.fn<any>().mockResolvedValue(undefined),
      release: jest.fn<any>().mockResolvedValue(undefined),
    }));
    (core.DelegationLock as jest.Mock).mockImplementation(mockLock);

    const ctx = {
      output: {} as any,
      manager: mockManager,
      actorService: {} as any,
      sessionService: {} as any,
      lifecycleService: {} as any,
      cwd: '/test',
    };

    const { claimAndLaunch } = await import('../../src/helpers/runbook-pipeline');
    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx as any, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.childRunId).toBe('orphan-id');
    }
    expect(mockManager.update).toHaveBeenCalled();
  });

  it('launches new child when no orphan exists', async () => {
    const tokenHash = 'sha256:mock';
    const delegation = {
      tokenHash,
      childRunbookPath: 'child.md',
      contextSnapshot: { vars: {}, ancestors: [] },
      childRunId: null,
      createdAt: new Date().toISOString(),
      cancelledAt: null,
    };

    const parentState = makeState('parent-id', {
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation,
        },
      ],
    });

    const mockScanner = {
      findByToken: jest
        .fn<any>()
        .mockResolvedValue({ parentState, stepId: '1', substepId: '1', delegation }),
      findOrphanedChild: jest.fn<any>().mockResolvedValue(null),
    };
    (core.DelegationScanService as jest.Mock).mockImplementation(() => mockScanner);

    resolveRunbookFile.mockResolvedValue('/test/child.md');
    (
      core.parseRunbookDocument as jest.MockedFunction<typeof core.parseRunbookDocument>
    ).mockReturnValue({ steps: [makeStep()] } as any);
    (core.reconstituteContextVars as jest.Mock).mockReturnValue({});

    const mockCreate = jest.fn<any>().mockResolvedValue({
      id: 'new-child-id',
      title: 'Child',
    });
    const mockUpdate = jest.fn<any>().mockResolvedValue(undefined);

    const mockManager = {
      load: jest.fn<any>().mockResolvedValue(parentState),
      create: mockCreate,
      update: mockUpdate,
      initializeSubsteps: jest.fn<any>().mockResolvedValue(undefined),
    };
    (core.RunbookStateManager as jest.Mock).mockImplementation(() => mockManager);

    const mockLock = jest.fn().mockImplementation(() => ({
      acquire: jest.fn<any>().mockResolvedValue(undefined),
      release: jest.fn<any>().mockResolvedValue(undefined),
    }));
    (core.DelegationLock as jest.Mock).mockImplementation(mockLock);

    runExecutionLoop.mockResolvedValue('waiting');

    const ctx = {
      output: { status: jest.fn(), flush: jest.fn() } as any,
      manager: mockManager,
      actorService: { initializeState: jest.fn<any>().mockResolvedValue(undefined) } as any,
      sessionService: { pushRunbook: jest.fn<any>().mockResolvedValue(undefined) } as any,
      lifecycleService: makeLifecycle(),
      cwd: '/test',
    };

    const { claimAndLaunch } = await import('../../src/helpers/runbook-pipeline');
    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx as any, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.childRunId).toBe('new-child-id');
      expect(result.loopResult).toBe('waiting');
    }
    expect(mockCreate).toHaveBeenCalledWith(
      'child.md',
      expect.anything(),
      expect.objectContaining({
        delegation: expect.objectContaining({
          parentRunId: 'parent-id',
          tokenHash,
        }),
      }),
    );
  });

  it('returns error when child runbook file not found', async () => {
    const tokenHash = 'sha256:mock';
    const delegation = {
      tokenHash,
      childRunbookPath: 'missing.md',
      contextSnapshot: { vars: {}, ancestors: [] },
      childRunId: null,
      createdAt: new Date().toISOString(),
      cancelledAt: null,
    };

    const parentState = makeState('parent-id', {
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation,
        },
      ],
    });

    const mockScanner = {
      findByToken: jest
        .fn<any>()
        .mockResolvedValue({ parentState, stepId: '1', substepId: '1', delegation }),
      findOrphanedChild: jest.fn<any>().mockResolvedValue(null),
    };
    (core.DelegationScanService as jest.Mock).mockImplementation(() => mockScanner);

    resolveRunbookFile.mockResolvedValue(null); // File not found

    const mockManager = {
      load: jest.fn<any>().mockResolvedValue(parentState),
    };
    (core.RunbookStateManager as jest.Mock).mockImplementation(() => mockManager);
    (core.reconstituteContextVars as jest.Mock).mockReturnValue({});

    const mockLock = jest.fn().mockImplementation(() => ({
      acquire: jest.fn<any>().mockResolvedValue(undefined),
      release: jest.fn<any>().mockResolvedValue(undefined),
    }));
    (core.DelegationLock as jest.Mock).mockImplementation(mockLock);

    const ctx = {
      output: {} as any,
      manager: mockManager,
      actorService: {} as any,
      sessionService: {} as any,
      lifecycleService: {} as any,
      cwd: '/test',
    };

    const { claimAndLaunch } = await import('../../src/helpers/runbook-pipeline');
    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx as any, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('RUNBOOK_NOT_FOUND');
    }
  });

  it('inherits prompted flag from parent', async () => {
    const tokenHash = 'sha256:mock';
    const delegation = {
      tokenHash,
      childRunbookPath: 'child.md',
      contextSnapshot: { vars: {}, ancestors: [] },
      childRunId: null,
      createdAt: new Date().toISOString(),
      cancelledAt: null,
    };

    const parentState = makeState('parent-id', {
      prompted: true,
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation,
        },
      ],
    });

    const mockScanner = {
      findByToken: jest
        .fn<any>()
        .mockResolvedValue({ parentState, stepId: '1', substepId: '1', delegation }),
      findOrphanedChild: jest.fn<any>().mockResolvedValue(null),
    };
    (core.DelegationScanService as jest.Mock).mockImplementation(() => mockScanner);

    resolveRunbookFile.mockResolvedValue('/test/child.md');
    (
      core.parseRunbookDocument as jest.MockedFunction<typeof core.parseRunbookDocument>
    ).mockReturnValue({ steps: [makeStep()] } as any);
    (core.reconstituteContextVars as jest.Mock).mockReturnValue({});

    const mockCreate = jest.fn<any>().mockResolvedValue({
      id: 'child-id',
      title: 'Child',
    });

    const mockManager = {
      load: jest.fn<any>().mockResolvedValue(parentState),
      create: mockCreate,
      update: jest.fn<any>().mockResolvedValue(undefined),
      initializeSubsteps: jest.fn<any>().mockResolvedValue(undefined),
    };
    (core.RunbookStateManager as jest.Mock).mockImplementation(() => mockManager);

    const mockLock = jest.fn().mockImplementation(() => ({
      acquire: jest.fn<any>().mockResolvedValue(undefined),
      release: jest.fn<any>().mockResolvedValue(undefined),
    }));
    (core.DelegationLock as jest.Mock).mockImplementation(mockLock);

    runExecutionLoop.mockResolvedValue('waiting');

    const ctx = {
      output: { status: jest.fn(), flush: jest.fn() } as any,
      manager: mockManager,
      actorService: { initializeState: jest.fn<any>().mockResolvedValue(undefined) } as any,
      sessionService: { pushRunbook: jest.fn<any>().mockResolvedValue(undefined) } as any,
      lifecycleService: makeLifecycle(),
      cwd: '/test',
    };

    const { claimAndLaunch } = await import('../../src/helpers/runbook-pipeline');
    // cspell:disable-next-line
    await claimAndLaunch(ctx as any, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(mockCreate).toHaveBeenCalledWith(
      'child.md',
      expect.anything(),
      expect.objectContaining({
        prompted: true,
      }),
    );
  });
});
